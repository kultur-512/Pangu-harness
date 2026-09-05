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
import { appendContextSnapshot, appendAgentEvent } from '../cli/repl/rolloutStore.js';
import { createHash } from 'node:crypto';
import type { ModelProvider } from '../cli/repl/types.js';
import { classifyTaskIntent } from '../cli/taskIntent.js';

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
}

export interface RunResult {
  success: boolean;
  stopReason?: string;
  durationMs?: number;
  error?: string;
  budgetReport?: any;
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
    // 返回放宽为 string：line 桥可返回 `n:<指导语>`（P0-3.4）。
    approvalMode?: 'readonly' | 'default' | 'full';
    sessionAllowlist?: Set<string>;
    approvalBridge?: (req: { tool: string; description: string; danger: boolean }) => Promise<string>;
    approvalTimeoutMs?: number;
    planMode?: boolean;
    mcpTools?: any[];
  }
): Promise<RunResult> {
  const start = Date.now();

  // B2: reuse the caller's Session when provided (turns / tier / workspace /
  // model / approval state all live there); otherwise build a fresh one from
  // the flat fields (server / headless paths stay compatible).
  const session = req.session ?? new Session();
  if (!req.session) {
    if (req.tier) session.tier = req.tier as any;
    if (req.workspace) session.workspace = req.workspace;
    if (req.model) session.model = req.model;
  }

  // 进程级共享实例上的分层 provider 解析。
  // Explicit provider (caller) → shared provider → one hot-reload retry.
  // Keeps /model hot state and .panshalach.json discovery consistent with the REPL.
  const { client } = await resolveSharedClient(session.model, ctx.provider);

  const { PanshalachChaser } = await import('../PanshalachChaser.js');
  const chaser = new PanshalachChaser(client, session.tier);

  const tierConfig = TierRegistry.get(session.tier);
  const pb = new PromptBuilder(session, tierConfig);
  // 0.7.2 主线 1：意图分类前移——对【原始输入】分类，而不是等 chaser 在富化文本上
  // 兜底分类（富化文本必含 bash 等执行词 → chat/search 恒不可达的死代码）。
  // PANSHA_INTENT_GATE=0 语义保持：gate 关闭时 classifyTaskIntent 恒返回 'execution'，
  // 与 0.7 旧行为完全一致（逃生门不需要入口特判）。
  const intent = classifyTaskIntent(req.task);
  const enriched = await pb.buildForTask(req.task, intent);

  // 接口契约 v3：逐任务 ContextSnapshot + memory_injected 事件（注入审计账本）。
  // 评测由此回答"模型当时到底看见了什么"；lastBuildMeta 在此消费（不改变 buildForTask 的 string 返回契约）。
  // 供 finalizeTaskMemory（0.7.2 主线 2）消费的注入卡账本。
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
      // 0.7.2：入口前移的意图显式传入（chaser 不再对富化文本兜底分类）
      intent,
      // 审批透传
      approvalMode: ctx.approvalMode ?? 'readonly',
      sessionAllowlist: ctx.sessionAllowlist,
      approvalBridge: ctx.approvalBridge,
      approvalTimeoutMs: ctx.approvalTimeoutMs,
      planMode: ctx.planMode,
      mcpTools: ctx.mcpTools,
      signal: ctx.signal,
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

    // 0.7.2 主线 2：记忆落定（单一落定点）——仅 completed（真实验证通过）触发
    // refine→save 产卡 + 注入卡∩写集 markVerified。best-effort：记忆失败绝不
    // 影响任务成功返回（本模块 console-silent，错误以事件透出）。
    try {
      await finalizeTaskMemory(session, result, injectedCardIds, ctx.onEvent);
    } catch (memErr: any) {
      ctx.onEvent({ type: 'memory.finalized', ok: false, error: memErr?.message || String(memErr) });
    }

    ctx.onEvent({ type: 'result', success, stopReason: result.bestTrajectory?.stopReason, budgetReport: result.budgetReport });

    return {
      success,
      stopReason: result.bestTrajectory?.stopReason,
      durationMs: Date.now() - start,
      budgetReport: result.budgetReport,
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

// ==================== 0.7.2 主线 2：记忆落定（R1/R2 最小闭环） ====================

/**
 * 任务边界记忆落定（单一落定点，0.7.2 重写——原 finalizeTaskMemory 在未合入分支上
 * 且语义依赖已删除的判官）：
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
 */
function extractWrittenFilePaths(traj: any): string[] {
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
      // bash 重定向（> / >>）也算写入
      if (name.includes('bash') || name.includes('command') || name === 'run') {
        const cmd = String(args.command ?? args.cmd ?? '');
        const re = /(?:^|[\s;&|(){}])[^>]*>>?\s*["']?([^"'\s>;|]+)["']?/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(cmd)) !== null) if (m[1]) out.add(m[1]);
      }
    }
  }
  return Array.from(out);
}

/** 与 RefinedMemoryStore.normPath 同款归一（\→/、去 ./ 前缀、小写），保证交集可比。 */
function normalizeRelPath(p: string): string {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
}
