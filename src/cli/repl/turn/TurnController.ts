// src/cli/repl/turn/TurnController.ts
// M1-TurnController（0.8 第 2 步，四模块搬家）：任务执行主体模块。
// runTaskViaSse 主体（任务提交/审批桥/事件分发/中断/排队 drain/turn 落盘/gerund）+
// handleUserLine（运行态输入路由）+ createTurnController 工厂。
// 依赖纪律：依赖 turn/TurnContext、turn/TurnRenderer、turn/CommandRouter（单向，无环）。

import { createCliApprovalBridge, isApprovalActive } from '../../../tools/approval.js';
import * as rollout from '../rolloutStore.js';
import { classifyRunningInput, formatSteerInjection } from '../InputQueue.js';
import { mapOutcome } from '../../../loop/trajectory.js';
import type { TurnContext } from './TurnContext.js';
import {
  bumpCtx,
  clearInlineLine,
  emitFeed,
  isRunning,
  recordOutput,
  resolveCtxWindowTokens,
  runSyncCompact,
  updateQueueCount,
} from './TurnContext.js';
import {
  ANSI_DIM,
  ANSI_RESET,
  buildIdleStatusLine,
  endMessageStream,
  mapSseToBridge,
  renderInlineMarkdown,
  renderSseEvent,
  spinnerRunningLine,
  spinnerToolLine,
} from './TurnRenderer.js';
import { createCommandEmitter, handleEditPrefill, handleSlashCommand } from './CommandRouter.js';

/** MCP stdio servers from .panshalach.json mcpServers (append-only config).
 *  Clients spawn lazily at first task; closed on process exit (hang discipline). */
async function initMcpServers(ctx: TurnContext): Promise<void> {
  if (ctx.mcpInitDone) return;
  ctx.mcpInitDone = true;
  try {
    const { ConfigManager } = await import('../ConfigManager.js');
    const cfg: any = (new ConfigManager(ctx.session.workspace || process.cwd())).getAll?.() ?? {};
    const servers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> =
      (cfg as any).mcpServers || {};
    const { McpClient } = await import('../../../tools/mcpClient.js');
    for (const [name, s] of Object.entries(servers)) {
      if (!s?.command) continue;
      try {
        const client = new McpClient({ command: s.command, args: s.args || [], env: s.env });
        await client.initialize();
        const tools = await client.listTools();
        ctx.mcpClients.set(name, client);
        for (const t of tools) {
          ctx.mcpToolsReady.push({
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

/**
 * route a user line according to running state.
 * - idle:   normal task flow
 * - running: '/' → immediate local command; '!' → steer; else → queued task
 */
export async function handleUserLine(ctx: TurnContext, text: string, bridge?: any) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;

  if (!isRunning(ctx)) {
    await runTaskViaSse(ctx, trimmed, bridge);
    return;
  }

  const routed = classifyRunningInput(trimmed);
  if (routed.kind === 'command') {
    // slash commands execute immediately, never queued
    await runTaskViaSse(ctx, routed.payload, bridge);
    return;
  }
  if (routed.kind === 'steer') {
    if (!routed.payload) return;
    ctx.queue.enqueueSteer(routed.payload);
    emitFeed(ctx, `steered ×${ctx.queue.steerCount}（下一轮注入）：${routed.payload}`, 'info');
  } else {
    ctx.queue.enqueueTask(routed.payload);
    emitFeed(ctx, `queued ×${ctx.queue.taskCount}：${routed.payload}`, 'info');
  }
  updateQueueCount(ctx);
}

export async function runTaskViaSse(ctx: TurnContext, task: string, bridge?: any) {
  if (!task || !task.trim()) return;

  const trimmed = task.trim();
  const useRich = !!bridge;

  // Unified /edit (P1): pull last significant output back into input for edit/resubmit.
  if (trimmed === '/edit' || trimmed === '/e') {
    await handleEditPrefill(ctx, useRich, bridge);
    return;
  }

  // local commands shared by rich + line paths
  // (/undo now; /approvals + /usage + /compact land with their batches)
  if (trimmed.startsWith('/')) {
    const sp = trimmed.indexOf(' ');
    const cmd = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
    const arg = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
    const handled = await handleSlashCommand(ctx, {
      cmd,
      arg,
      emit: createCommandEmitter(ctx, useRich, bridge),
      useRich,
      bridge,
    });
    if (handled) return;
  }

  // auto-compact pre-flight (CC-style) — background-first, applied at
  // task boundary, never blocks input. Sync fallback only when critical.
  {
    const ratioNow = Math.min(1, (ctx.ctxUsedChars / 4) / ctx.ctxWindowTokens);
    const cs = await import('../compactService.js');
    if (cs.shouldAutoCompact(ctx.session, ratioNow)) {
      const { resolveSharedClient } = await import('../ModelProvider.js');
      let client: any = null;
      try { client = (await resolveSharedClient(ctx.session.model, ctx.provider as any)).client; } catch {}

      // A ready background result → apply with zero wait
      if (ctx.bgCompact && ctx.bgCompact.isReady()) {
        const res = ctx.bgCompact.result();
        ctx.bgCompact = null;
        if (res && res.ok) {
          const applied = cs.applyCompactResult(ctx.session, res);
          ctx.ctxUsedChars = cs.estimateSessionTokens(ctx.session) * 4;
          const msg = `${applied.message}`;
          // 拒绝/失败以 warn 呈现（盘故障不该与普通回执同级）
          if (!applied.ok) {
            if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: msg, level: 'warn' });
            else ctx.renderer.warn(msg);
          } else {
            if (useRich && typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: msg, level: 'info' });
            else ctx.renderer.info(msg);
          }
          if (useRich && typeof bridge.setTop === 'function') {
            const nr = Math.min(1, (ctx.ctxUsedChars / 4) / ctx.ctxWindowTokens);
            try { bridge.setTop({ ctxRatio: nr }); } catch {}
          }
        }
      } else if (!ctx.bgCompact) {
        // Nothing running yet → kick off a background compaction (non-blocking).
        const h = cs.startBackgroundCompact(ctx.session, client);
        if (h) {
          ctx.bgCompact = h;
          emitFeed(ctx, '⏳ 已在后台预压缩历史（阈值为 ≥85% 上下文）……', 'warn');
        } else if (ratioNow >= 0.95) {
          // Critical: stream is about to blow up — do a sync fallback.
          // unified via runSyncCompact (feedback + meter reset)
          await runSyncCompact(ctx, '⏳ auto-compact 同步兜底：');
        }
      }
    }
  }

  // steering injection — unconsumed steers join THIS round's prompt,
  // then are consumed immediately (injected ones cannot be recalled).
  const pendingSteers = ctx.queue.consumeSteers();
  if (pendingSteers.length > 0) {
    task = task + formatSteerInjection(pendingSteers);
    ctx.lastInjectedSteers = pendingSteers;
    emitFeed(ctx, `本轮已注入 ${pendingSteers.length} 条插话`, 'info');
    updateQueueCount(ctx);
  }

  if (!useRich) {
    ctx.renderer.writeLine(ctx.renderer.color(`\n[提交任务] ${task.split('\n\n【用户插话')[0]}`, 'cyan'));
  } else if (typeof bridge.setRunning === 'function') {
    try { bridge.setRunning(true); } catch {}
    ctx.runningBadgeOn = true;
  }

  // Abort support: signal 贯穿 solveIssue → loop → 模型 fetch / 工具执行，
  // 中断时 runPromise 以 stopReason='aborted' 正常 settle（见下方 else 分支）。
  // 0.7.4 B6：移除永不 settle 的 abortPromise 死代码——abortReject 从未被调用，
  // Promise.race 的 aborted 分支不可达（真中断由 SIGINT → currentAbort.abort() →
  // loop signal 检查 → stopReason='aborted' 链路承担）。
  const controller = new AbortController();
  ctx.currentAbort = controller;
  ctx.lastAborted = false;

  const startedAt = Date.now();
  // 任务边界重取当前模型真实窗口（/model 切换后立即生效）
  ctx.ctxWindowTokens = resolveCtxWindowTokens(ctx);
  // 任务边界重置 line 模式流式/卡片状态
  ctx.lineUi.taskStartedAt = startedAt;
  ctx.lineUi.taskEndedAt = 0;
  ctx.lineUi.ghostIgnored = false;
  ctx.lineUi.stepCount = 0;
  ctx.lineUi.streamedAnswerChars = 0;
  ctx.lineUi.thinkingStart = 0;
  ctx.lineUi.thinkingBuf = '';
  ctx.lineUi.thinkingPrinted = false;
  ctx.lineUi.messageStreaming = false;
  ctx.lineUi.messageBuf = '';
  ctx.lineUi.toolStack = [];
  ctx.lineUi.pendingTool = null;
  // gerund interval handle (declared here so the finally can clear it)
  let gerundTimer: NodeJS.Timeout | null = null;
  // new task boundary — settle previous rollouts, start a fresh clock
  ctx.agentTree.markAll('running', 'done');
  ctx.treeTaskStart = startedAt;

  try {
    // ensure MCP servers are initialized (lazy, once) before the run
    await initMcpServers(ctx);
    const { runAgentTask } = ctx.loadRunAgentTask
      ? await ctx.loadRunAgentTask()
      : await import('../../../server/runAgentTask.js');

    // real approval bridges.
    // - rich path → bridge.setConfirm(request) → ConfirmBar (y/n/a/Esc)
    // - line path → readline question bridge (60s silence → n)
    const approvalBridge = useRich
      ? (req: { tool: string; description: string; danger: boolean }) =>
          (ctx.bridgeRef.current.setConfirm(req) as Promise<'y' | 'n' | 'a'>)
      : createCliApprovalBridge();

    // 主 readline 不再全程 pause（那样会让任务运行中的 Ctrl+C
    // 无人接、输入缓冲成幽灵 ^C）。stdin 所有权只在审批 question 挂起时
    // 经 setApprovalActivityListener（line 段注册）临时交接。

    // gerund running label — line-mode spinner（0.8 UI 对齐 U1：120ms 字符帧动画）。
    // Timer unref'd (non-deadline timers must not hold the
    // process) and always cleared in the finally below.
    // 重绘统一走本函数（清活行 → 原地写 → 记 inlineLine）。
    // 审批挂起时暂停；正文流式期间暂停；thinking 活行让路。
    // 动词每 4s 换一个（gerundBucket 轮换），帧动画 120ms 不停；
    // reducedMotion / 非 TTY（progress=false）退化为旧 4s 纯文本刷新。
    if (!useRich) {
      try {
        const {
          nextGerund, formatRunningLabel, nextSpinnerFrame, gerundBucket, spinnerRedrawMs,
        } = await import('../GerundSpinner.js');
        const { getTerminalCapabilities } = await import('../TerminalCapabilities.js');
        const animated = getTerminalCapabilities().progress;
        const gStart = startedAt;
        let curVerb = '';
        let verbBucket = -1;
        const paint = () => {
          // thinking 单行滚动是活行时 gerund 不重绘（避免覆盖思考行抖动）
          if (isApprovalActive() || ctx.lineUi.messageStreaming || ctx.lineUi.inlineLine === 'thinking') return;
          try {
            // 任务运行超 30s → 一次性等待 tip（受全局 ≤2 节流）
            if (Date.now() - gStart > 30000 && ctx.tipGate.canShow('wait')) {
              ctx.tipGate.markShown('wait');
              clearInlineLine(ctx);
              process.stdout.write(`${ANSI_DIM}Tip: 长时间无进展可 Ctrl+C 中断，补充上下文后再试${ANSI_RESET}\n`);
            }
            clearInlineLine(ctx);
            let label: string;
            const pt = ctx.lineUi.pendingTool;
            const elapsed = Date.now() - gStart;
            if (pt && Date.now() - pt.at > 3000) {
              // pre 后 3s 未 post → 进行时工具标签（动画时套帧字符前缀）
              label = animated
                ? spinnerToolLine(nextSpinnerFrame(), pt.doing, pt.summary, elapsed)
                : `${pt.doing} ${pt.summary}… ⏱ ${Math.floor(elapsed / 1000)}s`;
            } else {
              // 帧动画连转；动词按 4s 桶轮换（nextGerund 保持不连抽同词）
              const bucket = gerundBucket(elapsed);
              if (bucket !== verbBucket || !curVerb) {
                curVerb = nextGerund();
                verbBucket = bucket;
              }
              label = animated
                ? spinnerRunningLine(nextSpinnerFrame(), curVerb, elapsed)
                : formatRunningLabel(elapsed, curVerb);
            }
            process.stdout.write('\r' + label + '   ');
            ctx.lineUi.inlineLine = 'gerund';
          } catch {}
        };
        paint();
        gerundTimer = setInterval(paint, spinnerRedrawMs(animated));
        gerundTimer.unref();
      } catch {}
    }

    const runPromise = runAgentTask(
      {
        task,
        // the task must run against the LIVE session state — /tier and
        // /workspace switches take effect immediately, and the session's
        // turns feed "最近 N 轮上下文" on the default path.
        tier: ctx.session.tier,
        workspace: ctx.session.workspace,
        model: ctx.session.model,
        simulate: false,
        session: ctx.session,
      },
      {
        provider: ctx.provider,
        signal: controller.signal,
        approvalMode: ctx.session.approvalMode,
        sessionAllowlist: ctx.session.sessionApprovalAllowlist,
        approvalBridge,
        planMode: ctx.session.planMode,
        mcpTools: ctx.mcpToolsReady,
        onEvent: (ev: any) => {
          if (controller.signal.aborted) return;

          // feed the agent tree from rolloutId-carrying events
          if (ev && (ev.type === 'step' || ev.type === 'critique') && ev.rolloutId) {
            ctx.agentTree.upsert({
              id: String(ev.rolloutId),
              parent: null,
              status: 'running',
              stepCount: Number(ev.stepNumber ?? 1),
              durationMs: ctx.treeTaskStart ? Date.now() - ctx.treeTaskStart : 0,
              lastPhase: ev.type,
            });
          }

          // heuristic context meter (chars/4) from reasoning/plan/result/critique
          if (ev && ev.type === 'step') {
            bumpCtx(ctx, ev.thinking); bumpCtx(ctx, ev.plan);
            bumpCtx(ctx, typeof ev.result === 'string' ? ev.result : '');
            if (Array.isArray(ev.toolCalls)) {
              for (const tc of ev.toolCalls) {
                bumpCtx(ctx, tc?.rawBlock); bumpCtx(ctx, tc?.argsSummary);
              }
            }
            if (useRich && typeof bridge.setTop === 'function') {
              const ratio = Math.min(1, (ctx.ctxUsedChars / 4) / ctx.ctxWindowTokens);
              try { bridge.setTop({ ctxRatio: ratio }); } catch {}
            }
          } else if (ev && ev.type === 'critique') {
            bumpCtx(ctx, ev.critique);
          }

          if (useRich) {
            mapSseToBridge(ev.type || 'event', ev, bridge, ctx);
          } else {
            renderSseEvent(ctx, ev.type || 'event', ev, ctx.renderer);
          }
        },
      }
    );

    // 0.7.4 B6：abortPromise 已删——中断时 runPromise 以 stopReason='aborted'
    // settle，统一走下方 else 分支（三态文案 + partialText 落盘）。
    const raced = { kind: 'done' as const, result: await runPromise };

    // persist the completed turn into the session + rollout jsonl
    // this task's rollouts are done
    ctx.agentTree.markAll('running', 'done');
    {
      const r = raced.result;
      const stopReason = (r as any)?.stopReason;
      // 中断语义保持：aborted 回合阻断排队任务自动执行（用户保留排队项手动重跑）
      if (stopReason === 'aborted') ctx.lastAborted = true;
      // 三态文案：completed→已通过验证；answered→已回复；aborted→已中断；error→执行失败；其余→未通过验证
      const summary = stopReason === 'completed' ? '已通过验证'
        : stopReason === 'answered' ? '已回复'
        : stopReason === 'aborted' ? '已中断'
        : stopReason === 'error' ? '任务执行失败'
        : r?.success ? '已通过验证' : '未通过验证';
      // R1（0.8.1）：正文改读 RunResult.answerText（runAgentTask 从轨迹末步带出）。
      // 旧实现读 (r as any).bestTrajectory——RunResult 无此字段，恒 undefined →
      // chat/answered 正文三端不可见（lock 测试 mock 漂移掩盖成假阴性）。
      const answerText = stopReason === 'answered' ? String((r as any)?.answerText ?? '') : '';
      const turn = {
        id: Date.now().toString(36),
        timestamp: Date.now(),
        userInput: task.split('\n\n【用户插话')[0],
        userInputType: 'task' as const,
        tier: ctx.session.tier,
        durationMs: r?.durationMs ?? (Date.now() - startedAt),
        ...(stopReason === 'aborted' && (r as any)?.partialText ? { partialText: (r as any).partialText } : {}),
        result: {
          success: !!r?.success,
          summary,
          budgetReport: r?.budgetReport as any,
          stopReason,
          goal: task.split('\n\n【用户插话')[0],
          changedFiles: (r as any)?.changedFiles ?? [],
          verifyCmd: (r as any)?.verifyCmd ?? [],
          outcome: mapOutcome(stopReason),
          // R6（0.8.1）：chat 答案落盘（截 400 字符防膨胀；resume/最近上下文可见问答对）
          ...(answerText ? { answerText: answerText.slice(0, 400) } : {}),
        },
      };
      try { ctx.session.addTurn(turn); } catch {}
      try { rollout.appendTurn(ctx.session.id, turn as any); } catch {}
      // answered 时把模型正文呈现给用户（/edit 可取回）
      // 正文已随 message.delta 流式呈现 → 不再贴 600 字截断预览；
      // 仅当流式不可用（provider 无 streamChat，全程 0 字符流式）时兜底输出全文。
      if (answerText) {
        if (useRich && typeof bridge.pushFeed === 'function') {
          bridge.pushFeed({ type: 'markdown', content: answerText });
        } else if (!useRich) {
          // U2（0.8 UI 对齐）：先冲刷行缓冲残段——流式按完整段输出，尾段在此兜底
          // 落屏（含流结束换行）；残段计入 streamedAnswerChars，不冲刷会丢尾段。
          endMessageStream(ctx);
          // 流式不可用（0 字符）输出全文；流式部分送达时补差量，防尾部静默丢失。
          // 0.8.1 UX（改进 3）：整段呈现做轻量 markdown（**粗体** / `行内代码`）；
          // recordOutput 保留原文（/edit 取回不受影响）。
          const rest = answerText.slice(ctx.lineUi.streamedAnswerChars);
          if (rest) {
            ctx.renderer.writeLine(ctx.renderer.color(renderInlineMarkdown(rest), 'white'));
            recordOutput(ctx, rest);
          }
        }
      }
      recordOutput(ctx, summary);
    }
  } catch (err: any) {
    const msg = '任务执行失败: ' + (err?.message || err);
    if (!useRich) ctx.renderer.error(msg);
    else if (typeof bridge.pushFeed === 'function') bridge.pushFeed({ type: 'text', text: msg, level: 'error' });
  } finally {
    ctx.currentAbort = null;
    void startedAt;
    if (gerundTimer) { try { clearInterval(gerundTimer); } catch {} }
    gerundTimer = null;
    // 清活行（gerund/thinking 残留）；正文流式收尾换行
    clearInlineLine(ctx);
    if (ctx.lineUi.messageStreaming) { try { process.stdout.write('\n'); } catch {} }
    ctx.lineUi.messageStreaming = false;
    ctx.lineUi.pendingTool = null;
    ctx.lineUi.toolStack = [];
    // 幽灵 ^C 窗口 — 任务刚结束的 1.5s 内缓冲的 Ctrl+C 只忽略一次
    ctx.lineUi.taskEndedAt = Date.now();
    ctx.lineUi.ghostIgnored = false;
    // 上下文占用 >75% → 一次性 tip（启发式 chars/4 估算，
    // 与 auto-compact 的 ratioNow 同源；受全局 ≤2 节流）
    if (!useRich) {
      const ratio = (ctx.ctxUsedChars / 4) / ctx.ctxWindowTokens;
      if (ratio > 0.75 && ctx.tipGate.canShow('ctx')) {
        ctx.tipGate.markShown('ctx');
        try { ctx.renderer.writeLine(ctx.renderer.color(`Tip: 上下文占用约 ${Math.round(ratio * 100)}% · /compact 可立即压缩`, 'gray')); } catch {}
      }
      // U4（0.8 UI 对齐）：任务结束回到空闲 → 提示符上方一行 dim 状态
      // （`模型短名 · tier · 模式 · ctx ~N%`）。回合边界一次性刷新，非常驻重绘行
      // （避免与清行纪律冲突）；drain 中间轮不打（队列非空即跑下一个任务，
      // 只在真正回到空闲或 aborted 保留队列时打）。
      if (ctx.queue.taskCount === 0 || ctx.lastAborted) {
        try {
          ctx.renderer.writeLine(ctx.renderer.color(buildIdleStatusLine({
            model: ctx.session.model,
            tier: String(ctx.session.tier),
            mode: ctx.modeRing.current,
            ctxUsedChars: ctx.ctxUsedChars,
            ctxWindowTokens: ctx.ctxWindowTokens,
          }), 'gray'));
        } catch {}
      }
    }
    // 兜底复位只在徽标仍处于 true 时执行——result/done/error 事件已复位的
    // 情况下不再重复下发 setRunning(false)（行为锁定断言 [true,false]）。
    if (useRich && ctx.runningBadgeOn !== false && typeof bridge.setRunning === 'function') {
      try { bridge.setRunning(false); } catch {}
    } else {
      // Line path: restore prompt so the user can type the next task.
      if (ctx.lineRl) { try { ctx.lineRl.resume(); } catch {} }
      try { ctx.lineSetPrompt(); } catch {}
      if (ctx.lineRl) { try { ctx.lineRl.prompt(); } catch {} }
    }
  }

  // drain queued tasks once the turn settles (FIFO, one by one).
  // An aborted turn stops the drain — the user keeps the remaining queue.
  // 深度护栏：drain 经 runTaskViaSse 递归重入（排队任务 settle 后再次 drain），
  // 嵌套深度随排队链增长，过深会栈溢出（真机 18 步会话实测）。>8 层即止损，
  // 剩余任务留在队列，用户按一次回车继续（isRunning 已为 false，idle 路径会跑）。
  let drainDepth = 0;
  while (ctx.queue.taskCount > 0 && !ctx.lastAborted && drainDepth < 8) {
    drainDepth++;
    const next = ctx.queue.drainTasks();
    updateQueueCount(ctx);
    for (const t of next) {
      if (ctx.lastAborted) break;
      emitFeed(ctx, `▶ 执行排队任务：${t.slice(0, 80)}`, 'info');
      await runTaskViaSse(ctx, t, bridge);
    }
  }
  if (ctx.queue.taskCount > 0) {
    emitFeed(ctx, `⚠ 仍有 ${ctx.queue.taskCount} 个排队任务未执行（连续任务过多），回车继续`, 'warn');
  }
}

// ==================== TurnController 接线（M1-TurnController） ====================

export interface TurnControllerApi {
  /** 提交任务/命令（runTaskViaSse 入口：斜杠命令本地执行，任务文本走全链）。 */
  runTask: (task: string, bridge?: any) => Promise<void>;
  /** 运行态感知的用户输入路由（idle→任务；running→命令/插话/排队）。 */
  handleLine: (text: string, bridge?: any) => Promise<void>;
  isRunning: () => boolean;
}

export function createTurnController(ctx: TurnContext): TurnControllerApi {
  return {
    runTask: async (task: string, bridge?: any) => { await runTaskViaSse(ctx, task, bridge); },
    handleLine: async (text: string, bridge?: any) => { await handleUserLine(ctx, text, bridge); },
    isRunning: () => isRunning(ctx),
  };
}
