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
}

/**
 * 解析当前模型的上下文窗口（tokens）。
 * 走 provider.getModelContextLength 通道；≤0 或遗留 256000 哨兵视为
 * unknown → 回落 32768 保守值（8K 模型按 256K 预算跑长任务必爆——预算必须挂真值）。
 */
export function resolveWindowTokens(provider: ModelProvider | undefined, model: string): number {
  try {
    // PANSHA_CTX_WINDOW 显式覆盖优先（与 sseInteractive UI 侧同一优先级——
    // env 覆盖时两侧若分叉，UI 压缩阈值与 loop 裁剪预算会不一致）。
    const env = Number(process.env.PANSHA_CTX_WINDOW);
    if (Number.isFinite(env) && env > 0) return env;
    const n = Number((provider as any)?.getModelContextLength?.(model));
    if (Number.isFinite(n) && n > 0 && n !== 256000) return n;
  } catch {}
  return 32768;
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
  }
): Promise<RunResult> {
  const start = Date.now();

  // reuse the caller's Session when provided (turns / tier / workspace /
  // model / approval state all live there); otherwise build a fresh one from
  // the flat fields (server / headless paths stay compatible).
  const session = req.session ?? new Session();
  if (!req.session) {
    if (req.tier) session.tier = req.tier as any;
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
          new RefinedMemoryStore(session.workspace).markInjected(injected);
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

  ctx.onEvent({ type: 'phase', phase: 'explore' });

  let success = false;

  try {
    const result = await chaser.solveIssue(enriched, session.workspace, {
      tier: session.tier as any,
      yes: true,
      dryRun: !!req.simulate,
      memoryPreInjected: true,
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
      await finalizeTaskMemory(session, result, injectedCardIds, ctx.onEvent);
    } catch (memErr: any) {
      ctx.onEvent({ type: 'memory.finalized', ok: false, error: memErr?.message || String(memErr) });
    }

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
      ...(partialText ? { partialText } : {}),
      ...(answerText ? { answerText } : {}),
    };
  } catch (err: any) {
    ctx.onEvent({ type: 'error', message: err?.message || String(err) });
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
 *   （单 rollout，attemptCount=1）→ save() 持久化。answered（纯问答）不产卡。
 * - R2：lastBuildMeta.injectedCardIds 与本次轨迹写入文件集有交集的卡 →
 *   markVerified 刷新 lastUsedAt/count（接口契约 v3 二态之二：机器判定的真实使用）。
 * - 轻量事件 memory.finalized { cards, verified }（消费方：SSE/rich 前端，未知
 *   事件类型走 pushFeed 兜底，安全）。
 * 调用方已 try/catch 包裹：任何异常不影响任务成功返回。
 */
async function finalizeTaskMemory(
  session: Session,
  result: { bestTrajectory?: any },
  injectedCardIds: string[],
  onEvent: (event: any) => void
): Promise<void> {
  const traj = result?.bestTrajectory;
  if (!traj || traj.stopReason !== 'completed' || !session.workspace) return;

  const { RefinedMemoryStore } = await import('../memory/RefinedMemoryStore.js');
  const store = new RefinedMemoryStore(session.workspace);

  // R1：completed = 真实验证通过 → 提炼 success 卡并持久化（触发红线：写盘
  // 成功 ≠ 任务成功——此处任务已真实验证通过，方向安全）。
  const cards = store.refine({
    trajectory: traj,
    taskStyle: traj.taskStyle ?? 'all',
    applicableTiers: [session.tier],
    attemptCount: 1,
  });
  if (cards.length > 0) store.save(cards);

  // R2：注入卡 ∩ 本次写入文件集 → markVerified（衰减语义中唯一的保鲜通道）。
  const written = new Set(extractWrittenFilePaths(traj).map(normalizeRelPath));
  const verifiedIds = (written.size === 0 || injectedCardIds.length === 0)
    ? []
    : store.load().cards
        .filter((c) => injectedCardIds.includes(c.id))
        .filter((c) => (((c as any).referencedFiles ?? []) as string[])
          .some((r) => written.has(normalizeRelPath(r))))
        .map((c) => c.id);
  if (verifiedIds.length > 0) store.markVerified(verifiedIds);

  onEvent({ type: 'memory.finalized', cards: cards.length, verified: verifiedIds.length });
}

/**
 * 从轨迹 steps[].action 提取 write/edit 类工具的目标文件路径。
 * action 实际是 ToolCall[]（{ toolName, params: [{name,value}] }，见
 * src/types/toolCall.ts + PanshalachChaser 的 traj.steps 映射）；兼容旧
 * {name/tool, args/parameters} 形状与 bash 重定向，保证交集判定不因形状漏文件。
 * （导出供测试；行为契约见 tests/server/Resilience073.test.ts）
 */
export function extractWrittenFilePaths(traj: any): string[] {
  const out = new Set<string>();
  for (const step of traj?.steps ?? []) {
    const actions: any[] = Array.isArray(step?.action) ? step.action : (step?.action ? [step.action] : []);
    for (const act of actions) {
      if (!act) continue;
      const name = String(act.toolName ?? act.name ?? act.tool ?? act.type ?? '').toLowerCase();
      let args: any = act.args ?? act.parameters;
      if (!args && Array.isArray(act.params)) {
        args = Object.fromEntries(
          act.params.filter((p: any) => p && p.name).map((p: any) => [p.name, p.value])
        );
      }
      args = args ?? {};
      if (name.includes('write') || name.includes('edit') || name.includes('multiedit')) {
        const fp = args.file_path ?? args.path ?? args.filePath ?? args.target_file ?? args.target ?? args.file;
        if (typeof fp === 'string' && fp) out.add(fp);
      }
      // bash 重定向（> / >>）与 tee 也算写入
      if (name.includes('bash') || name.includes('command') || name === 'run') {
        const cmd = String(args.command ?? args.cmd ?? '');
        for (const t of extractShellWriteTargets(cmd)) out.add(t);
      }
    }
  }
  return Array.from(out);
}

/**
 * 从 shell 命令提取写目标（重定向 + tee）。覆盖三个历史漏判/误判：
 *   1) 引号内空格：`> "my file.txt"` 旧正则截成 `my` → 现按引号对整体捕获；
 *   2) Windows 盘符：`> C:\dir\a.txt` 目标 token 排除集不含 `:` `\` `/`，整体保留
 *      （不再被截成 `C:` 一类的碎片）；
 *   3) tee / tee -a：旧正则完全不识别 → 现按管道段解析 tee 的文件参数。
 * fd 前缀（2> / 2>>）一并处理；`2>&1` 因目标含 `&` 被排除集挡下，不会误收。
 * best-effort：漏判比误判更伤记忆交集，排除集从严（空白/引号/&|;()<>）。
 */
function extractShellWriteTargets(cmd: string): string[] {
  const out = new Set<string>();
  const unquote = (t: string): string => {
    const m = t.match(/^"([^"]*)"$/) || t.match(/^'([^']*)'$/);
    return m ? m[1] : t;
  };

  // 重定向目标：`>` / `>>`（允许 fd 前缀如 2>）。目标 = 双引号串 | 单引号串 | 裸 token。
  const reRedirect = /\d??>{1,2}\s*("[^"]*"|'[^']*'|[^\s"'&|;()<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = reRedirect.exec(cmd)) !== null) {
    const t = unquote(m[1]);
    if (t && t !== '/dev/null') out.add(t);
  }

  // tee：按管道/分号切段，段首为 `tee`（可带 flag，如 -a）→ 后续非 flag token 都是写目标
  for (const seg of cmd.split(/[|;&\n]/)) {
    const segTrim = seg.replace(/^\s*!?\s*(?:sudo\s+)?/i, '');
    if (!/^tee(\s|$)/i.test(segTrim)) continue;
    const tokens = segTrim.replace(/^tee\b\s*/i, '').match(/"[^"]*"|'[^']*'|[^\s"]+/g) ?? [];
    for (const tok of tokens) {
      if (/^-/.test(tok)) continue; // flags：-a / --append
      const t = unquote(tok);
      if (t && t !== '/dev/null') out.add(t);
    }
  }
  return Array.from(out);
}

/** 与 RefinedMemoryStore.normPath 同款归一（\→/、去 ./ 前缀、小写），保证交集可比。 */
function normalizeRelPath(p: string): string {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
}
