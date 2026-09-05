// src/cli/repl/sseInteractive.ts
// Default interactive CLI for plain `pangu` (no args).
//
// Transport (P0.2): the default path consumes runAgentTask() DIRECTLY in-process.
// No loopback HTTP, no port. The HTTP+SSE server remains available explicitly
// via the `serve` command for remote/browser clients.
//
// UI strategy (Hermes-like):
// - Try the rich Ink UI (fixed top bar + scrolling Feed + ToolCard + Markdown).
//   When active, it owns the terminal and receives events through the bridge.
// - Otherwise fall back to a clean structured line terminal driven by the same
//   event stream ("通道升级"), with prompt restore + Ctrl+C abort.
// - Non-TTY silently downgrades to the classic REPL (smoke tests stay green).

import readline from 'readline';
import { createOutputRenderer } from './OutputRenderer.js';
import { createCliApprovalBridge } from '../../tools/approval.js';
import { Session } from './Session.js';
import * as rollout from './rolloutStore.js';
import { InputQueue, classifyRunningInput, formatSteerInjection } from './InputQueue.js';
import { ModeRing } from './ModeRing.js';
import { AgentTree } from './AgentTree.js';
import type { ModelProvider } from './types.js';

export interface SseInteractiveOptions {
  provider?: ModelProvider;
  defaultTier?: string;
  defaultWorkspace?: string;
  /** resume an existing session instead of starting fresh */
  session?: Session;
}

export async function startSseInteractive(opts: SseInteractiveOptions = {}): Promise<void> {
  const renderer = createOutputRenderer();

  // Check basic TTY capability. If not TTY, fall back to classic immediately.
  const isInteractiveTty =
    process.stdout.isTTY &&
    process.stdin.isTTY;

  if (!isInteractiveTty) {
    // Silent downgrade: use the classic REPL path.
    // B8: carry a restored session (--resume) through the downgrade — the
    // classic fallback must not lose the resume state.
    const { startClassicRepl } = await import('./classicRepl.js');
    return startClassicRepl(opts.session ? { session: opts.session } : {});
  }

  // one shared session for rich + line paths (approval mode/allowlist
  // flow from here into the engine adapter; M2.2 resume seeds it).
  const { applyConfigModel } = await import('./modelSeed.js');
  const session: Session = applyConfigModel(
    opts.session ?? new Session({ workspace: opts.defaultWorkspace, tier: (opts.defaultTier as any) || 'high' }),
    opts.session?.workspace || opts.defaultWorkspace
  ) as Session;
  if (!opts.session) {
    try { rollout.appendMeta(session); } catch {}
  }
  // resumed sessions already carry __resumed marker from repl.ts
  const resumedInfo = (session as any).__resumed as { from: string; turns: number } | undefined;

  // P5-5.2: MCP stdio servers from .panshalach.json mcpServers (append-only config).
  // Clients spawn lazily at first task; closed on process exit (hang discipline).
  const mcpClients = new Map<string, any>();
  let mcpToolsReady: any[] = [];
  let mcpInitDone = false;

  async function initMcpServers(): Promise<void> {
    if (mcpInitDone) return;
    mcpInitDone = true;
    try {
      const { ConfigManager } = await import('./ConfigManager.js');
      const cfg: any = (new ConfigManager(session.workspace || process.cwd())).getAll?.() ?? {};
      const servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> =
        (cfg as any).mcpServers || {};
      const { McpClient } = await import('../../tools/mcpClient.js');
      for (const [name, s] of Object.entries(servers)) {
        if (!s?.command) continue;
        try {
          const client = new McpClient({ command: s.command, args: s.args || [], env: s.env });
          await client.initialize();
          const tools = await client.listTools();
          mcpClients.set(name, client);
          for (const t of tools) {
            mcpToolsReady.push({
              server: name,
              name: `mcp_${name}_${t.name}`,
              description: t.description || '',
              call: (args: Record<string, unknown>) => client.callTool(t.name, args),
            });
          }
        } catch {
          // failed server → skip (tools simply unavailable), never crash startup
        }
      }
    } catch {
      // config missing / unreadable → no MCP
    }
  }

  process.once('exit', () => {
    for (const c of mcpClients.values()) { try { c.close(); } catch {} }
  });

  // Nominal context window for the top-bar meter (heuristic chars/4 estimate).
  const CTX_WINDOW_TOKENS = Number(process.env.PANSHA_CTX_WINDOW || 128000);
  let ctxUsedChars = 0;
  function bumpCtx(text: any) {
    if (typeof text === 'string') ctxUsedChars += text.length;
  }

  // Holders for line-mode prompt restore (populated only in the !rich line fallback path).
  // The unified runTaskViaSse (defined below) references these in its !bridge finally to restore the prompt.
  let lineRl: readline.Interface | null = null;
  let lineSetPrompt: () => void = () => {};

  // For /edit (P1 high-value): remember last meaningful surfaced content (result text, big markdown/thought)
  // so user can pull it back into the input area to edit/resubmit or refine.
  let lastOutput = '';
  function recordOutput(text: string) {
    if (text && text.trim()) lastOutput = text.trim();
  }
  function getLastOutput() { return lastOutput; }

  // Abort flag for the current task (used by runTaskViaSse + SIGINT in line mode)
  let currentAbort: AbortController | null = null;
  const isRunning = () => currentAbort !== null;

  // P4-4.2/4.3: queued messages + steering inbox
  const queue = new InputQueue();
  let lastInjectedSteers: string[] = [];
  let lastAborted = false;
  // P3-3.7: in-flight background compaction (cancelled on session exit)
  let bgCompact: { isReady(): boolean; result(): any; cancel(): void } | null = null;
  process.once('exit', () => { if (bgCompact) { try { bgCompact.cancel(); } catch {} } });

  // P5-5.3: sub-agent rollout tree (fed by onEvent step/critique rolloutId).
  // Engine runs rollouts SERIALLY → honest serial progress list.
  const agentTree = new AgentTree();
  let treeTaskStart = 0;
  function updateQueueCount() {
    if (typeof (bridgeRef as any).current?.setQueueCount === 'function') {
      try { bridgeRef.current.setQueueCount(queue.size, queue.taskCount, queue.steerCount); } catch {}
    }
  }

  // P4-4.7: mode ring — shift+tab cycles; plan floors approval to readonly,
  // leaving plan restores the ring-mapped approval mode.
  const modeRing = new ModeRing('default', (m) => {
    if (m === 'plan') {
      session.setPlanMode(true);
    } else {
      session.planMode = false;
      session.approvalMode = m === 'auto-accept' ? 'full' : m === 'full' ? 'full' : 'default';
    }
    try { rollout.appendApprovalChange(session); } catch {}
    emitFeed(`模式: ${m}${m === 'plan' ? '（只读+方案；写/bash 拒绝）' : m === 'auto-accept' ? '（写免确认，danger 仍红标）' : m === 'full' ? '（全放行，danger 仍红标）' : ''}`, 'info');
  });
  function cycleMode(): string {
    const m = modeRing.cycle();
    if (typeof (bridgeRef as any).current?.setTop === 'function') {
      try { bridgeRef.current.setTop({ modeBadge: m === 'plan' ? 'PLAN' : m === 'auto-accept' ? 'AUTO' : m === 'full' ? 'FULL' : '' }); } catch {}
    }
    return m;
  }
  function setMode(m: any) {
    modeRing.set(m);
    cycleMode(); // sync badge (no-op if unchanged? set+badge sync is harmless)
  }
  function emitFeed(text: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') {
    if (typeof (bridgeRef as any).current?.pushFeed === 'function') {
      try { bridgeRef.current.pushFeed({ type: 'text', text, level }); } catch {}
    } else {
      renderer.writeLine(renderer.color(text, level === 'warn' ? 'yellow' : level === 'error' ? 'red' : 'gray'));
    }
  }

  // dogfood-T4: unified synchronous compaction — client resolution, success/
  // failure feedback and TopBar meter reset live HERE (was duplicated at
  // /compact and the critical sync-fallback).
  async function runSyncCompact(reasonPrefix = ''): Promise<any> {
    const { compactSession, estimateSessionTokens } = await import('./compactService.js');
    const { resolveSharedClient } = await import('../../cli/repl/ModelProvider.js');
    const rich = !!bridge; // same semantics as runTaskViaSse's useRich
    let client: any = null;
    try { client = (await resolveSharedClient(session.model, opts.provider as any)).client; } catch {}
    const r = await compactSession(session, client);
    if (r.ok) {
      ctxUsedChars = estimateSessionTokens(session) * 4;
      const msg = reasonPrefix + r.message;
      if (rich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: msg, level: reasonPrefix ? 'warn' : 'success' });
      else if (reasonPrefix) renderer.warn(msg);
      else renderer.success(msg);
      if (rich && typeof bridge.setTop === 'function') {
        const nr = Math.min(1, (ctxUsedChars / 4) / CTX_WINDOW_TOKENS);
        try { bridge.setTop({ ctxRatio: nr }); } catch {}
      }
    } else {
      if (rich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: r.message, level: 'warn' });
      else renderer.warn(r.message);
    }
    return r;
  }

  /**
   * P4-4.2/4.3: route a user line according to running state.
   * - idle:   normal task flow
   * - running: '/' → immediate local command; '!' → steer; else → queued task
   */
  async function handleUserLine(text: string, bridge?: any) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    if (!isRunning()) {
      await runTaskViaSse(trimmed, bridge);
      return;
    }

    const routed = classifyRunningInput(trimmed);
    if (routed.kind === 'command') {
      // slash commands execute immediately, never queued
      await runTaskViaSse(routed.payload, bridge);
      return;
    }
    if (routed.kind === 'steer') {
      if (!routed.payload) return;
      queue.enqueueSteer(routed.payload);
      emitFeed(`steered ×${queue.steerCount}（下一轮注入）：${routed.payload}`, 'info');
    } else {
      queue.enqueueTask(routed.payload);
      emitFeed(`queued ×${queue.taskCount}：${routed.payload}`, 'info');
    }
    updateQueueCount();
  }

  async function runTaskViaSse(task: string, bridge?: any) {
    if (!task || !task.trim()) return;

    const trimmed = task.trim();
    const useRich = !!bridge;

    // Unified /edit (P1): pull last significant output back into input for edit/resubmit.
    if (trimmed === '/edit' || trimmed === '/e') {
      const prev = getLastOutput();
      if (!prev) {
        if (!useRich) renderer.warn('暂无上次输出可编辑');
        else if (typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: '暂无上次输出可编辑', level: 'warn' });
        return;
      }
      if (useRich) {
        try {
          if (typeof bridge.updateInput === 'function') bridge.updateInput(prev);
          if (typeof bridge.pushFeed === 'function') {
            bridge.pushFeed({ type: 'text', text: '(已载入上次输出到输入区，可编辑后提交)', level: 'info' });
          }
        } catch {}
      } else {
        // Line mode prefill
        try {
          if (lineRl) {
            (lineRl as any).line = prev;
            (lineRl as any).cursor = prev.length;
            if (typeof (lineRl as any)._refreshLine === 'function') (lineRl as any)._refreshLine();
            renderer.writeLine(renderer.color('(已载入上次输出，可编辑后回车提交)', 'gray'));
          } else {
            renderer.writeLine('--- 上次输出 ---');
            renderer.writeLine(prev);
          }
        } catch {
          renderer.writeLine('--- 上次输出 ---');
          renderer.writeLine(prev);
        }
      }
      return;
    }

    // M2.1/local commands shared by rich + line paths
    // (/undo now; /approvals + /usage + /compact land with their batches)
    if (trimmed.startsWith('/')) {
      const sp = trimmed.indexOf(' ');
      const cmd = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
      const arg = sp === -1 ? '' : trimmed.slice(sp + 1).trim();

      const emit = (text: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') => {
        if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text, level });
        else if (level === 'warn') renderer.warn(text);
        else if (level === 'error') renderer.error(text);
        else if (level === 'success') renderer.success(text);
        else renderer.writeLine(text);
      };

      if (cmd === '/agents') {
        // P5-5.3: sub-agent rollout tree (serial progress list — honest)
        const nodes = agentTree.snapshot();
        const feedOrLine = (text: string, color?: 'bold' | 'gray') => {
          if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text, level: 'info' });
          else renderer.writeLine(color ? renderer.color(text, color) : text);
        };
        if (arg) {
          const n = agentTree.get(arg.trim());
          if (!n) { feedOrLine(`未找到 rollout: ${arg}`); return; }
          feedOrLine(`rollout ${n.id}（${n.status}）`, 'bold');
          feedOrLine(`  步数: ${n.stepCount} · 耗时: ${(n.durationMs / 1000).toFixed(1)}s · 最近阶段: ${n.lastPhase ?? '-'}`);
          return;
        }
        if (nodes.length === 0) { feedOrLine('尚无 rollout 数据（跑一个任务后出现）'); return; }
        const done = nodes.filter((n) => n.status === 'done').length;
        const running = nodes.filter((n) => n.status === 'running').length;
        const failed = nodes.filter((n) => n.status === 'failed').length;
        const pending = nodes.filter((n) => n.status === 'pending').length;
        const totalMs = nodes.reduce((a, n) => a + n.durationMs, 0);
        feedOrLine(`${nodes.length} rollouts · ${done} done · ${running} running · ${pending} pending · ${failed} failed · 总耗时 ${(totalMs / 1000).toFixed(1)}s`, 'bold');
        for (const n of nodes) {
          const glyph = n.status === 'running' ? '▶' : n.status === 'done' ? '✓' : n.status === 'failed' ? '✗' : '·';
          const dur = n.durationMs >= 1000 ? `${(n.durationMs / 1000).toFixed(1)}s` : `${n.durationMs}ms`;
          feedOrLine(`  ${glyph} ${n.id} · ${n.status} · ${n.stepCount} 步 · ${dur}${n.lastPhase ? ` · ${n.lastPhase}` : ''}`);
        }
        // graph edges (dep/rollback/approval) annotated
        try {
          const edges = agentTree.edges();
          if (edges.length > 0) {
            feedOrLine('边:', 'gray');
            for (const e of edges) feedOrLine(`  ${e.from} --[${e.kind}]--> ${e.to}`, 'gray');
          }
        } catch {}
        // D-parallel: high+ tiers run rollouts concurrently — the tree renders
        // a REAL parallel tree (multiple running nodes coexist).
        feedOrLine('（high+ 档并行 rollout：Promise.allSettled + 写互斥 + 预算聚合）', 'gray');
        return;
      }

      if (cmd === '/rewind') {
        // P3-3.6: turn-level rewind lives in the classic command set
        // (registered RewindCommand); rich-mode panel wiring is deferred.
        return false;
      }

      if (cmd === '/mode') {
        // P4-4.7: hidden alias for keyboard-less environments (also the
        // testable entry point of ModeRing).
        const a = arg.toLowerCase();
        if (['plan', 'default', 'auto-accept', 'full'].includes(a)) {
          setMode(a);
        } else {
          cycleMode();
        }
        return;
      }

      if (cmd === '/undo') {
        const { undoLatest } = await import('../../tools/fileHistory.js');
        const r = undoLatest(session.workspace || process.cwd(), arg || undefined);
        emit(r.message, r.ok ? 'success' : 'warn');
        if (r.ok && r.diff && r.diff.length > 0) {
          for (const h of r.diff.slice(0, 40)) {
            const line = `${h.type === 'add' ? '+' : h.type === 'del' ? '−' : ' '} ${h.text}`;
            emit(line, h.type === 'add' ? 'success' : h.type === 'del' ? 'error' : 'info');
          }
          if (r.diff.length > 40) emit(`… ${r.diff.length - 40} 行省略 …`, 'info');
        }
        return;
      }

      if (cmd === '/approvals') {
        const a = arg.toLowerCase();
        if (a === 'clear') {
          session.clearApprovalAllowlist();
          emit('本会话放行清单已清空。', 'success');
        } else if (['readonly', 'default', 'full'].includes(a)) {
          session.updateApprovalMode(a as any);
          emit(`审批模式已切换为 ${a}。`, 'success');
        } else {
          emit(`审批模式: ${session.approvalMode}；放行清单: ${[...session.sessionApprovalAllowlist].join(', ') || '(空)'}`, 'info');
          emit('用法: /approvals readonly|default|full|clear', 'info');
        }
        try { rollout.appendApprovalChange(session); } catch {}
        return;
      }

      if (cmd === '/usage') {
        const { collectUsage, loadPricesFromConfig } = await import('./usageService.js');
        const prices = await loadPricesFromConfig(session.workspace || process.cwd());
        const r = collectUsage(session, prices);
        for (const line of r.lines) emit(line, 'info');
        return;
      }

      if (cmd === '/compact') {
        // dogfood-T4: unified via runSyncCompact (client resolve + feedback + meter)
        const r = await runSyncCompact();
        if (r.ok) {
          const preview = r.summary.length > 300 ? r.summary.slice(0, 300) + '…' : r.summary;
          emit('摘要预览: ' + preview, 'info');
        }
        return;
      }

      if (cmd === '/model') {
        // fix (user-facing): /model must be handled LOCALLY, not fall through
        // to the engine as a coding task (that produced the confusing
        // "No model client available" error).
        const sub = arg.trim();
        if (!sub || sub === 'list' || sub === 'ls') {
          emit(`当前模型: ${session.model}`, 'info');
          try {
            const { createDefaultModelProvider } = await import('../../cli/repl/ModelProvider.js');
            const p = opts.provider as any ?? createDefaultModelProvider();
            const names = (typeof p.listModels === 'function' ? p.listModels() : []).join(', ');
            emit(`已注册/可用入口: ${names}`, 'info');
            if (sub === 'list' || sub === 'ls') {
              // remote model list for the CURRENT provider (best-effort)
              const { resolveSharedClient } = await import('../../cli/repl/ModelProvider.js');
              try {
                const { provider: pr } = await resolveSharedClient(session.model, opts.provider as any);
                const remote = await pr.listProviderModels?.(session.model.includes(':') ? session.model.split(':')[0] : 'scnet');
                if (remote && remote.length) emit(`远程模型(${session.model.split(':')[0] || 'scnet'}): ${remote.slice(0, 30).join(', ')}`, 'info');
              } catch {}
            }
          } catch {}
          return;
        }
        // /model <name> → switch session.model (validated on next task)
        session.model = sub;
        emit(`模型已切换: ${sub}（下次任务生效）`, 'success');
        return;
      }

      // fix-rich-local-cmds (①): rich mode slash commands MUST resolve
      // locally — /help /status /clear /tier and any unknown slash command are
      // handled here; a slash-prefixed line is NEVER submitted to the engine
      // as a coding task (iron rule).
      if (cmd === '/help') {
        emit('命令: /help /status /clear /tier /model /edit /undo /approvals /usage /compact /rewind /agents /mode /resume | 斜杠命令均本地执行，不进引擎', 'info');
        return;
      }
      if (cmd === '/clear') {
        if (useRich && typeof bridge.clearScreen === 'function') { try { bridge.clearScreen(); } catch {} }
        else renderer.clearScreen();
        return;
      }
      if (cmd === '/tier' || cmd === '/t') {
        const t = arg.trim().toLowerCase();
        const TIERS = ['quick', 'standard', 'high', 'max', 'ex', 'pangu'];
        if (t && TIERS.includes(t)) {
          session.tier = t as any;
          emit(`档位已切换: ${t}（下次任务生效）`, 'success');
        } else {
          emit(`当前档位: ${session.tier}；可用: ${TIERS.join(', ')}`, 'info');
        }
        return;
      }
      if (cmd === '/status') {
        const pct = Math.min(100, Math.floor((ctxUsedChars / 4 / CTX_WINDOW_TOKENS) * 100));
        emit(`模式 ${session.approvalMode} · 档位 ${session.tier} · 模型 ${session.model} · 上下文 ~${pct}% · 队列 ${queue.taskCount} 任务 / ${queue.steerCount} 插话`, 'info');
        return;
      }
      if (cmd === '/tree') {
        // session tree (origin + branch nodes); /tree <id> → resume path
        try {
          const { listSessionTree, renderSessionTree } = await import('./rolloutStore.js');
          const current = (session as any).sessionId || '';
          const target = arg.trim() || current;
          const tree = listSessionTree(target);
          emit('会话树:', 'info');
          for (const line of renderSessionTree(tree, current)) emit('  ' + line, 'info');
          if (arg.trim() && arg.trim() !== current) emit(`切到节点 ${arg.trim()} 续写: /resume ${arg.trim()}`, 'success');
          else emit('分支: /rewind 创建；节点续写: /tree <id> 后 /resume <id>', 'info');
        } catch (e: any) {
          emit('会话树读取失败: ' + (e?.message || e), 'error');
        }
        return;
      }
      if (cmd === '/feature') {
        // /feature list|add|done|next (rich-local mirror of FeatureCommand)
        const { loadFeatures, activeFeature, addFeature, markFeatureDone, setFeatureNext } = await import('./FeatureTracker.js');
        const ws = session.workspace || process.cwd();
        const sub = (arg.split(/\s+/)[0] || 'list').toLowerCase();
        const rest = arg.split(/\s+/).slice(1);
        if (sub === 'list' || sub === 'ls') {
          const items = loadFeatures(ws);
          if (items.length === 0) { emit('特性列表为空（/feature add <标题> 开始）', 'info'); return; }
          for (const f of items) {
            const mark = f.status === 'in-progress' ? '▶' : f.status === 'done' ? '✓' : f.status === 'blocked' ? '✗' : '·';
            emit(`  ${mark} ${f.id} ${f.title} [${f.status}]${f.evidence ? ' · ✓ ' + f.evidence : ''}`, 'info');
          }
          return;
        }
        if (sub === 'add') {
          const title = rest.join(' ').trim();
          const item = title ? addFeature(ws, title) : null;
          emit(item ? `已添加并激活: ${item.id} ${item.title}` : '用法: /feature add <标题>', item ? 'success' : 'warn');
          return;
        }
        if (sub === 'done') {
          const err = markFeatureDone(ws, rest[0] || '', rest.slice(1).join(' ').trim());
          emit(err ?? `已标记 done: ${rest[0]}`, err ? 'warn' : 'success');
          return;
        }
        if (sub === 'next') {
          const err = setFeatureNext(ws, rest[0] || '', rest.slice(1).join(' ').trim());
          emit(err ?? `已设为 active: ${rest[0]}`, err ? 'warn' : 'success');
          return;
        }
        emit('用法: /feature list|add <标题>|done <id> <证据>|next <id>', 'warn');
        return;
      }
      if (cmd === '/init') {
        // rich-local /init — probe workspace + write
        // .panshalach/AGENTS.md + feature_list.json. B-dual: reuses the SAME
        // probe/build logic as the registry InitCommand (the old inline
        // simplified copy diverged in output — now unified).
        try {
          const { probeWorkspace, buildAgentsMd } = await import('./commands/InitCommand.js');
          const fs = await import('node:fs');
          const path = await import('node:path');
          const ws = session.workspace || process.cwd();
          const probe = probeWorkspace(ws);
          const agents = buildAgentsMd(ws, probe);
          const agentsPath = path.join(ws, '.panshalach', 'AGENTS.md');
          const existed = fs.existsSync(agentsPath);
          if (existed && arg !== '--force' && arg !== '-f') { emit('AGENTS.md 已存在（/init --force 覆盖）', 'warn'); return; }
          fs.mkdirSync(path.join(ws, '.panshalach'), { recursive: true });
          fs.writeFileSync(agentsPath, agents, 'utf-8');
          const { saveFeatures, featureListPath } = await import('./FeatureTracker.js');
          if (!fs.existsSync(featureListPath(ws))) saveFeatures(ws, []);
          const cmds = [probe.buildCmd, probe.testCmd, probe.lintCmd].filter(Boolean).join(' | ') || '未探测到';
          emit(`已生成 ${agentsPath}（验证命令: ${cmds}）`, 'success');
        } catch (e: any) {
          emit('初始化失败: ' + (e?.message || e), 'error');
        }
        return;
      }

      // iron rule: unknown slash commands never reach the engine
      emit(`未知命令: ${cmd}（输入 /help 查看可用命令；斜杠命令均本地执行）`, 'warn');
      return;
    }

    // P3-3.7: auto-compact pre-flight (CC-style) — background-first, applied at
    // task boundary, never blocks input. Sync fallback only when critical.
    {
      const ratioNow = Math.min(1, (ctxUsedChars / 4) / CTX_WINDOW_TOKENS);
      const cs = await import('./compactService.js');
      if (cs.shouldAutoCompact(session, ratioNow)) {
        const { resolveSharedClient } = await import('../../cli/repl/ModelProvider.js');
        let client: any = null;
        try { client = (await resolveSharedClient(session.model, opts.provider as any)).client; } catch {}

        // A ready background result → apply with zero wait
        if (bgCompact && bgCompact.isReady()) {
          const res = bgCompact.result();
          bgCompact = null;
          if (res && res.ok) {
            const applied = cs.applyCompactResult(session, res);
            ctxUsedChars = cs.estimateSessionTokens(session) * 4;
            const msg = `${applied.message}`;
            if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: msg, level: 'info' });
            else renderer.info(msg);
            if (useRich && typeof bridge.setTop === 'function') {
              const nr = Math.min(1, (ctxUsedChars / 4) / CTX_WINDOW_TOKENS);
              try { bridge.setTop({ ctxRatio: nr }); } catch {}
            }
          }
        } else if (!bgCompact) {
          // Nothing running yet → kick off a background compaction (non-blocking).
          const h = cs.startBackgroundCompact(session, client);
          if (h) {
            bgCompact = h;
            emitFeed('⏳ 已在后台预压缩历史（阈值为 ≥85% 上下文）……', 'warn');
          } else if (ratioNow >= 0.95) {
            // Critical: stream is about to blow up — do a sync fallback.
            // dogfood-T4: unified via runSyncCompact (feedback + meter reset)
            await runSyncCompact('⏳ auto-compact 同步兜底：');
          }
        }
      }
    }

    // P4-4.3: steering injection — unconsumed steers join THIS round's prompt,
    // then are consumed immediately (injected ones cannot be recalled).
    const pendingSteers = queue.consumeSteers();
    if (pendingSteers.length > 0) {
      task = task + formatSteerInjection(pendingSteers);
      lastInjectedSteers = pendingSteers;
      emitFeed(`本轮已注入 ${pendingSteers.length} 条插话`, 'info');
      updateQueueCount();
    }

    if (!useRich) {
      renderer.writeLine(renderer.color(`\n[提交任务] ${task.split('\n\n【用户插话')[0]}`, 'cyan'));
    } else if (typeof bridge.setRunning === 'function') {
      try { bridge.setRunning(true); } catch {}
    }

    // Abort support: the engine cannot be hard-killed mid-step today, so we
    // race the run against an abort promise (same pattern as Repl.ts). Once
    // aborted, late events are dropped and the prompt returns immediately.
    const controller = new AbortController();
    currentAbort = controller;
    lastAborted = false;
    let abortReject: ((reason?: any) => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => { abortReject = reject; });

    const startedAt = Date.now();
    // P4-4.9: gerund interval handle (declared here so the finally can clear it)
    let gerundTimer: NodeJS.Timeout | null = null;
    // P5-5.3: new task boundary — settle previous rollouts, start a fresh clock
    agentTree.markAll('running', 'done');
    treeTaskStart = startedAt;

    try {
      // P5-5.2: ensure MCP servers are initialized (lazy, once) before the run
      await initMcpServers();
      const { runAgentTask } = await import('../../server/runAgentTask.js');

      // real approval bridges.
      // - rich path → bridge.setConfirm(request) → ConfirmBar (y/n/a/Esc)
      // - line path → readline question bridge (60s silence → n)
      const approvalBridge = useRich
        ? (req: { tool: string; description: string; danger: boolean }) =>
            (bridgeRef.current.setConfirm(req) as Promise<'y' | 'n' | 'a'>)
        : createCliApprovalBridge();

      // Line mode: pause the main prompt so the approval question owns stdin.
      if (!useRich && lineRl) { try { lineRl.pause(); } catch {} }

      // P4-4.9: gerund running label — line-mode inline updates every 4s.
      // Timer unref'd (M2.0 discipline: non-deadline timers must not hold the
      // process) and always cleared in the finally below.
      if (!useRich) {
        try {
          const { nextGerund, formatRunningLabel } = await import('./GerundSpinner.js');
          const gStart = startedAt;
          const paint = () => {
            try { process.stdout.write('\r' + formatRunningLabel(Date.now() - gStart, nextGerund()) + '   '); } catch {}
          };
          paint();
          gerundTimer = setInterval(paint, 4000);
          gerundTimer.unref();
        } catch {}
      }

      const runPromise = runAgentTask(
        {
          task,
          // B2: the task must run against the LIVE session state — /tier and
          // /workspace switches take effect immediately, and the session's
          // turns feed "最近 N 轮上下文" on the default path.
          tier: session.tier,
          workspace: session.workspace,
          model: session.model,
          simulate: false,
          session,
        },
        {
          provider: opts.provider,
          signal: controller.signal,
          approvalMode: session.approvalMode,
          sessionAllowlist: session.sessionApprovalAllowlist,
          approvalBridge,
          planMode: session.planMode,
          mcpTools: mcpToolsReady,
          onEvent: (ev: any) => {
            if (controller.signal.aborted) return;

            // P5-5.3: feed the agent tree from rolloutId-carrying events
            if (ev && (ev.type === 'step' || ev.type === 'critique') && ev.rolloutId) {
              agentTree.upsert({
                id: String(ev.rolloutId),
                parent: null,
                status: 'running',
                stepCount: Number(ev.stepNumber ?? 1),
                durationMs: treeTaskStart ? Date.now() - treeTaskStart : 0,
                lastPhase: ev.type,
              });
            }

            // heuristic context meter (chars/4) from reasoning/plan/result/critique
            if (ev && ev.type === 'step') {
              bumpCtx(ev.thinking); bumpCtx(ev.plan);
              bumpCtx(typeof ev.result === 'string' ? ev.result : '');
              if (Array.isArray(ev.toolCalls)) {
                for (const tc of ev.toolCalls) {
                  bumpCtx(tc?.rawBlock); bumpCtx(tc?.argsSummary);
                }
              }
              if (useRich && typeof bridge.setTop === 'function') {
                const ratio = Math.min(1, (ctxUsedChars / 4) / CTX_WINDOW_TOKENS);
                try { bridge.setTop({ ctxRatio: ratio }); } catch {}
              }
            } else if (ev && ev.type === 'critique') {
              bumpCtx(ev.critique);
            }

            if (useRich) {
              mapSseToBridge(ev.type || 'event', ev, bridge);
            } else {
              renderSseEvent(ev.type || 'event', ev, renderer);
            }
          },
        }
      );

      const raced = await Promise.race([
        runPromise.then((r) => ({ kind: 'done' as const, result: r })),
        abortPromise.then(() => ({ kind: 'aborted' as const })).catch(() => ({ kind: 'aborted' as const })),
      ]);

      if (raced.kind === 'aborted') {
        try { controller.abort(); } catch {}
        // B3: mark this turn as aborted so the queue-drain loop below does NOT
        // auto-execute the remaining queued tasks (the user keeps them to
        // rerun deliberately; previously lastAborted was never set → aborted
        // turns still drained and ran queued tasks automatically).
        lastAborted = true;
        // P4-4.2 abort semantics: unconsumed steers are dropped (injected ones
        // cannot be recalled); queued TASKS are kept for the user to rerun.
        const droppedSteers = queue.consumeSteers();
        updateQueueCount();
        const tail = droppedSteers.length > 0 ? `（${droppedSteers.length} 条未注入插话已丢弃；排队任务保留）` : '';
        if (!useRich) renderer.warn('任务已被中断' + tail);
        else if (typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: '任务已被中断' + tail, level: 'warn' });
      } else {
        // persist the completed turn into the session + rollout jsonl
        // P5-5.3: this task's rollouts are done
        agentTree.markAll('running', 'done');
        const r = raced.result;
        const turn = {
          id: Date.now().toString(36),
          timestamp: Date.now(),
          userInput: task.split('\n\n【用户插话')[0],
          userInputType: 'task' as const,
          tier: session.tier,
          durationMs: r?.durationMs ?? (Date.now() - startedAt),
          result: {
            success: !!r?.success,
            summary: r?.success ? "已通过验证" : "未通过验证",
            budgetReport: r?.budgetReport as any,
          },
        };
        try { session.addTurn(turn); } catch {}
        try { rollout.appendTurn(session.id, turn as any); } catch {}
        recordOutput(r?.success ? "完成（已通过验证）" : "任务未通过验证");
      }
    } catch (err: any) {
      const msg = '任务执行失败: ' + (err?.message || err);
      if (!useRich) renderer.error(msg);
      else if (typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: msg, level: 'error' });
    } finally {
      currentAbort = null;
      void startedAt;
      if (gerundTimer) { try { clearInterval(gerundTimer); } catch {} try { process.stdout.write('\r' + ' '.repeat(80) + '\r'); } catch {} }
      gerundTimer = null;
      if (useRich && typeof bridge.setRunning === 'function') {
        try { bridge.setRunning(false); } catch {}
      } else {
        // Line path: restore prompt so the user can type the next task.
        if (lineRl) { try { lineRl.resume(); } catch {} }
        try { lineSetPrompt(); } catch {}
        if (lineRl) { try { lineRl.prompt(); } catch {} }
      }
    }

    // P4-4.2: drain queued tasks once the turn settles (FIFO, one by one).
    // An aborted turn stops the drain — the user keeps the remaining queue.
    while (queue.taskCount > 0 && !lastAborted) {
      const next = queue.drainTasks();
      updateQueueCount();
      for (const t of next) {
        if (lastAborted) break;
        emitFeed(`▶ 执行排队任务：${t.slice(0, 80)}`, 'info');
        await runTaskViaSse(t, bridge);
      }
    }
  }

  // Map normalized SSE events (from agentServer) to the rich bridge (Ink UI).
  function mapSseToBridge(event: string, data: any, b: any) {
    if (!b) return;
    const t = (data && data.type) || event;

    if (t === 'start' || event === 'start') {
      if (typeof b.setRunning === 'function') { try { b.setRunning(true); } catch {} }
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'text', text: `开始执行: ${data.task || ''}`, level: 'info' });
      return;
    }
    if (t === 'phase' || event === 'phase') {
      const ph = data.phase || data;
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'phase', phase: ph });
      if (typeof b.setTop === 'function') b.setTop({ phase: ph });
      return;
    }
    if (t === 'thinking.start' || event === 'thinking.start') {
      // New thinking segment: clear only the thinking buffer (P1.4)
      if (typeof b.resetStream === 'function') { try { b.resetStream('thinking'); } catch {} }
      return;
    }
    if (t === 'message.start' || event === 'message.start') {
      // New message segment: clear only the message buffer (💭 stays visible)
      if (typeof b.resetStream === 'function') { try { b.resetStream('message'); } catch {} }
      return;
    }
    if (t === 'thinking.delta' || event === 'thinking.delta') {
      if (typeof b.appendStream === 'function') b.appendStream('thinking', data.text || '');
      return;
    }
    if (t === 'message.delta' || event === 'message.delta') {
      if (typeof b.appendStream === 'function') b.appendStream('message', data.text || '');
      return;
    }
    if (t === 'step' || event === 'step') {
      // Turn segment settled → clear live zone before the step card lands
      if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
      if (typeof b.pushStep === 'function') b.pushStep(data);
      if (Array.isArray(data.toolCalls) && typeof b.pushTool === 'function') {
        for (const tc of data.toolCalls) b.pushTool(tc);
      }
      return;
    }
    if (t === 'critique' || event === 'critique') {
      if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
      if (typeof b.pushCritique === 'function') b.pushCritique(data);
      return;
    }
    if (t === 'tool' || event === 'tool') {
      if (typeof b.pushTool === 'function') b.pushTool(data);
      return;
    }
    if (t === 'budget' || t === 'softLimit' || event === 'budget' || event === 'softLimit') {
      const ratio = typeof data.usedRatio === 'number' ? data.usedRatio : (typeof data.ratio === 'number' ? data.ratio : 0);
      if (typeof b.pushBudget === 'function') b.pushBudget(ratio);
      return;
    }
    if (t === 'degradation' || event === 'degradation') {
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'text', text: `⚠ 行为降级: ${data.reason || 'soft-limit'}`, level: 'warn' });
      return;
    }
    if (t === 'markdown' || event === 'markdown') {
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'markdown', content: data.content || '' });
      return;
    }
    if (t === 'thought' || event === 'thought') {
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'thought', short: data.short || '', full: data.full || data.thinking || '' });
      return;
    }
    if (t === 'progress' || event === 'progress') {
      // lightweight; surface as phase hint if numeric step present
      if (typeof data.step === 'number' || typeof data.stepNumber === 'number') {
        const n = data.step ?? data.stepNumber;
        if (typeof b.setTop === 'function') { try { b.setTop({ phase: `step ${n}` }); } catch {} }
      }
      return;
    }
    if (t === 'result' || event === 'result') {
      if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'text', text: data.success ? '完成（已通过验证）' : '任务未通过验证', level: data.success ? 'success' : 'warn' });
      if (data && data.budgetReport && typeof data.budgetReport.usageRatio === 'number') {
        if (typeof b.pushBudget === 'function') b.pushBudget(data.budgetReport.usageRatio);
      }
      if (typeof b.setRunning === 'function') { try { b.setRunning(false); } catch {} }
      return;
    }
    if (t === 'done' || event === 'done') {
      if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
      if (data && data.durationMs && typeof b.pushFeed === 'function') {
        // P1.5b: "Cooked for" style tail note (CC-inspired)
        b.pushFeed({ type: 'text', text: `⏱ 用时 ${(data.durationMs / 1000).toFixed(1)}s`, level: 'info' });
      }
      if (typeof b.setRunning === 'function') { try { b.setRunning(false); } catch {} }
      return;
    }
    if (t === 'error' || event === 'error') {
      if (typeof b.resetStream === 'function') { try { b.resetStream(); } catch {} }
      const msg = data && (data.message || JSON.stringify(data));
      if (typeof b.pushFeed === 'function') b.pushFeed({ type: 'text', text: '错误: ' + msg, level: 'error' });
      if (typeof b.setRunning === 'function') { try { b.setRunning(false); } catch {} }
      return;
    }
    // Fallback generic
    if (typeof b.pushFeed === 'function') {
      if (data && typeof data === 'object' && data.type) b.pushFeed(data);
      else b.pushFeed({ type: 'text', text: JSON.stringify(data), level: 'info' });
    }
  }

  // Line-mode renderer for SSE events (used when rich UI is not active).
  function renderSseEvent(event: string, data: any, r: ReturnType<typeof createOutputRenderer>) {
    // v2 streaming deltas are display-only for the rich UI; the line
    // terminal keeps its clean step-granular output and ignores them.
    if (event === 'thinking.start' || event === 'message.start' ||
        event === 'thinking.delta' || event === 'message.delta') {
      return;
    }
    switch (event) {
      case 'start':
        r.writeLine(r.color(`开始执行: ${data.task || ''}`, 'cyan'));
        break;
      case 'phase':
        r.writeLine(r.color(`── ${data.phase || data} ──`, 'gray'));
        break;
      case 'step': {
        const msg = `[Step ${data.stepNumber}] ${data.thinking || data.plan || ''}`;
        r.writeLine(r.color(msg, 'white'));
        if (Array.isArray(data.toolCalls) && data.toolCalls.length) {
          for (const tc of data.toolCalls) {
            r.writeLine(r.color(`  ↳ 工具: ${tc.name || tc.tool || 'tool'} ${tc.path || tc.target || ''}`, 'magenta'));
          }
        }
        break;
      }
      case 'critique':
        r.writeLine(r.color('Critique: ' + (data.critique || data), 'yellow'));
        break;
      case 'tool':
        r.writeLine(r.color(`⚙ ${data.tool || ''} ${data.target || ''} [${data.status || ''}]`, 'cyan'));
        if (data.result) {
          const preview = String(data.result).slice(0, 200);
          r.writeLine(r.color('   ' + preview, 'gray'));
        }
        break;
      case 'budget':
      case 'softLimit':
        const pct = Math.floor(((data.usedRatio || 0) * 100));
        const color = pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green';
        r.writeLine(r.color(`[预算 ${pct}%]`, color));
        break;
      case 'degradation':
        r.writeLine(r.color(`⚠ 行为降级: ${data.reason || 'soft-limit'}`, 'yellow'));
        break;
      case 'progress':
        r.writeLine(r.color(`… 进度 step ${data.step || data.stepNumber || ''}`, 'gray'));
        break;
      case 'markdown':
        // In line mode, render a compact preview
        {
          const content = String(data.content || '').trim();
          if (content) {
            const preview = content.length > 240 ? content.slice(0, 237) + '…' : content;
            r.writeLine(r.color(preview, 'white'));
          }
        }
        break;
      case 'thought':
        {
          const s = data.short || data.thinking || '';
          r.writeLine(r.color(`💭 ${s}`, 'magenta'));
        }
        break;
      case 'result':
        {
          const msg = data.success ? '完成（已通过验证）' : '任务未通过验证';
          r.success(msg);
          recordOutput(msg);
          if (data && data.budgetReport && typeof data.budgetReport.usageRatio === 'number') {
            const p = Math.floor((data.budgetReport.usageRatio || 0) * 100);
            const c = p > 80 ? 'red' : p > 50 ? 'yellow' : 'green';
            const bmsg = `[最终预算 ${p}%]`;
            r.writeLine(r.color(bmsg, c));
            recordOutput(bmsg);
          }
        }
        break;
      case 'done':
        if (data.durationMs) {
          // P1.5b: "Cooked for" style tail note (CC-inspired)
          const t = `⏱ 用时 ${(data.durationMs / 1000).toFixed(1)}s`;
          r.writeLine(r.color(t, 'gray'));
          recordOutput(t);
        }
        break;
      case 'error':
        r.error(data.message || JSON.stringify(data));
        break;
      default:
        if (data && typeof data === 'object' && data.type) {
          renderSseEvent(data.type, data, r);
        } else {
          r.writeLine(JSON.stringify(data));
        }
    }
  }

  // --- Try rich UI (the real "交互升级") ---
  let bridge: any = null;
  let richActive = false;

  // Use a ref so the initial hostCtx lambdas see updates after assignment.
  const bridgeRef: { current: any } = { current: null };

  try {
    const { tryStartInkUI } = await import('./ui/startInkUI.js');

    // shared session (created above) — approval mode/allowlist are
    // seeded here and flow into the engine adapter via runTaskViaSse.
    // submissions route through handleUserLine (queue/steer aware).
    const hostCtx: any = {
      handleInput: async (text: string) => { await handleUserLine(text, bridgeRef.current); },
      executeTask: async (text: string) => { await handleUserLine(text, bridgeRef.current); },
    };

    const res = await tryStartInkUI(session as any, renderer, hostCtx);
    if (res && res.started) {
      richActive = true;
      bridge = (hostCtx as any).inkBridge || (hostCtx as any)._inkBridge || null;
      bridgeRef.current = bridge;

      // expose host-side handlers to the rich bridge
      try {
        (bridge as any).cycleMode = () => cycleMode();
        (bridge as any).clearQueue = () => { queue.clear(); updateQueueCount(); };
        (bridge as any).requestStatusPanel = () => {
          (async () => {
            const { recentCheckpoints } = await import('../../tools/fileHistory.js');
            const cps = recentCheckpoints(session.workspace || process.cwd(), 5);
            const feedOrLine = (text: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') => {
              if (typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text, level });
              else renderer.writeLine(renderer.color(text, 'gray'));
            };
            feedOrLine(`── 状态面板 ── 队列任务 ${queue.taskCount} · 未注入插话 ${queue.steerCount} · 模式 ${modeRing.current}`, 'info');
            for (const c of cps) feedOrLine(`  ↳ checkpoint ${c.rel}（${c.prevExists ? '可还原' : '创建型'}）`, 'info');
            if (cps.length === 0) feedOrLine('  ↳ （暂无 file-history checkpoint）', 'info');
          })().catch(() => {});
        };
      } catch {}

      // Rebind to ensure we pass the resolved bridge value.
      hostCtx.handleInput = async (text: string) => { await handleUserLine(text, bridgeRef.current); };
      hostCtx.executeTask = async (text: string) => { await handleUserLine(text, bridgeRef.current); };
    }
  } catch {
    // Any failure is silent; fall through to line streaming (still event-driven).
  }

  if (richActive && bridge) {
    // Rich Hermes UI owns the terminal. Nothing to clean up (no transport server).
    return;
  }

  // === Line streaming terminal (same in-process events, structured colored lines) ===
  // "通道升级" when rich UI (ink) is not available or TTY caps insufficient.
  renderer.clearScreen();
  renderer.writeLine(renderer.color('烛龙（Zhulong）', 'bold'));
  renderer.writeLine(renderer.color('流式终端（进程内事件直连）。输入任务后实时输出思考、工具调用与验证过程。', 'gray'));
  renderer.writeLine(renderer.color('命令: /help /exit /status /tier /clear /edit /undo /approvals   |  Ctrl+C 中断\n', 'gray'));
  if (resumedInfo) {
    renderer.info(`已恢复会话 ${resumedInfo.from}（${resumedInfo.turns} 轮上下文，模式 ${session.approvalMode}）——/status 查看，/undo 撤销最近写盘`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: renderer.color('▸ ', 'cyan'),
  });

  // Wire holders so the unified SSE runner (defined earlier) can restore the prompt
  // after consuming the SSE stream in the line-mode fallback.
  lineRl = rl;
  lineSetPrompt = () => { rl.setPrompt(renderer.color('▸ ', 'cyan')); };


  function setPrompt() {
    rl.setPrompt(renderer.color('▸ ', 'cyan'));
  }

  function restoreLinePrompt() {
    setPrompt();
    try { rl.prompt(); } catch {}
  }

  rl.on('close', () => {
    renderer.writeLine('\n再见。');
    process.exit(0);
  });

  // Handle Ctrl+C for running tasks
  rl.on('SIGINT', () => {
    if (currentAbort) {
      currentAbort.abort();
      renderer.warn('已请求中断当前任务...');
      currentAbort = null;
      setPrompt();
      rl.prompt();
    } else {
      renderer.writeLine('\n退出。');
      process.exit(0);
    }
  });

  // Simple command handling (local for now, can be proxied later)
  async function handleLocalCommand(line: string): Promise<boolean> {
    const trimmed = line.trim();
    if (!trimmed) return true;

    if (trimmed === '/exit' || trimmed === '/quit' || trimmed === '/q') {
      rl.close();
      return true;
    }

    if (trimmed === '/help' || trimmed === '?') {
      renderer.writeLine(`
可用命令:
  /help, /exit, /status, /tier <name>, /model <name>, /clear, /edit
直接输入文字 = 作为任务提交（进程内事件流实时输出）
`);
      return true;
    }

    if (trimmed.startsWith('/tier ')) {
      const t = trimmed.slice(6).trim();
      renderer.info(`(本地提示) 下次任务将使用 tier: ${t}`);
      return true;
    }

    if (trimmed === '/status') {
      const pct = Math.min(100, Math.floor((ctxUsedChars / 4 / CTX_WINDOW_TOKENS) * 100));
      renderer.writeLine('传输: 进程内直连（in-process events，无端口）。远程 UI 可用 /serve 启动 SSE 服务。');
      renderer.writeLine(`上下文估算: ~${pct}% of ${CTX_WINDOW_TOKENS} tokens（启发式）`);
      renderer.writeLine(`队列: ${queue.taskCount} 个排队任务；未注入插话: ${queue.steerCount}`);
      try {
        const { isBranch } = await import('../../cli/repl/rolloutStore.js');
        const origin = isBranch(session.id);
        if (origin) renderer.writeLine(`分支: branch of ${origin}（/resume 可回原会话）`);
      } catch {}
      if (lastInjectedSteers.length > 0) {
        renderer.writeLine(`最近注入的插话: ${lastInjectedSteers.join(' / ')}`);
      }
      return true;
    }

    if (trimmed === '/clear') {
      renderer.clearScreen();
      return true;
    }

    if (trimmed === '/edit' || trimmed === '/e') {
      const prev = getLastOutput();
      if (!prev) {
        renderer.warn('暂无上次输出可编辑');
        return true;
      }
      // Prefill for quick edit/resubmit in line mode
      try {
        (rl as any).line = prev;
        (rl as any).cursor = prev.length;
        if (typeof (rl as any)._refreshLine === 'function') (rl as any)._refreshLine();
        renderer.writeLine(renderer.color('(已载入上次输出，可编辑后回车提交)', 'gray'));
      } catch {
        renderer.writeLine('--- 上次输出 ---');
        renderer.writeLine(prev);
        renderer.writeLine('--- 直接提交以重用 ---');
        rl.prompt();
      }
      return true;
    }

    return false; // not a local command, treat as task
  }

  // Main input loop (line mode over SSE transport)
  let pendingPaste: string | null = null; // P4-4.4 folded paste awaiting Enter
  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Use the unified runner (no bridge → line renderer path).
    // while a task is running, submissions are queued/steered instead.
    if (isRunning()) {
      await handleUserLine(trimmed, undefined);
      rl.prompt();
      return;
    }

    // P4-4.4: paste guard (line mode) — large pastes fold and need a second
    // Enter to confirm (Esc-free simplification per instruction).
    const { detectPaste } = await import('./PasteGuard.js');
    const pasteInfo = detectPaste(line);
    if (pasteInfo.isPaste && pendingPaste === null) {
      pendingPaste = line;
      renderer.writeLine(renderer.color(`[粘贴 ${pasteInfo.lines} 行，已折叠；回车提交，Esc/输入其它内容取消]`, 'yellow'));
      rl.prompt();
      return;
    }
    if (pendingPaste !== null) {
      if (trimmed === '') {
        const submit = pendingPaste;
        pendingPaste = null;
        rl.prompt();
        await handleUserLine(submit, undefined);
        return;
      }
      // Any other input cancels the pending paste and is processed normally
      pendingPaste = null;
    }

    const isLocal = await handleLocalCommand(trimmed);
    if (isLocal) {
      rl.prompt();
      return;
    }

    // Use the unified runner (no bridge → line renderer path).
    // The runner's finally restores the prompt via lineSetPrompt/lineRl.
    await runTaskViaSse(trimmed);
  });
}

// Also export a thin wrapper so cli.ts can call it cleanly
export async function startDefaultSseCli() {
  return startSseInteractive();
}
