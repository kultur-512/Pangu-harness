// src/server/runAgentTask.ts
// Core task runner shared by:
// - the embedded SSE agent server (agentServer.ts forwards events over HTTP)
// - the default interactive CLI (sseInteractive.ts consumes events in-process)
//
// Reuses the same PanshalachChaser + PromptBuilder path as the REPL.
// This module is transport-agnostic and MUST stay console-silent.

import { Session } from '../cli/repl/Session.js';
import { PromptBuilder } from '../cli/repl/PromptBuilder.js';
import { TierRegistry } from '../tiers/TierConfig.js';
import { resolveSharedClient } from '../cli/repl/ModelProvider.js';
import { appendContextSnapshot, appendAgentEvent, readAgentEvents } from '../cli/repl/rolloutStore.js';
import { createHash, randomUUID } from 'node:crypto';
import type { ModelProvider } from '../cli/repl/types.js';
import { classifyTaskIntent } from '../cli/taskIntent.js';
import { extractChangedFiles, extractVerifyCommands } from '../loop/trajectory.js';
// 写集提取器单一实现（S 级缺陷修复：卡片 referencedFiles 断链）——refine 与
// 本模块共用；此处再导出保持既有测试/调用方的 import 路径不变。
import { extractWrittenFilePaths, normalizeRelPath } from '../memory/trajectoryFiles.js';
export { extractWrittenFilePaths } from '../memory/trajectoryFiles.js';

export interface RunRequest {
  task: string;
  tier?: string;
  workspace?: string;
  model?: string;
  simulate?: boolean;
  /**
   * B2 (review defect): when the caller already holds a Session (interactive
   * REPL with turns / tier / workspace / approval state), pass it here so the
   * task runs against THAT state — "最近 N 轮上下文" and /tier /workspace
   * actually take effect on the default path. When absent, a fresh Session is
   * built from the flat fields (server / headless compatibility).
   */
  session?: Session;
  /** Optional stable task identifier for TaskState/event correlation. */
  taskId?: string;
}

export interface RunResult {
  success: boolean;
  stopReason?: string;
  durationMs?: number;
  error?: string;
  budgetReport?: any;
  /** aborted 时本步已流出的模型正文（部分结果，宿主落 turn 用）。 */
  partialText?: string;
  /**
   * R1（0.8.1）：chat 直答 / loop answered 的模型正文（取轨迹末步 result）。
   * 三端（line/rich/headless）呈现与 turn 落盘的唯一正文通道——此前
   * RunResult 无此字段，宿主读不存在的 bestTrajectory → 正文三端不可见。
   */
  answerText?: string;
  /** R3: 变更文件集（从 trajectory 步骤提取） */
  changedFiles?: string[];
  /** R3: 验证命令（从 trajectory bash 步骤提取） */
  verifyCmd?: string[];
  /**
   * 本任务触发过溢出截断重试（loop context_overflow → trim → retry）。
   * 评测 A 档的机器可读正源——RunCommand 打 `[ctx] contextOverflowCompacted=1`
   * 证据行，run-eval 据此判"真溢出"，替代易误判的 stdout 正则。
   */
  contextOverflowCompacted?: boolean;
  /** 0.8.2 证据链：本任务实际注入的记忆卡号（lastBuildMeta 透出；headless 宿主打印证据行用） */
  injectedCardIds?: string[];
}

// 窗口解析收口到共享模块 ./cli/repl/tokenEstimate.ts（UI 计量 / loop 预算 /
// runAgentTask 三处必须同源，否则 UI 压缩阈值与 loop 裁剪预算会分叉）；
// 此处再导出保持既有测试/调用方的 import 路径不变。
import { resolveWindowTokens } from '../cli/repl/tokenEstimate.js';
export { resolveWindowTokens };

// ==================== 【1】chat 直答的最近对话段（2026-09-13 迭代包） ====================

/** 最近对话段长度自限（chat user 净荷纪律：记忆块 + 本段 + 用户原话）。 */
export const CHAT_RECENT_TURNS_MAX_CHARS = 600;

/**
 * 从 session 组装 chat 直答用的【最近对话】段：最近 2 轮 userInput+answerText。
 * 背景：chat 直答模型此前看不到最近对话原文——【最近上下文】块只在被 chat
 * 丢弃的 enriched 里，指代型追问（"那第二个呢"）零上下文硬答。
 * 预算策略：新轮优先（从最新轮往回装），预算耗尽时旧轮整轮让位——指代型
 * 追问依赖的恰是尾部；超限的行尾截断加 '…'。空段返回 ''（调用方不拼段）。
 * 返回形态：`【最近对话】\n用户：…\n助手：…\n用户：…`（整段 ≤ maxChars 字符）。
 */
export function buildChatRecentTurnsBlock(
  session: Pick<Session, 'turns'>,
  maxChars = CHAT_RECENT_TURNS_MAX_CHARS
): string {
  const header = '【最近对话】';
  // 窗口常量与 PromptBuilder.buildMemoryQueryText 同源（RECENT_TURN_WINDOW=2）
  const turns = (session?.turns ?? []).slice(-2);
  const picked: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t: any = turns[i];
    const u = String(t?.userInput ?? '').replace(/\s+/g, ' ').trim();
    const a = String(t?.result?.answerText ?? '').replace(/\s+/g, ' ').trim();
    if (!u && !a) continue;
    const line = u && a ? `用户：${u}\n助手：${a}` : `用户：${u || a}`;
    const remain = maxChars - header.length - 1 - used; // -1 = 首个 '\n'
    if (remain <= 10) break; // 残余预算装不下有意义的行 → 停（旧轮让位）
    const piece = line.length > remain ? line.slice(0, remain - 1).trimEnd() + '…' : line;
    if (!piece.trim()) break;
    picked.unshift(piece); // 从最新往回收集，unshift 还原时间正序
    used += piece.length + 1; // +1 = 行间 '\n'（末行多记 1，做安全裕量）
  }
  if (picked.length === 0) return '';
  return `${header}\n${picked.join('\n')}`;
}

/**
 * Run a task and emit progress events through onEvent.
 * Events emitted (best effort, engine-dependent):
 *   phase / step / critique / softLimit / degradation / progress / result / error
 */
export async function runAgentTask(
  req: RunRequest,
  ctx: {
    provider?: ModelProvider;
    onEvent: (event: any) => void;
    signal?: AbortSignal;
    // 审批透传（rich ConfirmBar / line readline / headless）。
    // 返回放宽为 string：line 桥可返回 `n:<指导语>`。
    approvalMode?: 'readonly' | 'default' | 'full';
    sessionAllowlist?: Set<string>;
    approvalBridge?: (req: { tool: string; description: string; danger: boolean }) => Promise<string>;
    approvalTimeoutMs?: number;
    planMode?: boolean;
    mcpTools?: any[];
    /** 溢出回调透传（宿主注册会话级应急压缩；headless 缺省不注册）。 */
    onContextOverflow?: (info: { error: unknown }) => void | Promise<void>;
  }
): Promise<RunResult> {
  const start = Date.now();

  // reuse the caller's Session when provided (turns / tier / workspace /
  // model / approval state all live there); otherwise build a fresh one from
  // the flat fields (server / headless paths stay compatible).
  const session = req.session ?? new Session();
  if (!req.session) {
    if (req.tier) session.tier = TierRegistry.normalize(req.tier as string);
    if (req.workspace) session.workspace = req.workspace;
    if (req.model) session.model = req.model;
  }
  // PANSHA_TASK_ID env var allows external runners (e.g. R6 eval) to supply a
  // stable, correlation-friendly taskId without touching the RunRequest schema.
  const envTaskId = process.env.PANSHA_TASK_ID?.trim();
  session.currentTaskId = req.taskId ?? envTaskId ?? session.currentTaskId ?? `task-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

  // U2: explicit task requirement event; never infer events from model text.
  appendAgentEvent(session.id, {
    id: `evt-${randomUUID()}`,
    ts: Date.now(),
    kind: 'requirement',
    topic: 'task',
    summary: req.task.slice(0, 120),
    sessionId: session.id,
    taskId: session.currentTaskId,
  });

  // Create the control-plane state before PromptBuilder runs so the first
  // prompt can carry the task anchor. Existing state is preserved on resume.
  try {
    const { TaskStateStore } = await import('../memory/taskState.js');
    const taskStore = new TaskStateStore(session.workspace, process.env.PANSHA_TASK_STATE_FILE?.trim() || undefined);
    if (!taskStore.get(session.currentTaskId)) {
      taskStore.create(session.currentTaskId, req.task);
    }
  } catch {
    // State persistence is best-effort; the task itself must still run.
  }

  // 进程级共享实例上的分层 provider 解析。
  // Explicit provider (caller) → shared provider → one hot-reload retry.
  // Keeps /model hot state and .panshalach.json discovery consistent with the REPL.
  const { client } = await resolveSharedClient(session.model, ctx.provider);

  const { PanshalachChaser } = await import('../PanshalachChaser.js');
  const chaser = new PanshalachChaser(client, session.tier);

  const tierConfig = TierRegistry.get(session.tier);
  const pb = new PromptBuilder(session, tierConfig);
  // 意图分类前移——对【原始输入】分类，而不是等 chaser 在富化文本上
  // 兜底分类（富化文本必含 bash 等执行词 → chat/search 恒不可达的死代码）。
  // PANSHA_INTENT_GATE=0 语义保持：gate 关闭时 classifyTaskIntent 恒返回 'execution'，
  // 与旧行为完全一致（逃生门不需要入口特判）。
  const intent = classifyTaskIntent(req.task);
  const enriched = await pb.buildForTask(req.task, intent);

  // 接口契约 v3：逐任务 ContextSnapshot + memory_injected 事件（注入审计账本）。
  // 评测由此回答"模型当时到底看见了什么"；lastBuildMeta 在此消费（不改变 buildForTask 的 string 返回契约）。
  // 供 finalizeTaskMemory 消费的注入卡账本。
  let injectedCardIds: string[] = [];
  // 包C 缺陷8：作用域内长命记忆实例——旧实现 `new RefinedMemoryStore(...).markInjected(...)`
  // 实例即弃（账本只写不读还每步重例化）。现挂到本作用域唯一实例上（账本已升级
  // 进程级，跨实例可读；实例复用消除逐任务重例化），finalizeTaskMemory 复用同一实例。
  let auditMemoryStore: import('../memory/RefinedMemoryStore.js').RefinedMemoryStore | null = null;
  try {
    const meta = pb.lastBuildMeta;
    const injected = meta?.injectedCardIds ?? [];
    injectedCardIds = injected;
    appendContextSnapshot(session.id, {
      model: session.model,
      memoryCardCount: meta?.memoryCardCount ?? 0,
      overflowCount: meta?.memoryOverflowCount ?? 0,
      injectedCardIds: injected,
      promptChars: enriched.length,
      promptHash: createHash('sha1').update(enriched).digest('hex').slice(0, 12),
    });
    if (injected.length > 0) {
      // 双账本对齐：事件账本（HOME rollout）+ 卡账本（工作区 store，纯内存记账）
      try {
        const { RefinedMemoryStore } = await import('../memory/RefinedMemoryStore.js');
        if (session.workspace) {
          auditMemoryStore ??= new RefinedMemoryStore(session.workspace);
          auditMemoryStore.markInjected(injected);
        }
      } catch {}
      appendAgentEvent(session.id, {
        id: 'evt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        ts: Date.now(),
        kind: 'memory_injected',
        topic: 'injection',
        summary: `本次任务注入 ${injected.length} 张记忆卡`,
        refs: injected,
        sessionId: session.id,
        taskId: session.currentTaskId,
      });
    }
  } catch {} // 审计账本 best-effort，绝不阻塞任务

  // F3（0.8.1 第 2 轮）：chat 直答不发 explore 相位——真机实测 `── 侦察 ──`
  // 相位线是 rollout 语义噪声，chat 直答应只见正文流 + 终态行。intent 在入口
  // 已对原始输入分类（与传入 chaser 的 intent 同源），此处直接按其门控。
  if (intent !== 'chat') ctx.onEvent({ type: 'phase', phase: 'explore' });

  let success = false;

  try {
    // 0.8.2 chat 净化（真机 1B 元话语根因修复）：chat 直答的 user 必须是
    // "记忆块 + 用户原话"，绝不能是整段 enriched（stable 外壳 + 结构块会把
    // 1B 拖回工程框架、记忆卡与当前输入混淆）。记忆块由宿主从 lastBuildMeta
    // 侧通道传出，任务原文原样传 chaser。
    const solveIssueInput = intent === 'chat' ? req.task : enriched;
    const chatMemoryBlock = intent === 'chat' ? pb.getChatMemoryBlock() : undefined;
    // 【1】chat 直答补最近对话原文：session 最近 2 轮原文组装 ≤600 字符段传入
    //（记忆块之后的第二段——chaser 拿不到 session.turns，由宿主组装）。
    const chatRecentTurns = intent === 'chat' ? buildChatRecentTurnsBlock(session) : undefined;
    const result = await chaser.solveIssue(solveIssueInput, session.workspace, {
      tier: session.tier as any,
      yes: true,
      dryRun: !!req.simulate,
      memoryPreInjected: true,
      // 0.8.2：chat 直答的独立记忆块（与原文分离——chaser 组装干净 user）
      chatMemoryBlock,
      // 【1】chat 直答的最近对话段（拼在记忆块之后、用户原话之前）
      chatRecentTurns,
      // 入口前移的意图显式传入（chaser 不再对富化文本兜底分类）
      intent,
      // 审批透传
      approvalMode: ctx.approvalMode ?? 'readonly',
      sessionAllowlist: ctx.sessionAllowlist,
      approvalBridge: ctx.approvalBridge,
      approvalTimeoutMs: ctx.approvalTimeoutMs,
      planMode: ctx.planMode,
      mcpTools: ctx.mcpTools,
      signal: ctx.signal,
      // 窗口预算挂真值（provider 真实窗口，unknown → 32768 保守值）
      windowTokens: resolveWindowTokens(ctx.provider ?? (session as any).provider, session.model),
      // C5：溢出回调透传（宿主可注册会话级应急压缩；headless 无宿主时缺省）
      onContextOverflow: (ctx as any).onContextOverflow,
      onStep: (event: any) => {
        if (ctx.signal?.aborted) return;
        ctx.onEvent(event);
        if (event.type === 'step' && typeof event.stepNumber === 'number') {
          // convenience normalized event
          ctx.onEvent({ type: 'progress', step: event.stepNumber });
        }
      },
    });

    success = !!result.success;

    // U2: record only the explicit terminal signal from the engine.
    appendAgentEvent(session.id, {
      id: `evt-${randomUUID()}`,
      ts: Date.now(),
      kind: result.bestTrajectory?.stopReason === 'completed' ? 'verified' : 'failure',
      topic: result.bestTrajectory?.stopReason === 'completed' ? 'verification' : 'task',
      summary: result.bestTrajectory?.stopReason === 'completed'
        ? '任务通过真实验证'
        : `任务未完成：${result.bestTrajectory?.stopReason ?? result.error ?? 'unknown'}`.slice(0, 120),
      sessionId: session.id,
      taskId: session.currentTaskId,
      refs: result.bestTrajectory?.stopReason === 'completed'
        ? extractChangedFiles(result.bestTrajectory?.steps ?? [])
        : undefined,
    });

    try {
      const { TaskStateStore } = await import('../memory/taskState.js');
      const stateStore = new TaskStateStore(session.workspace, process.env.PANSHA_TASK_STATE_FILE?.trim() || undefined);
      // Fold the same explicit terminal event into the control-plane state.
      // The event ledger remains the source of truth; folding is best-effort.
      const events = readAgentEvents(session.id)
        .filter((e) => e.taskId === session.currentTaskId)
        .slice(-1);
      if (events.length > 0) stateStore.applyEvents(session.currentTaskId, events);
    } catch {
      // A state-fold failure must not change the task result.
    }

    // 记忆落定（单一落定点）——仅 completed（真实验证通过）触发
    // refine→save 产卡 + 注入卡∩写集 markVerified。best-effort：记忆失败绝不
    // 影响任务成功返回（本模块 console-silent，错误以事件透出）。
    try {
      // 包C 缺陷8：复用作用域内长命实例（markInjected 与 refine/markVerified 同一实例）
      await finalizeTaskMemory(session, result, injectedCardIds, ctx.onEvent, req.task, start, auditMemoryStore ?? undefined);
    } catch (memErr: any) {
      ctx.onEvent({ type: 'memory.finalized', ok: false, error: memErr?.message || String(memErr) });
    }

    // 任务结束、记忆落定后：best-effort 触发任务状态归档（陈旧 >7 天 / 活跃 >200
    // 的任务移入 <主文件>.archive.json）。任何异常都不影响任务成功返回。
    try {
      const { TaskStateStore } = await import('../memory/taskState.js');
      const ts = new TaskStateStore(session.workspace, process.env.PANSHA_TASK_STATE_FILE?.trim() || undefined);
      ts.archive();
    } catch {}

    // R3: 从 trajectory 提取结构化字段（供宿主落 Turn.result）
    const trajSteps = result.bestTrajectory?.steps ?? [];
    const changedFiles = extractChangedFiles(trajSteps);
    const verifyCmd = extractVerifyCommands(trajSteps);

    // aborted 时把已流出正文带给宿主（sseInteractive/Repl 落 turn）
    const partialText = result.bestTrajectory?.partialText as string | undefined;

    // R1（0.8.1）：answered 正文带出——chat 直答正文在轨迹末步 result 里，
    // 此前 RunResult 不携带 → TurnController/RunCommand 三端全部拿不到正文。
    const lastStepResult = trajSteps.length > 0
      ? String(trajSteps[trajSteps.length - 1]?.result ?? '')
      : '';
    const answerText = result.bestTrajectory?.stopReason === 'answered' && lastStepResult.trim()
      ? lastStepResult
      : undefined;

    // 对话事实记忆（0.8.2）：chat 直答完成后确定性沉淀"用户说了什么 + 答复要点"。
    // 此前产卡门只认 completed（工程任务）——纯对话的事实永远不入记忆，
    // 跨会话个人化（LongMemEval 场景）结构性失忆。best-effort：绝不影响对话。
    if (intent === 'chat' && answerText) {
      try {
        const { recordChatFact } = await import('../memory/chatFactMemory.js');
        await recordChatFact(session.workspace, req.task, answerText);
      } catch { /* 记忆沉淀失败不影响对话 */ }
    }

    ctx.onEvent({
      type: 'result',
      success,
      stopReason: result.bestTrajectory?.stopReason,
      budgetReport: result.budgetReport,
      changedFiles,
      verifyCmd,
      ...(partialText ? { partialText } : {}),
      ...(answerText ? { answerText } : {}),
    });

    return {
      success,
      stopReason: result.bestTrajectory?.stopReason,
      durationMs: Date.now() - start,
      budgetReport: result.budgetReport,
      changedFiles,
      verifyCmd,
      contextOverflowCompacted: (result as any).contextOverflowCompacted === true,
      // 0.8.2 证据链透出：headless/one-shot 宿主（RunCommand/eval runner）可从此
      // 读取逐任务注入账本——此前注入审计只在 rollout context 事件里，stdout 不可见。
      injectedCardIds,
      ...(partialText ? { partialText } : {}),
      ...(answerText ? { answerText } : {}),
    };
  } catch (err: any) {
    // 深层错误（如 Maximum call stack size exceeded）必须留堆栈证据——
    // stderr 全量 + 事件携带截断堆栈，否则"管路中断"类问题无法定位。
    const stack = String(err?.stack || '');
    try { console.error('[zhulong:error:stack]', stack.slice(0, 3000)); } catch {}
    ctx.onEvent({ type: 'error', message: err?.message || String(err), stack: stack.slice(0, 2000) });
    return {
      success: false,
      error: err?.message || String(err),
      durationMs: Date.now() - start,
    };
  }
}

// ==================== 记忆落定（R1/R2 最小闭环） ====================

/**
 * 任务边界记忆落定（单一落定点）：
 * - R1：仅 stopReason==='completed'（真实验证通过）→ RefinedMemoryStore.refine
 *   （单 rollout，attemptCount=1——runMultiple 已摘除、本路径恒单次求解，
 *   1 即真实 attemptCount）→ save() 持久化。answered（纯问答）不产卡。
 *   写集与任务原文由本调用方传入（共享提取器 extractWrittenFilePaths），
 *   供产卡 referencedFiles / summary 任务信息 / keywords 使用。
 * - R2：lastBuildMeta.injectedCardIds 与本次轨迹写入文件集有交集的卡 →
 *   markVerified 刷新 lastUsedAt/count（接口契约 v3 二态之二：机器判定的真实使用）。
 *   excludeCreatedAfter=start：本轮新建的卡不 markVerified（防"创建即自验证"）。
 * - 轻量事件 memory.finalized { cards, verified }（消费方：SSE/rich 前端，未知
 *   事件类型走 pushFeed 兜底，安全）。
 * 调用方已 try/catch 包裹：任何异常不影响任务成功返回。
 */
export async function finalizeTaskMemory(
  session: Session,
  result: { bestTrajectory?: any },
  injectedCardIds: string[],
  onEvent: (event: any) => void,
  taskText?: string,
  startedAt = Date.now(),
  // 包C 缺陷8：可选复用调用方作用域内的长命实例（runAgentTask 传入）；
  // 缺省时照旧自建（Repl.ts 等既有调用方零改动）。
  reuseStore?: import('../memory/RefinedMemoryStore.js').RefinedMemoryStore
): Promise<void> {
  const traj = result?.bestTrajectory;
  if (!traj || traj.stopReason !== 'completed' || !session.workspace) return;

  const { RefinedMemoryStore } = await import('../memory/RefinedMemoryStore.js');
  const store = reuseStore ?? new RefinedMemoryStore(session.workspace);
  const writtenFiles = extractWrittenFilePaths(traj);

  // R1：completed = 真实验证通过 → 提炼 success 卡并持久化（触发红线：写盘
  // 成功 ≠ 任务成功——此处任务已真实验证通过，方向安全）。
  const cards = store.refine({
    trajectory: traj,
    taskStyle: traj.taskStyle ?? 'all',
    // 提炼卡为全档通用（空 applicableTiers = 全档可见），不绑定产出档位——
    // 否则某档学会的工程教训在其它档不可见，违背"记忆召回不随档位降级"。
    attemptCount: 1, // 本路径恒单 rollout（runMultiple 已摘除），1 即真实值
    writtenFiles,
    taskText,
  });
  if (cards.length > 0) store.save(cards);

  // R2：注入卡 ∩ 本次写入文件集 → markVerified（衰减语义中唯一的保鲜通道）。
  // excludeCreatedAfter=startedAt：本任务时间窗内新建的卡不算"真实复用"。
  const written = new Set(writtenFiles.map(normalizeRelPath));
  const verifiedIds = (written.size === 0 || injectedCardIds.length === 0)
    ? []
    : store.load().cards
        .filter((c) => injectedCardIds.includes(c.id))
        .filter((c) => (((c as any).referencedFiles ?? []) as string[])
          .some((r) => written.has(normalizeRelPath(r))))
        .map((c) => c.id);
  if (verifiedIds.length > 0) store.markVerified(verifiedIds, Date.now(), { excludeCreatedAfter: startedAt });

  onEvent({ type: 'memory.finalized', cards: cards.length, verified: verifiedIds.length });
}

// 写集提取器（extractWrittenFilePaths / extractShellWriteTargets / normalizeRelPath）
// 已收敛到共享模块 src/memory/trajectoryFiles.ts——RefinedMemoryStore.refine 与本
// 模块共用单一实现；本文件经顶部 import + re-export 保持既有 import 路径不变。
