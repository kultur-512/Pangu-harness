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
//
// M1-TurnController（0.8 第 2 步，四模块搬家）：本文件收缩为「会话壳」——
// 启动横幅 / TTY 判定 / ink 降级 / SIGINT / readline 生命周期 / 模块接线。
// 任务执行体（runTaskViaSse）、命令路由（handleLocalCommand/斜杠派发）、
// 渲染助手（mapSseToBridge/renderSseEvent/纯助手）与 TurnContext 巨状态
// 已迁至 ./turn/ 四模块（行为逐字节等价）。

import readline from 'readline';
import { createOutputRenderer } from './OutputRenderer.js';
import { isApprovalActive, cancelActiveApproval, setApprovalActivityListener } from '../../tools/approval.js';
import { Session } from './Session.js';
import * as rollout from './rolloutStore.js';
import type { ModelProvider } from './types.js';
import { createTurnContext, clearInlineLine, isRunning, updateQueueCount } from './turn/TurnContext.js';
import { buildBanner, createClearingRenderer, modeBadgeVisual, shouldShowStartupTip, termWidth } from './turn/TurnRenderer.js';
import { completeLineCommand, confirmPendingSuggestion, createModeRing, cycleMode, getSharedRegistry, handleEffortSelKey, handleLocalCommand, LINE_COMMANDS } from './turn/CommandRouter.js';
import { buildSlashMenuItems, createSlashMenuController } from './turn/SlashMenu.js';
import { createTurnController } from './turn/TurnController.js';

export interface SseInteractiveOptions {
  provider?: ModelProvider;
  defaultTier?: string;
  defaultWorkspace?: string;
  /** resume an existing session instead of starting fresh */
  session?: Session;
}

export async function startSseInteractive(opts: SseInteractiveOptions = {}): Promise<void> {
  // Check basic TTY capability. If not TTY, fall back to classic immediately.
  const isInteractiveTty =
    process.stdout.isTTY &&
    process.stdin.isTTY;

  if (!isInteractiveTty) {
    // Silent downgrade: use the classic REPL path.
    // Carry a restored session (--resume) through the downgrade — the
    // classic fallback must not lose the resume state.
    const { startClassicRepl } = await import('./classicRepl.js');
    return startClassicRepl(opts.session ? { session: opts.session } : {});
  }

  // one shared session for rich + line paths (approval mode/allowlist
  // flow from here into the engine adapter; resume seeds it).
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

  // ---- 会话壳：构造 TurnContext + 清活行 renderer ----
  const ctx = createTurnContext({ session, provider: opts.provider });
  const rawRenderer = createOutputRenderer();
  ctx.renderer = createClearingRenderer(rawRenderer, () => clearInlineLine(ctx));

  // MCP stdio clients closed on process exit (hang discipline).
  process.once('exit', () => {
    for (const c of ctx.mcpClients.values()) { try { c.close(); } catch {} }
  });

  // in-flight background compaction (cancelled on session exit)
  process.once('exit', () => { if (ctx.bgCompact) { try { ctx.bgCompact.cancel(); } catch {} } });

  ctx.modeRing = createModeRing(ctx);
  const controller = createTurnController(ctx);

  // --- Try rich UI (the real "交互升级") ---
  let bridge: any = null;
  let richActive = false;

  try {
    const { tryStartInkUI } = await import('./ui/startInkUI.js');

    // shared session (created above) — approval mode/allowlist are
    // seeded here and flow into the engine adapter via runTaskViaSse.
    // submissions route through handleUserLine (queue/steer aware).
    const hostCtx: any = {
      handleInput: async (text: string) => { await controller.handleLine(text, ctx.bridgeRef.current); },
      executeTask: async (text: string) => { await controller.handleLine(text, ctx.bridgeRef.current); },
    };

    const res = await tryStartInkUI(session as any, ctx.renderer, hostCtx);
    if (res && res.started) {
      richActive = true;
      bridge = (hostCtx as any).inkBridge || (hostCtx as any)._inkBridge || null;
      ctx.bridgeRef.current = bridge;

      // expose host-side handlers to the rich bridge
      try {
        (bridge as any).cycleMode = () => cycleMode(ctx);
        (bridge as any).clearQueue = () => { ctx.queue.clear(); updateQueueCount(ctx); };
        // Ctrl+C 组件层接管（exitOnCtrlC:false 后由 PanshaApp 调用）：
        // 与 line 模式 handleSigint 同语义——审批挂起 → 拒绝；任务运行中 →
        // 中断（abort → stopReason='aborted' 收尾落盘）；空闲 → 2s 内再按退出。
        (bridge as any).handleCtrlC = () => {
          // 1) line 侧审批桥挂起（罕见，rich 主用 setConfirm）→ 立即拒绝
          if (isApprovalActive()) {
            cancelActiveApproval('sigint');
            return;
          }
          // 2) rich 审批（ConfirmBar）挂起 → Ctrl+C = 拒绝该次审批
          if (typeof (bridge as any).hasPendingConfirm === 'function' && (bridge as any).hasPendingConfirm()) {
            try { (bridge as any).resolveConfirm('n'); } catch {}
            return;
          }
          // 3) 任务运行中 → 中断当前任务，回到可输入状态（UI 不卸载）
          if (ctx.currentAbort) {
            try { ctx.currentAbort.abort(); } catch {}
            return;
          }
          // 4) 空闲 → 二次确认模式：2s 内再按才退出（复用 line 的 idleCtrlCAt 语义）
          const now = Date.now();
          if (ctx.lineUi.idleCtrlCAt && now - ctx.lineUi.idleCtrlCAt < 2000) {
            try { rollout.appendMeta(session); } catch {}
            try {
              const inst = (globalThis as any).__PANSHA_INK_INSTANCE__;
              if (inst && typeof inst.unmount === 'function') inst.unmount();
            } catch {}
            try { ctx.requestExit(); } catch { process.exit(0); }
            return;
          }
          ctx.lineUi.idleCtrlCAt = now;
          if (typeof (bridge as any).pushFeed === 'function') {
            (bridge as any).pushFeed({ type: 'text', text: '再按一次 Ctrl+C 退出 · 任务运行中按 = 中断任务', level: 'info' });
          }
          const t = setTimeout(() => { ctx.lineUi.idleCtrlCAt = 0; }, 2000);
          (t as any).unref?.();
        };
        (bridge as any).requestStatusPanel = () => {
          (async () => {
            const { recentCheckpoints } = await import('../../tools/fileHistory.js');
            const cps = recentCheckpoints(session.workspace || process.cwd(), 5);
            const feedOrLine = (text: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') => {
              if (typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text, level });
              else ctx.renderer.writeLine(ctx.renderer.color(text, 'gray'));
            };
            feedOrLine(`── 状态面板 ── 队列任务 ${ctx.queue.taskCount} · 未注入插话 ${ctx.queue.steerCount} · 模式 ${ctx.modeRing.current}`, 'info');
            for (const c of cps) feedOrLine(`  ↳ checkpoint ${c.rel}（${c.prevExists ? '可还原' : '创建型'}）`, 'info');
            if (cps.length === 0) feedOrLine('  ↳ （暂无 file-history checkpoint）', 'info');
          })().catch(() => {});
        };
      } catch {}

      // Rebind to ensure we pass the resolved bridge value.
      hostCtx.handleInput = async (text: string) => { await controller.handleLine(text, ctx.bridgeRef.current); };
      hostCtx.executeTask = async (text: string) => { await controller.handleLine(text, ctx.bridgeRef.current); };
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
  ctx.renderer.clearScreen();
  // 启动横幅 — 粗体名 + dim 元信息（cwd 按显示宽度截断）
  {
    const banner = buildBanner({
      model: session.model,
      tier: String(session.tier),
      mode: ctx.modeRing.current,
      workspace: session.workspace || process.cwd(),
      width: termWidth(),
    });
    ctx.renderer.writeLine(ctx.renderer.color(banner[0], 'bold'));
    ctx.renderer.writeLine(ctx.renderer.color(banner[1], 'gray'));
    ctx.renderer.writeLine(ctx.renderer.color(banner[2], 'gray'));
    // 首跑预检——横幅处探测无任何可用 provider 时打一行灰字配置
    // 指引（不阻塞、不报错；用户配置好后 /model list 会热加载）。
    try {
      const { createDefaultModelProvider } = await import('../../cli/repl/ModelProvider.js');
      const probe = opts.provider ?? createDefaultModelProvider();
      const names = typeof probe.listModels === 'function' ? probe.listModels() : [];
      const anyUsable = names.some((n) => { try { return !!probe.createClient(n); } catch { return false; } })
        || !!(typeof probe.createDefaultClient === 'function' && probe.createDefaultClient());
      if (!anyUsable) {
        ctx.renderer.writeLine(ctx.renderer.color(
          '未检测到可用模型。三选一：① 项目根放 .panshalach.json（示例见 README/DEPLOY-CN §2.3） ② 用户级 ~/.panshalach/config.json ③ 启动后 /model list 选择',
          'gray'
        ));
      }
    } catch {}
  }
  if (resumedInfo) {
    ctx.renderer.info(`已恢复会话 ${resumedInfo.from}（${resumedInfo.turns} 轮上下文，模式 ${session.approvalMode}）——/status 查看，/undo 撤销最近写盘`);
  } else if (shouldShowStartupTip(session.turns.length, false, Math.random()) && ctx.tipGate.canShow('startup')) {
    // 新会话 50% 概率出一条启动 tip
    ctx.tipGate.markShown('startup');
    ctx.renderer.writeLine(ctx.renderer.color('Tip: 直接输入任务描述即可开始，如 "修复 README 里的错别字"', 'gray'));
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: ctx.renderer.color('▸ ', 'cyan'),
    // Tab 补全 `/` 命令名（精确前缀优先 + 模糊兜底，常用命令在前）
    completer: (line: string): [string[], string] => completeLineCommand(line),
  });

  // Wire holders so the unified SSE runner can restore the prompt
  // after consuming the SSE stream in the line-mode fallback.
  ctx.lineRl = rl;

  // 斜杠命令派发（菜单 Enter 与 rl 'line' 的 `/` 分支共用等价路径）：
  // 本地命令注册（/exit /clear /edit …）优先 → 其余斜杠行走统一派发器；
  // 多为早退分支、不经过 runTaskViaSse 的 finally — 统一恢复提示符。
  async function dispatchSlashCommand(trimmed: string): Promise<void> {
    if (isApprovalActive()) return;
    const isLocal = await handleLocalCommand(ctx, trimmed);
    if (isLocal) {
      linePromptIdle();
      return;
    }
    await controller.runTask(trimmed);
    if (!isRunning(ctx)) linePromptIdle();
  }

  // 空闲提示符上方的模式徽标行 — 只在启动与模式变化后输出一次。
  // CC 式视觉：每档专属符号 + 专属色（plan 蓝 / auto-accept 青 / full 品红 / default 灰）。
  function printModeBadgeIfPending() {
    if (!ctx.modeBadgePending) return;
    ctx.modeBadgePending = false;
    try {
      const v = modeBadgeVisual(ctx.modeRing.current);
      ctx.renderer.writeLine(ctx.renderer.color(v.line, v.color));
    } catch { ctx.modeBadgePending = true; }
  }

  /** 空闲态出提示符（徽标行置前；统一入口，防漏防刷）。 */
  function linePromptIdle() {
    printModeBadgeIfPending();
    try { rl.prompt(); } catch {}
  }

  // CC 式斜杠即时菜单：idle 态输入 `/` 弹出（实时过滤 + ↑↓ 导航 + 分组 +
  // 滚动视口）；任务运行中/审批挂起不激活（focus 边界）。
  const slashMenu = createSlashMenuController({
    getItems: async () => {
      const reg = await getSharedRegistry(ctx);
      const meta = (reg.list() as any[]).map((c) => ({
        name: c.name, aliases: c.aliases ?? [], description: c.description ?? '', category: c.category ?? 'other',
      }));
      // /verbose 只在派发器内联处理（registry 无元数据）——这里补齐
      meta.push({ name: 'verbose', aliases: [], description: '思考显示 全文/单行 切换', category: 'system' });
      return buildSlashMenuItems(LINE_COMMANDS, meta);
    },
    isBlocked: () => isApprovalActive() || isRunning(ctx),
    currentLine: () => {
      try { return String((rl as any).line ?? ''); } catch { return ''; }
    },
    width: () => termWidth(),
    write: (s: string) => { try { process.stdout.write(s); } catch {} },
    refreshLine: () => { try { (rl as any)._refreshLine?.(); } catch {} },
    execute: (cmd: string) => {
      // 菜单优先：待定建议流程让位（菜单 Enter 不触发建议确认）
      ctx.pendingSuggestion = null;
      // 清空当前输入行，选中命令直接执行（不重新输入）
      try {
        (rl as any).line = '';
        (rl as any).cursor = 0;
        if (typeof (rl as any)._refreshLine === 'function') (rl as any)._refreshLine();
      } catch {}
      return dispatchSlashCommand(cmd);
    },
  });

  // keypress 拦截（只在菜单激活且 key ∈ {up,down,return/enter,escape} 时消费，
  // 其余透传 readline；菜单关闭后 ↑↓ 恢复 readline 历史导航默认行为）。
  // 包一层 rl._ttyWrite —— readline 每个按键都经它分发，在此消费可抢在
  // 历史导航/行提交之前；菜单关闭时零改动透传。
  // /tier 交互滑杆（effortSel）激活时优先消费 ←→/Enter/Esc，与 SlashMenu 互斥。
  const origTtyWrite = (rl as any)._ttyWrite;
  if (typeof origTtyWrite === 'function') {
    (rl as any)._ttyWrite = (s: string, key: any) => {
      let consumed = false;
      if (ctx.effortSel?.active) {
        try { consumed = handleEffortSelKey(ctx, key); } catch { consumed = false; }
      } else {
        try { consumed = slashMenu.handleKey(key); } catch { consumed = false; }
      }
      if (!consumed) origTtyWrite.call(rl, s, key);
      // 字符变化 → 重过滤/开合（未变化的键按下后为 no-op；滑杆激活期间不重过滤）
      if (!ctx.effortSel?.active) {
        try { slashMenu.syncLine(String((rl as any).line ?? '')); } catch {}
      }
    };
  }

  ctx.lineSetPrompt = () => {
    rl.setPrompt(ctx.renderer.color('▸ ', 'cyan'));
    printModeBadgeIfPending(); // runTaskViaSse finally 恢复提示符前也补徽标（若模式刚变过）
  };
  ctx.lineRefreshLine = () => { try { (rl as any)._refreshLine?.(); } catch {} };

  rl.on('close', () => {
    ctx.renderer.writeLine('\n再见。');
    process.exit(0);
  });

  // 审批 question 挂起/结束时交接 stdin（暂停/恢复主 readline）。
  // 审批桥（approval.ts）经模块级钩子通知这里；gerund 的暂停在 paint 回调里
  // 直接检查 isApprovalActive()。
  try {
    setApprovalActivityListener((active) => {
      if (!ctx.lineRl) return;
      try { if (active) ctx.lineRl.pause(); else ctx.lineRl.resume(); } catch {}
    });
  } catch {}

  // Ctrl+C 全链路 — 统一入口（readline raw 模式的 \x03 走 rl 'SIGINT'；
  // cooked 模式 / POSIX 信号 / Windows console ctrl 走 process 'SIGINT' 兜底）。
  // 同一次按键两个入口都触发时用 100ms 去重。
  function handleSigint() {
    const now = Date.now();
    if (now - ctx.lineUi.lastSigintAt < 100) return;
    ctx.lineUi.lastSigintAt = now;
    // 1) 审批挂起 → 立即拒绝该次审批
    if (isApprovalActive()) {
      cancelActiveApproval('sigint');
      return;
    }
    // 2) 任务运行中 → 中断（提示合并：只由 aborted 分支出一条消息）
    if (ctx.currentAbort) {
      try { ctx.currentAbort.abort(); } catch {}
      return;
    }
    // 3) 幽灵 ^C：任务刚结束 1.5s 内的缓冲按键只忽略一次，随后放行到二次确认
    if (ctx.lineUi.taskEndedAt && now - ctx.lineUi.taskEndedAt < 1500) {
      if (!ctx.lineUi.ghostIgnored) {
        ctx.lineUi.ghostIgnored = true;
        ctx.renderer.writeLine(ctx.renderer.color('（任务刚结束，忽略退出）', 'gray'));
        return;
      }
      // 窗口内第二次按：已提示过一次，落到二次确认分支
    }
    // 4) 空闲 → 二次确认模式：2s 内再按才退出
    if (ctx.lineUi.idleCtrlCAt && now - ctx.lineUi.idleCtrlCAt < 2000) {
      ctx.renderer.writeLine('\n再见。');
      process.exit(0);
    }
    ctx.lineUi.idleCtrlCAt = now;
    ctx.renderer.writeLine(ctx.renderer.color('再按一次 Ctrl+C 退出 · Ctrl+C 正在执行时 = 中断任务', 'gray'));
    const t = setTimeout(() => { ctx.lineUi.idleCtrlCAt = 0; }, 2000);
    (t as any).unref?.();
  }

  rl.on('SIGINT', () => handleSigint());
  process.on('SIGINT', () => handleSigint());

  // shift+tab 循环模式环；Esc 取消待定命令建议。
  // 审批挂起期间（stdin 所有权在审批桥）与任务运行中（提示符不在屏，
  // 输出会被流式内容污染）一律忽略。
  try {
    process.stdin.on('keypress', (_str: string, key: any) => {
      if (!key) return;
      if (key.shift && key.name === 'tab') {
        if (isApprovalActive() || isRunning(ctx)) return;
        cycleMode(ctx);
        linePromptIdle(); // 回执已由 onChange 打印；徽标行 + 提示符在此补上
        return;
      }
      if (key.name === 'escape' && ctx.pendingSuggestion) {
        ctx.pendingSuggestion = null;
        ctx.renderer.writeLine(ctx.renderer.color('（已取消命令建议）', 'gray'));
        linePromptIdle();
      }
    });
  } catch {}

  // Main input loop (line mode over SSE transport)
  let pendingPaste: string | null = null; // folded paste awaiting Enter
  linePromptIdle();

  rl.on('line', async (line) => {
    // 审批挂起期间主 readline 虽被暂停仍会消费同一 stdin——
    // 用户答 'y'/'n'/指导语会同时触发这里的 'line'。直接丢弃，防幽灵任务排队。
    if (isApprovalActive()) return;
    const trimmed = line.trim();
    if (!trimmed) {
      // 任务运行中（readline 已恢复消费输入）不打印提示符，避免污染流式输出
      if (isRunning(ctx)) return;
      if (pendingPaste !== null) {
        // 折叠粘贴的第二次回车 = 提交
        const submit = pendingPaste;
        pendingPaste = null;
        linePromptIdle();
        await controller.handleLine(submit, undefined);
        return;
      }
      if (ctx.pendingSuggestion) {
        // 回车确认执行建议命令（先过本地命令注册防自指；处理逻辑在 CommandRouter）。
        await confirmPendingSuggestion(ctx, (t) => controller.runTask(t));
        if (!isRunning(ctx)) linePromptIdle();
        return;
      }
      // 空输入回车给灰字引导（原来是静默重出提示符）
      ctx.renderer.writeLine(ctx.renderer.color('输入任务描述，或 ? 看快捷帮助', 'gray'));
      linePromptIdle();
      return;
    }
    if (ctx.pendingSuggestion) ctx.pendingSuggestion = null; // 其他输入 = 取消建议，按原样处理

    // while a task is running, submissions are queued/steered instead.
    if (isRunning(ctx)) {
      await controller.handleLine(trimmed, undefined);
      // 任务结束时 finally 会统一恢复提示符
      return;
    }

    // paste guard (line mode) — large pastes fold and need a second
    // Enter to confirm (Esc-free simplification per instruction).
    const { detectPaste } = await import('./PasteGuard.js');
    const pasteInfo = detectPaste(line);
    if (pasteInfo.isPaste && pendingPaste === null) {
      pendingPaste = line;
      ctx.renderer.writeLine(ctx.renderer.color(`[粘贴 ${pasteInfo.lines} 行，已折叠；回车提交，Esc/输入其它内容取消]`, 'yellow'));
      linePromptIdle();
      return;
    }
    if (pendingPaste !== null) {
      // Any other input cancels the pending paste and is processed normally
      pendingPaste = null;
    }

    const isLocal = await handleLocalCommand(ctx, trimmed);
    if (isLocal) {
      linePromptIdle();
      return;
    }

    if (trimmed.startsWith('/')) {
      // 派发器本地命令（/mode /model /usage /tier …）多为早退分支、不经过
      // runTaskViaSse 的 finally — 这里统一恢复提示符。
      // （与斜杠菜单 Enter 共用 dispatchSlashCommand 等价路径。）
      await dispatchSlashCommand(trimmed);
      return;
    }

    // Use the unified runner (no bridge → line renderer path).
    // The runner's finally restores the prompt via ctx.lineSetPrompt/ctx.lineRl.
    await controller.runTask(trimmed);
  });
}

// Also export a thin wrapper so cli.ts can call it cleanly
export async function startDefaultSseCli() {
  return startSseInteractive();
}
