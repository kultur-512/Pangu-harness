// src/cli/repl/turn/CommandRouter.ts
// M1-TurnController（0.8 第 2 步，四模块搬家）：本地命令路由模块。
// LINE_COMMANDS / Tab 补全 / 未知命令建议 / handleLocalCommand / 斜杠命令派发
// （runTaskViaSse 内的 18 分支命令注册派发）/ pendingSuggestion 处理 / ModeRing 接线。
// 依赖纪律：依赖 turn/TurnContext 与 turn/TurnRenderer（纯助手，无环）；不反向 import TurnController。

import { ModeRing } from '../ModeRing.js';
import * as rollout from '../rolloutStore.js';
import { fuzzyFilter, fuzzyScore } from '../FuzzyMatcher.js';
import { buildHelpView } from '../commands/HelpCommand.js';
import { createCliApprovalBridge } from '../../../tools/approval.js';
import type { TurnContext } from './TurnContext.js';
import { getLastOutput, isRunning, resolveCtxWindowTokens, emitFeed, runSyncCompact } from './TurnContext.js';
import { buildEffortSliderBlock, localizeRolloutStatus, modeBadgeVisual, modeSwitchReceipt, redrawEffortSliderLines } from './TurnRenderer.js';

/** line 模式实际支持的命令（Tab 补全 + 未知命令建议的数据源；顺序 = 常用度）。 */
export const LINE_COMMANDS: ReadonlyArray<{ name: string; aliases?: string[] }> = [
  { name: 'help', aliases: ['?', 'h'] },
  { name: 'mode' },
  { name: 'model' },
  { name: 'memory' },
  { name: 'usage' },
  { name: 'undo' },
  { name: 'compact' },
  { name: 'resume' },
  { name: 'status' },
  { name: 'tier' },
  { name: 'edit', aliases: ['e'] },
  { name: 'clear' },
  { name: 'verbose' },
  { name: 'approvals' },
  { name: 'agents' },
  { name: 'tree' },
  { name: 'feature' },
  { name: 'init' },
  { name: 'rewind' },
  { name: 'exit', aliases: ['quit', 'q'] },
];

/**
 * line 模式 readline completer（同步适配：只补全 `/` 开头的命令名，
 * 精确前缀优先，模糊兜底走 FuzzyMatcher；顺序即 LINE_COMMANDS 常用度）。
 */
export function completeLineCommand(line: string): [string[], string] {
  const raw = String(line ?? '');
  if (!raw.startsWith('/') || /\s/.test(raw.slice(1))) return [[], raw];
  const prefix = raw.slice(1).toLowerCase();
  const exact = LINE_COMMANDS.filter(
    (c) => c.name.startsWith(prefix) || (c.aliases || []).some((a) => a.startsWith(prefix))
  ).map((c) => '/' + c.name);
  if (exact.length > 0) return [[...new Set(exact)], raw];
  const fuzzy = fuzzyFilter(prefix, LINE_COMMANDS.map((c) => ({ name: c.name, aliases: c.aliases as string[] })));
  if (fuzzy.length > 0) return [fuzzy.map((f) => '/' + f.name), raw];
  return [[], raw];
}

/** 未知命令 → 最近命令建议（含别名得分；低于子序列档 0.35 视为无建议）。 */
export function suggestCommand(input: string): string | null {
  const q = String(input || '').replace(/^\//, '').toLowerCase().trim();
  if (!q) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const c of LINE_COMMANDS) {
    const names = [c.name, ...(c.aliases || [])];
    let s = 0;
    for (let i = 0; i < names.length; i++) {
      const sc = fuzzyScore(q, names[i]) * (i > 0 ? 0.95 : 1);
      if (sc > s) s = sc;
    }
    if (s > bestScore) {
      bestScore = s;
      best = c.name;
    }
  }
  return bestScore >= 0.35 ? best : null;
}

/** mode ring — shift+tab cycles; plan floors approval to readonly,
 *  leaving plan restores the ring-mapped approval mode.
 *  切换回执为 `已切换: <模式> · <后果>`；徽标行置 pending，
 *  下一次空闲提示符上方输出一次（避免刷屏）。 */
export function createModeRing(ctx: TurnContext): ModeRing {
  // 0.8.2 一致性修复（真机 1B 实录实证）：ModeRing 初始 'default' 不触发
  // onChange，而 Session.approvalMode 初始 'readonly'——UI 显示 default、
  // 实际 readonly，写操作被静默拒绝。启动时显式同步一次（readonly 是
  // 交互场景的遗留默认，扶正为 default；显式档位不被覆盖）。
  if (ctx.session.approvalMode === 'readonly') {
    ctx.session.approvalMode = 'default';
  }
  return new ModeRing('default', (m) => {
    if (m === 'plan') {
      ctx.session.setPlanMode(true);
    } else {
      ctx.session.planMode = false;
      ctx.session.approvalMode = m === 'auto-accept' ? 'full' : m === 'full' ? 'full' : 'default';
    }
    try { rollout.appendApprovalChange(ctx.session); } catch {}
    ctx.modeBadgePending = true;
    // CC 式回执：`⏵⏵ auto-accept on · 后果`，整行套该档专属色（plan 蓝/accept 青/full 品红）。
    emitFeed(ctx, modeSwitchReceipt(m), 'info', modeBadgeVisual(m).color);
  });
}

function pushRichModeBadge(ctx: TurnContext, m: string) {
  if (typeof (ctx.bridgeRef as any).current?.setTop === 'function') {
    try { ctx.bridgeRef.current.setTop({ modeBadge: m === 'plan' ? 'PLAN' : m === 'auto-accept' ? 'AUTO' : m === 'full' ? 'FULL' : '' }); } catch {}
  }
}

export function cycleMode(ctx: TurnContext): string {
  const m = ctx.modeRing.cycle();
  pushRichModeBadge(ctx, m);
  return m;
}

// ==================== CC 式 /tier 交互滑杆（2026-09-12 对标 /effort） ====================

/** 组装当前 effortSel 的滑杆块（着色版，供打印与重绘共用）。 */
function effortSliderLines(ctx: TurnContext): string[] {
  const sel = ctx.effortSel!;
  return buildEffortSliderBlock({ tiers: sel.tiers, sublabels: sel.sublabels, index: sel.index, useColor: true });
}

/** ←→ 移动光标并原位重绘滑杆块（含副标注行），随后 readline 重画提示符行。 */
function redrawEffortSel(ctx: TurnContext): void {
  try { ctx.renderer.write(redrawEffortSliderLines(effortSliderLines(ctx))); } catch {}
  try { ctx.lineRefreshLine(); } catch {}
}

/**
 * effortSel 激活时的按键消费（在 rl._ttyWrite 内调用，与 SlashMenu 互斥）：
 * ←/→ 移动（钳位）· Enter 确认切换（updateTier + 回执）· Esc 保留现状 ·
 * Ctrl+C 关闭选择态后放行原 SIGINT 流程。返回 true = 已消费（readline 不处理）。
 */
export function handleEffortSelKey(ctx: TurnContext, key: any): boolean {
  const sel = ctx.effortSel;
  if (!sel?.active) return false;
  const name = String(key?.name || '');
  if (key?.ctrl && name === 'c') {
    ctx.effortSel = null;
    return false; // 放行给 SIGINT 处理链
  }
  if (name === 'left' || name === 'right') {
    const delta = name === 'left' ? -1 : 1;
    sel.index = Math.max(0, Math.min(sel.tiers.length - 1, sel.index + delta));
    redrawEffortSel(ctx);
    return true;
  }
  if (name === 'return' || name === 'enter') {
    const tier = sel.tiers[sel.index] || '';
    const sub = sel.sublabels[sel.index] || '';
    ctx.effortSel = null;
    try { ctx.session.updateTier(tier as any); } catch {}
    emitFeed(ctx, `✓ 思考强度已切换: ${tier}${sub ? ' · ' + sub : ''}`, 'success');
    try { ctx.lineSetPrompt(); } catch {}
    return true;
  }
  if (name === 'escape') {
    const cur = sel.tiers[sel.index] || '';
    ctx.effortSel = null;
    emitFeed(ctx, `（已保留 ${cur}）`, 'info');
    try { ctx.lineSetPrompt(); } catch {}
    return true;
  }
  return false;
}

function setMode(ctx: TurnContext, m: any) {
  // 旧实现 set(m) 后又 cycleMode() —— cycle 会把模式再推进一格，
  // `/mode plan` 实际落在 default。set 只需同步 rich 徽标，不再 cycle。
  ctx.modeRing.set(m);
  pushRichModeBadge(ctx, String(m));
}

// 与 classic（Repl.ts）完全同序的 26 命令注册表 —
// /help 的分组渲染、/resume 的委托执行都以它为数据源，三处输出一致。
// 导出：斜杠即时菜单（SlashMenu）复用它取 description/category 元数据。
export async function getSharedRegistry(ctx: TurnContext): Promise<any> {
  if (ctx.sharedRegistry) return ctx.sharedRegistry;
  const { CommandRegistry } = await import('../CommandRegistry.js');
  const reg = new CommandRegistry();
  const mods = await Promise.all([
    import('../commands/HelpCommand.js'),
    import('../commands/ExitCommand.js'),
    import('../commands/ClearCommand.js'),
    import('../commands/StatusCommand.js'),
    import('../commands/TierCommand.js'),
    import('../commands/WorkspaceCommand.js'),
    import('../commands/ModelCommand.js'),
    import('../commands/HistoryCommand.js'),
    import('../commands/RunCommand.js'),
    import('../commands/SimulateCommand.js'),
    import('../commands/ReviewCommand.js'),
    import('../commands/MemoryCommand.js'),
    import('../commands/TraceCommand.js'),
    import('../commands/ConfigCommand.js'),
    import('../commands/SessionCommand.js'),
    import('../commands/InitCommand.js'),
    import('../commands/ServeCommand.js'),
    import('../commands/ApprovalsCommand.js'),
    import('../commands/UndoCommand.js'),
    import('../commands/CompactCommand.js'),
    import('../commands/UsageCommand.js'),
    import('../commands/ResumeCommand.js'),
    import('../commands/RewindCommand.js'),
    import('../commands/AgentsCommand.js'),
    import('../commands/FeatureCommand.js'),
    import('../commands/TreeCommand.js'),
  ]);
  for (const m of mods) reg.register((m as any).default);
  ctx.sharedRegistry = reg;
  return reg;
}

/** 斜杠命令派发的输出统一出口（rich → pushFeed；line → renderer 分档）。 */
export function createCommandEmitter(
  ctx: TurnContext,
  useRich: boolean,
  bridge: any,
): (text: string, level?: 'info' | 'warn' | 'error' | 'success') => void {
  return (text: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') => {
    if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text, level });
    else if (level === 'warn') ctx.renderer.warn(text);
    else if (level === 'error') ctx.renderer.error(text);
    else if (level === 'success') ctx.renderer.success(text);
    else ctx.renderer.writeLine(text);
  };
}

/** Unified /edit (P1): pull last significant output back into input for edit/resubmit. */
export async function handleEditPrefill(ctx: TurnContext, useRich: boolean, bridge: any): Promise<boolean> {
  const prev = getLastOutput(ctx);
  if (!prev) {
    if (!useRich) ctx.renderer.warn('暂无上次输出可编辑');
    else if (typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: '暂无上次输出可编辑', level: 'warn' });
    return true;
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
      if (ctx.lineRl) {
        (ctx.lineRl as any).line = prev;
        (ctx.lineRl as any).cursor = prev.length;
        if (typeof (ctx.lineRl as any)._refreshLine === 'function') (ctx.lineRl as any)._refreshLine();
        ctx.renderer.writeLine(ctx.renderer.color('(已载入上次输出，可编辑后回车提交)', 'gray'));
      } else {
        ctx.renderer.writeLine('--- 上次输出 ---');
        ctx.renderer.writeLine(prev);
      }
    } catch {
      ctx.renderer.writeLine('--- 上次输出 ---');
      ctx.renderer.writeLine(prev);
    }
  }
  return true;
}

/**
 * runTaskViaSse 内的斜杠命令注册派发（原函数体的整段 if (trimmed.startsWith('/'))
 * 逐字节搬家；返回值 true = 已本地处理、调用方必须 return，斜杠行永不提交引擎）。
 */
export async function handleSlashCommand(
  ctx: TurnContext,
  d: {
    cmd: string;
    arg: string;
    emit: (text: string, level?: 'info' | 'warn' | 'error' | 'success') => void;
    useRich: boolean;
    bridge: any;
  }
): Promise<boolean> {
  const { cmd, arg, emit, useRich, bridge } = d;

  // 缺陷 #1（真机实测：rich UI 输入 /exit 落"未知命令"）：/exit(/quit /q)
  // 必须在统一派发器本地处理——line 模式的 handleLocalCommand 挡在前面
  // （lineRl.close()），rich 模式（无 readline）只能在这里干净退出：
  // 落会话元数据 → 卸载 ink（还原终端）→ exit 0。测试可用 ctx.requestExit
  // 注入替身，默认 process.exit(0)。
  // REVIEW M7：任务运行中（含 line 模式——运行态输入经 handleUserLine 的
  // classifyRunningInput 也会路由到这里）不得直接杀进程，先中断任务再退出。
  if (cmd === '/exit' || cmd === '/quit' || cmd === '/q') {
    if (isRunning(ctx)) {
      emit('任务运行中，请先按 Ctrl+C 中断任务，再输入 /exit 退出。', 'warn');
      return true;
    }
    try { rollout.appendMeta(ctx.session); } catch {}
    try {
      const inst = (globalThis as any).__PANSHA_INK_INSTANCE__;
      if (inst && typeof inst.unmount === 'function') inst.unmount();
    } catch {}
    try { ctx.requestExit(); } catch { process.exit(0); }
    return true;
  }

  // 缺陷 #7（真机实测：rich UI 输入 /serve 落"未知命令"）：与 /exit 同根——
  // rich 派发器缺分支。/serve 在 REPL 进程内启动 SSE agent server（POST /api/run），
  // 前端/脚本即可经 HTTP 驱动本 REPL。server 常驻进程、不阻塞输入；重复启动由
  // listen() 的 EADDRINUSE 兜底提示。
  if (cmd === '/serve') {
    const sArgs = arg.split(/\s+/).filter(Boolean);
    let port = 3456;
    let host = '127.0.0.1';
    let serveToken: string | undefined;
    for (let i = 0; i < sArgs.length; i++) {
      if (sArgs[i] === '--port' || sArgs[i] === '-p') { port = parseInt(sArgs[i + 1] || '3456', 10) || 3456; i++; }
      else if (sArgs[i] === '--host' || sArgs[i] === '-h') { host = sArgs[i + 1] || '127.0.0.1'; i++; }
      else if (sArgs[i] === '--serve-token' || sArgs[i] === '-t') { serveToken = sArgs[i + 1] || ''; i++; }
    }
    if (!serveToken && process.env.PANSHA_SERVE_TOKEN) serveToken = process.env.PANSHA_SERVE_TOKEN;
    try {
      const { createAgentServer } = await import('../../../server/agentServer.js');
      const server = createAgentServer({
        port,
        host,
        // /api/run 的 fresh session 无 model 配置——不接 provider 时每次 run 都会
        // 抛"未配置可用模型"（真机实测）。接入本 REPL 会话的 provider。
        provider: ctx.provider,
        defaultTier: ctx.session.tier,
        defaultWorkspace: ctx.session.workspace,
        serveToken,
      });
      await server.listen();
      emit(`✓ SSE agent server 已启动：http://${host}:${port}（POST /api/run {task, tier?, workspace?} → SSE 流）。服务随 REPL 进程常驻。`, 'success');
    } catch (e: any) {
      emit(`✗ /serve 启动失败：${e?.message || e}`, 'error');
    }
    return true;
  }

  // local commands shared by rich + line paths
  // (/undo now; /approvals + /usage + /compact land with their batches)
  if (cmd === '/agents') {
    // sub-agent rollout tree (serial progress list — honest)
    const nodes = ctx.agentTree.snapshot();
    const feedOrLine = (text: string, color?: 'bold' | 'gray') => {
      if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text, level: 'info' });
      else ctx.renderer.writeLine(color ? ctx.renderer.color(text, color) : text);
    };
    if (arg) {
      const n = ctx.agentTree.get(arg.trim());
      if (!n) { feedOrLine(`未找到 rollout: ${arg}`); return true; }
      feedOrLine(`rollout ${n.id}（${localizeRolloutStatus(n.status)}）`, 'bold');
      feedOrLine(`  步数: ${n.stepCount} · 耗时: ${(n.durationMs / 1000).toFixed(1)}s · 最近阶段: ${n.lastPhase ?? '-'}`);
      return true;
    }
    if (nodes.length === 0) { feedOrLine('尚无 rollout 数据（跑一个任务后出现）'); return true; }
    const done = nodes.filter((n) => n.status === 'done').length;
    const running = nodes.filter((n) => n.status === 'running').length;
    const failed = nodes.filter((n) => n.status === 'failed').length;
    const pending = nodes.filter((n) => n.status === 'pending').length;
    const totalMs = nodes.reduce((a, n) => a + n.durationMs, 0);
    // 统计行中文化
    feedOrLine(`共 ${nodes.length} rollouts · 完成 ${done} · 进行中 ${running} · 等待 ${pending} · 失败 ${failed} · 总耗时 ${(totalMs / 1000).toFixed(1)}s`, 'bold');
    for (const n of nodes) {
      const glyph = n.status === 'running' ? '▶' : n.status === 'done' ? '✓' : n.status === 'failed' ? '✗' : '·';
      const dur = n.durationMs >= 1000 ? `${(n.durationMs / 1000).toFixed(1)}s` : `${n.durationMs}ms`;
      feedOrLine(`  ${glyph} ${n.id} · ${localizeRolloutStatus(n.status)} · ${n.stepCount} 步 · ${dur}${n.lastPhase ? ` · ${n.lastPhase}` : ''}`);
    }
    // graph edges (dep/rollback/approval) annotated
    try {
      const edges = ctx.agentTree.edges();
      if (edges.length > 0) {
        feedOrLine('边:', 'gray');
        for (const e of edges) feedOrLine(`  ${e.from} --[${e.kind}]--> ${e.to}`, 'gray');
      }
    } catch {}
    // 文案清漂：删除"并行 rollout"表述——引擎恒单 rollout
    // 串行执行（Promise.allSettled 多 rollout 编排已随判官机制摘除），
    // 文案必须与运行时一致。
    feedOrLine('（当前为单 rollout 串行执行；rollout 列表记录任务内步骤进度）', 'gray');
    return true;
  }

  if (cmd === '/rewind') {
    // turn-level rewind lives in the classic command set
    // (registered RewindCommand); rich-mode panel wiring is deferred.
    // line 模式不静默 no-op——提示真实可用路径并按已处理返回
    //（false 会把命令当任务发给引擎）。
    emit('rewind 目前在经典模式可用：先 /classic 进入，或使用 /undo 回退最近变更', 'info');
    return true;
  }

  if (cmd === '/mode') {
    // hidden alias for keyboard-less environments (also the
    // testable entry point of ModeRing).
    const a = arg.toLowerCase();
    if (['plan', 'default', 'auto-accept', 'full'].includes(a)) {
      setMode(ctx, a);
    } else {
      cycleMode(ctx);
    }
    return true;
  }

  if (cmd === '/verbose') {
    // thinking 展示开关（内存标志；PANSHA_VERBOSE=1 初始为开）
    ctx.lineUi.verbose = !ctx.lineUi.verbose;
    emit(`思考显示: ${ctx.lineUi.verbose ? '全文多行（verbose）' : '单行滚动（默认）'}`, 'info');
    return true;
  }

  if (cmd === '/undo') {
    const { undoLatest } = await import('../../../tools/fileHistory.js');
    const r = undoLatest(ctx.session.workspace || process.cwd(), arg || undefined);
    emit(r.message, r.ok ? 'success' : 'warn');
    if (r.ok && r.diff && r.diff.length > 0) {
      for (const h of r.diff.slice(0, 40)) {
        const line = `${h.type === 'add' ? '+' : h.type === 'del' ? '−' : ' '} ${h.text}`;
        emit(line, h.type === 'add' ? 'success' : h.type === 'del' ? 'error' : 'info');
      }
      if (r.diff.length > 40) emit(`… ${r.diff.length - 40} 行省略 …`, 'info');
    }
    return true;
  }

  if (cmd === '/approvals') {
    const a = arg.toLowerCase();
    if (a === 'clear') {
      ctx.session.clearApprovalAllowlist();
      emit('本会话放行清单已清空。', 'success');
    } else if (['readonly', 'default', 'full'].includes(a)) {
      ctx.session.updateApprovalMode(a as any);
      emit(`审批模式已切换为 ${a}。`, 'success');
    } else {
      emit(`审批模式: ${ctx.session.approvalMode}；放行清单: ${[...ctx.session.sessionApprovalAllowlist].join(', ') || '(空)'}`, 'info');
      emit('用法: /approvals readonly|default|full|clear', 'info');
    }
    try { rollout.appendApprovalChange(ctx.session); } catch {}
    return true;
  }

  if (cmd === '/usage') {
    const { collectUsage, loadPricesFromConfig } = await import('../usageService.js');
    const prices = await loadPricesFromConfig(ctx.session.workspace || process.cwd());
    const r = collectUsage(ctx.session, prices);
    for (const line of r.lines) emit(line, 'info');
    return true;
  }

  if (cmd === '/compact') {
    // unified via runSyncCompact (client resolve + feedback + meter)
    const r = await runSyncCompact(ctx);
    if (r.ok) {
      const preview = r.summary.length > 300 ? r.summary.slice(0, 300) + '…' : r.summary;
      emit('摘要预览: ' + preview, 'info');
    }
    return true;
  }

  if (cmd === '/model') {
    // /model must be handled LOCALLY, not fall through
    // to the engine as a coding task (that produced the confusing
    // "No model client available" error).
    const sub = arg.trim();
    if (!sub || sub === 'list' || sub === 'ls') {
      emit(`当前模型: ${ctx.session.model}`, 'info');
      try {
        const { createDefaultModelProvider } = await import('../ModelProvider.js');
        const p = ctx.provider as any ?? createDefaultModelProvider();
        const names = (typeof p.listModels === 'function' ? p.listModels() : []).join(', ');
        emit(`已注册/可用入口: ${names}`, 'info');
        if (sub === 'list' || sub === 'ls') {
          // remote model list for the CURRENT provider (best-effort)
          const { resolveSharedClient } = await import('../ModelProvider.js');
          try {
            const { provider: pr } = await resolveSharedClient(ctx.session.model, ctx.provider as any);
            const remote = await pr.listProviderModels?.(ctx.session.model.includes(':') ? ctx.session.model.split(':')[0] : 'scnet');
            if (remote && remote.length) emit(`远程模型(${ctx.session.model.split(':')[0] || 'scnet'}): ${remote.slice(0, 30).join(', ')}`, 'info');
          } catch {}
        }
      } catch {}
      return true;
    }
    // /model <name> → switch session.model (validated on next task)
    ctx.session.model = sub;
    // 切换模型后旧模型的上下文计量失效——
    // ctxUsedChars 清零 + 窗口立即重取（下次任务边界也会再取一次兜底）。
    ctx.ctxUsedChars = 0;
    ctx.ctxWindowTokens = resolveCtxWindowTokens(ctx);
    emit(`模型已切换: ${sub}（下次任务生效）`, 'success');
    return true;
  }

  // rich mode slash commands MUST resolve
  // locally — /help /status /clear /tier and any unknown slash command are
  // handled here; a slash-prefixed line is NEVER submitted to the engine
  // as a coding task (iron rule).
  if (cmd === '/help' || cmd === '/h') {
    // 三处（classic/line/派发器）统一走 HelpCommand 分组渲染
    const reg = await getSharedRegistry(ctx);
    const view = buildHelpView(reg.list(), arg ? [arg.split(/\s+/)[0]] : []);
    for (const l of view.lines) emit(useRich ? l.text : (l.style ? ctx.renderer.color(l.text, l.style) : l.text), 'info');
    if (view.message) emit(view.message, 'warn');
    return true;
  }
  if (cmd === '/memory') {
    // 快捷帮助收录了 /memory — line 模式给非交互直通
    //（默认 list；无参数时 classic 的交互子菜单依赖 ctx.input，line 没有）
    const { runMemoryCommand } = await import('../../MemoryCommand.js');
    try {
      const result = await runMemoryCommand(arg ? arg.split(/\s+/) : ['list'], ctx.session.workspace || process.cwd());
      emit(result || '(无输出)', 'info');
    } catch (e: any) {
      emit('Memory 命令失败: ' + (e?.message || e), 'error');
    }
    return true;
  }
  if (cmd === '/resume') {
    // 委托注册表里的 ResumeCommand（只依赖 renderer）
    const reg = await getSharedRegistry(ctx);
    const rctx: any = {
      session: ctx.session,
      registry: reg,
      renderer: useRich ? { writeLine: (t: string) => emit(t, 'info'), color: (t: string) => t, warn: (t: string) => emit(t, 'warn'), error: (t: string) => emit(t, 'error'), success: (t: string) => emit(t, 'success'), info: (t: string) => emit(t, 'info') } : ctx.renderer,
      input: null,
      repl: null,
      provider: (ctx.session as any).provider,
      // sseInteractive 的 CommandContext 注册点——
      // 注入与当前路径一致的现成审批桥 + 在途任务的 abort signal，使经此
      // 派发的 registry 命令与主任务路径共享审批/中断语义。
      approvalBridge: useRich
        ? (req: { tool: string; description: string; danger: boolean }) => (ctx.bridgeRef.current.setConfirm(req) as Promise<string>)
        : createCliApprovalBridge(),
      signal: ctx.currentAbort?.signal,
    };
    const res = await reg.execute(rctx, 'resume', arg ? arg.split(/\s+/) : []);
    if (res?.message && res.message !== 'ok' && res.message !== 'none') emit(res.message, 'info');
    return true;
  }
  if (cmd === '/clear') {
    if (useRich && typeof bridge.clearScreen === 'function') { try { bridge.clearScreen(); } catch {} }
    else ctx.renderer.clearScreen();
    return true;
  }
  if (cmd === '/tier' || cmd === '/t') {
    // CC 式思考强度滑杆（2026-09-12 对标 /effort）。无参 → 交互选择态
    // （←/→ 调节 · Enter 确认 · Esc 取消）：
    //   rich → bridge.openTierPicker（真 ink 组件，确认/取消即卸载，无静态残迹；
    //          缺陷 #3/#4：旧实现把 8 行滑杆推进 feed 且无人消费按键——永久残留
    //          且完全不可交互）；rich UI 未挂载（启动窗口/降级）→ 单行静态说明，
    //          绝不打印多行残迹块。
    //   line → 打印着色滑杆块并激活 effortSel（按键消费在 _ttyWrite 层）。
    // 带参（名称或编号）→ 即时切换，编号与刻度同序。
    const { TierRegistry } = await import('../../../tiers/TierConfig.js');
    const configs = TierRegistry.getAll();
    const TIERS = configs.map((c) => c.tier as string);
    const SUBS = configs.map((c) => c.typicalUseCase);
    const t = arg.trim().toLowerCase();
    if (!t) {
      const index = Math.max(0, TIERS.indexOf(String(ctx.session.tier || '')));
      if (useRich && typeof (bridge as any).openTierPicker === 'function') {
        const picked = await (bridge as any).openTierPicker({ tiers: TIERS, sublabels: SUBS, index });
        if (picked === null || picked === undefined) {
          // rich UI 未就绪（dispatch 未注册）——单行说明兜底，无残迹
          emit(`思考强度: ${TIERS[index] || String(ctx.session.tier || '')}${SUBS[index] ? ' · ' + SUBS[index] : ''}（用 /tier <${TIERS.join('|')}> 切换）`, 'info');
          return true;
        }
        if (picked >= 0) {
          const target = TIERS[picked] || '';
          if (target && TierRegistry.isTier(target)) {
            // REVIEW M4：统一走 updateTier（刷新 updatedAt），与 line 模式滑杆
            // 确认分支一致；裸赋值会让会话元数据的更新时间失真。
            ctx.session.updateTier(target as any);
            const sub = SUBS[picked] || '';
            if (typeof (bridge as any).setTop === 'function') {
              try { (bridge as any).setTop({ tier: target }); } catch {}
            }
            emit(`✓ 思考强度已切换: ${target}${sub ? ' · ' + sub : ''}（下次任务生效）`, 'success');
          } else {
            emit(`无效档位: ${target}（可用: ${TIERS.join(' | ')}）`, 'warn');
          }
        } else {
          emit(`（已保留 ${TIERS[index] || String(ctx.session.tier || '')}）`, 'info');
        }
        return true;
      }
      // line 模式着色版；rich 桥 feed 不吃 ANSI → 纯文本（仅 line 走到这里）。
      for (const l of buildEffortSliderBlock({ tiers: TIERS, sublabels: SUBS, index, useColor: !useRich })) emit(l, 'info');
      if (!useRich) ctx.effortSel = { active: true, tiers: TIERS, sublabels: SUBS, index };
      return true;
    }
    let target = t;
    if (/^\d+$/.test(target)) {
      const idx = parseInt(target, 10);
      if (idx < 1 || idx > TIERS.length) {
        emit(`编号 "${arg.trim()}" 超出范围（共 ${TIERS.length} 档）—— /tier 查看刻度。`, 'warn');
        return true;
      }
      target = TIERS[idx - 1];
    }
    if (!TierRegistry.isTier(target)) {
      emit(`无效档位: ${arg.trim()}（可用: ${TIERS.join(' | ')}）`, 'warn');
      return true;
    }
    // REVIEW M4：与滑杆确认分支一致，走 updateTier（刷新 updatedAt）
    ctx.session.updateTier(target as any);
    const sub = SUBS[TIERS.indexOf(target)] || '';
    emit(`✓ 思考强度已切换: ${target}${sub ? ' · ' + sub : ''}（下次任务生效）`, 'success');
    return true;
  }
  if (cmd === '/status') {
    const pct = Math.min(100, Math.floor((ctx.ctxUsedChars / 4 / ctx.ctxWindowTokens) * 100));
    emit(`模式 ${ctx.session.approvalMode} · 档位 ${ctx.session.tier} · 模型 ${ctx.session.model} · 上下文 ~${pct}% · 队列 ${ctx.queue.taskCount} 任务 / ${ctx.queue.steerCount} 插话`, 'info');
    return true;
  }
  if (cmd === '/tree') {
    // session tree (origin + branch nodes); /tree <id> → resume path
    try {
      const { listSessionTree, renderSessionTree } = await import('../rolloutStore.js');
      const current = (ctx.session as any).sessionId || '';
      const target = arg.trim() || current;
      const tree = listSessionTree(target);
      emit('会话树:', 'info');
      for (const line of renderSessionTree(tree, current)) emit('  ' + line, 'info');
      if (arg.trim() && arg.trim() !== current) emit(`切到节点 ${arg.trim()} 续写: /resume ${arg.trim()}`, 'success');
      else emit('分支: /rewind 创建；节点续写: /tree <id> 后 /resume <id>', 'info');
    } catch (e: any) {
      emit('会话树读取失败: ' + (e?.message || e), 'error');
    }
    return true;
  }
  if (cmd === '/feature') {
    // /feature list|add|done|next (rich-local mirror of FeatureCommand)
    const { loadFeatures, activeFeature, addFeature, markFeatureDone, setFeatureNext } = await import('../FeatureTracker.js');
    const ws = ctx.session.workspace || process.cwd();
    const sub = (arg.split(/\s+/)[0] || 'list').toLowerCase();
    const rest = arg.split(/\s+/).slice(1);
    if (sub === 'list' || sub === 'ls') {
      const items = loadFeatures(ws);
      if (items.length === 0) { emit('特性列表为空（/feature add <标题> 开始）', 'info'); return true; }
      for (const f of items) {
        const mark = f.status === 'in-progress' ? '▶' : f.status === 'done' ? '✓' : f.status === 'blocked' ? '✗' : '·';
        emit(`  ${mark} ${f.id} ${f.title} [${f.status}]${f.evidence ? ' · ✓ ' + f.evidence : ''}`, 'info');
      }
      return true;
    }
    if (sub === 'add') {
      const title = rest.join(' ').trim();
      const item = title ? addFeature(ws, title) : null;
      emit(item ? `已添加并激活: ${item.id} ${item.title}` : '用法: /feature add <标题>', item ? 'success' : 'warn');
      return true;
    }
    if (sub === 'done') {
      const err = markFeatureDone(ws, rest[0] || '', rest.slice(1).join(' ').trim());
      emit(err ?? `已标记 done: ${rest[0]}`, err ? 'warn' : 'success');
      return true;
    }
    if (sub === 'next') {
      const err = setFeatureNext(ws, rest[0] || '', rest.slice(1).join(' ').trim());
      emit(err ?? `已设为 active: ${rest[0]}`, err ? 'warn' : 'success');
      return true;
    }
    emit('用法: /feature list|add <标题>|done <id> <证据>|next <id>', 'warn');
    return true;
  }
  if (cmd === '/init') {
    // rich-local /init — probe workspace + write
    // .panshalach/AGENTS.md + feature_list.json. B-dual: reuses the SAME
    // probe/build logic as the registry InitCommand (the old inline
    // simplified copy diverged in output — now unified).
    try {
      const { probeWorkspace, buildAgentsMd } = await import('../commands/InitCommand.js');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const ws = ctx.session.workspace || process.cwd();
      const probe = probeWorkspace(ws);
      const agents = buildAgentsMd(ws, probe);
      const agentsPath = path.join(ws, '.panshalach', 'AGENTS.md');
      const existed = fs.existsSync(agentsPath);
      if (existed && arg !== '--force' && arg !== '-f') { emit('AGENTS.md 已存在（/init --force 覆盖）', 'warn'); return true; }
      fs.mkdirSync(path.join(ws, '.panshalach'), { recursive: true });
      fs.writeFileSync(agentsPath, agents, 'utf-8');
      const { saveFeatures, featureListPath } = await import('../FeatureTracker.js');
      if (!fs.existsSync(featureListPath(ws))) saveFeatures(ws, []);
      const cmds = [probe.buildCmd, probe.testCmd, probe.lintCmd].filter(Boolean).join(' | ') || '未探测到';
      emit(`已生成 ${agentsPath}（验证命令: ${cmds}）`, 'success');
    } catch (e: any) {
      emit('初始化失败: ' + (e?.message || e), 'error');
    }
    return true;
  }

  // iron rule: unknown slash commands never reach the engine.
  // 加模糊建议 — line 空闲态置待定命令（回车确认执行，
  // Esc/其他输入取消）；rich / 运行中只提示建议。
  // 建议不能指向命令本身（自指：确认后又落"未知命令"无限循环），
  // 且待定命令确认路径会先过 handleLocalCommand（/exit /clear 只在那注册）。
  {
    const sug = suggestCommand(cmd);
    if (sug && ('/' + sug) !== cmd) {
      if (!useRich && !isRunning(ctx)) {
        ctx.pendingSuggestion = '/' + sug;
        emit(`未知命令 ${cmd} · 你是不是想要 /${sug}？（回车确认执行，Esc/其他输入取消）`, 'warn');
      } else {
        emit(`未知命令 ${cmd} · 你是不是想要 /${sug}？（输入 /help 查看全部命令）`, 'warn');
      }
    } else {
      emit(`未知命令: ${cmd}（输入 /help 查看可用命令；斜杠命令均本地执行）`, 'warn');
    }
  }
  return true;
}

/**
 * 待定命令建议确认（回车执行）——先过本地命令注册（/exit /clear 等只在
 * handleLocalCommand），否则确认执行建议命令会落 runTaskViaSse 的"未知命令"
 * 分支自指循环。返回是否消费了建议；runTask 由调用方注入（本模块不反向依赖
 * TurnController）。
 */
export async function confirmPendingSuggestion(
  ctx: TurnContext,
  runTask: (task: string) => Promise<void>,
): Promise<boolean> {
  const sug = ctx.pendingSuggestion;
  if (!sug) return false;
  ctx.pendingSuggestion = null;
  ctx.renderer.writeLine(ctx.renderer.color(`→ ${sug}`, 'gray'));
  if (!(await handleLocalCommand(ctx, sug))) {
    await runTask(sug);
  }
  return true;
}

// --- Simple command handling (local for now, can be proxied later)
export async function handleLocalCommand(ctx: TurnContext, line: string): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed) return true;

  if (trimmed === '/exit' || trimmed === '/quit' || trimmed === '/q') {
    ctx.lineRl?.close();
    return true;
  }

  // `?` 不再截获——输入问号也是给模型的信息（控制人裁决），
  // `?` 作为普通任务文本透传；帮助只走 /help（buildQuickHelpLines 保留供 /help 复用）。

  if (trimmed === '/help' || trimmed === '/h') {
    // 与派发器 / classic 完全一致的分组帮助（HelpCommand 渲染）
    const reg = await getSharedRegistry(ctx);
    const view = buildHelpView(reg.list());
    for (const l of view.lines) ctx.renderer.writeLine(l.style ? ctx.renderer.color(l.text, l.style) : l.text);
    if (view.message) ctx.renderer.warn(view.message);
    return true;
  }

  if (trimmed === '/status') {
    const pct = Math.min(100, Math.floor((ctx.ctxUsedChars / 4 / ctx.ctxWindowTokens) * 100));
    ctx.renderer.writeLine('传输: 进程内直连（in-process events，无端口）。远程 UI 可用 /serve 启动 SSE 服务。');
    ctx.renderer.writeLine(`上下文估算: ~${pct}% of ${ctx.ctxWindowTokens} tokens（启发式）`);
    ctx.renderer.writeLine(`队列: ${ctx.queue.taskCount} 个排队任务；未注入插话: ${ctx.queue.steerCount}`);
    try {
      const { isBranch } = await import('../rolloutStore.js');
      const origin = isBranch(ctx.session.id);
      if (origin) ctx.renderer.writeLine(`分支: branch of ${origin}（/resume 可回原会话）`);
    } catch {}
    if (ctx.lastInjectedSteers.length > 0) {
      ctx.renderer.writeLine(`最近注入的插话: ${ctx.lastInjectedSteers.join(' / ')}`);
    }
    return true;
  }

  if (trimmed === '/clear') {
    ctx.renderer.clearScreen();
    return true;
  }

  if (trimmed === '/edit' || trimmed === '/e') {
    const prev = getLastOutput(ctx);
    if (!prev) {
      ctx.renderer.warn('暂无上次输出可编辑');
      return true;
    }
    // Prefill for quick edit/resubmit in line mode
    try {
      (ctx.lineRl as any).line = prev;
      (ctx.lineRl as any).cursor = prev.length;
      if (typeof (ctx.lineRl as any)._refreshLine === 'function') (ctx.lineRl as any)._refreshLine();
      ctx.renderer.writeLine(ctx.renderer.color('(已载入上次输出，可编辑后回车提交)', 'gray'));
    } catch {
      ctx.renderer.writeLine('--- 上次输出 ---');
      ctx.renderer.writeLine(prev);
      ctx.renderer.writeLine('--- 直接提交以重用 ---');
      (ctx.lineRl as any)?.prompt?.();
    }
    return true;
  }

  return false; // not a local command, treat as task
}
