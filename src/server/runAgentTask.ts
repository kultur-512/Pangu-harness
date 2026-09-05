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
  const enriched = await pb.buildForTask(req.task);

  // 接口契约 v3：逐任务 ContextSnapshot + memory_injected 事件（注入审计账本）。
  // 评测由此回答"模型当时到底看见了什么"；lastBuildMeta 在此消费（不改变 buildForTask 的 string 返回契约）。
  try {
    const meta = pb.lastBuildMeta;
    const injected = meta?.injectedCardIds ?? [];
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
