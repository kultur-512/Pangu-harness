// src/loop/continuationJudge.ts
// 接口契约 v3.1：外置验证判官（CC Stop-Hook 等价物）。
//
// 双层终止的判官层：turn 结束时若 trajectory.success=false 且该轮出现过工具
// 调用（模型确实在干活，而非闲聊），注入"验证未通过：原因，继续"续跑同一
// 任务（有界，默认 ≤2 次）。纯文本回合不判官——闲聊 1 步即停。
//
// 规则：
// - loop 实例被复用（历史 steps 在 loop 内累积，续跑可见前文）；
// - 续跑 prompt 携带上一轮停止原因与验证要求；
// - success（轨迹出现过 PASS）一旦为真立即停止续跑；
// - 中间轮次的 stopReason 语义为 'verification-failed-continue'，
//   最终 stopReason 由调用方按 success 收敛为 'completed' 或保留末轮原因。

import type { LoopStep } from './VerifyCritiqueLoop.js';

export interface JudgeLoop {
  run(prompt: string): Promise<{ success: boolean; steps: LoopStep[]; stopReason?: string }>;
}

export interface JudgeOptions {
  /** 追加在每次 run prompt 之后的标签（如 rollout 标记/格式纪律） */
  tag?: string;
  /** 判官续跑上限（默认 2） */
  maxContinuations?: number;
  /** 每次 run 结束的回调（用于事件透出/计费） */
  onRunComplete?: (result: { success: boolean; steps: LoopStep[]; stopReason?: string }, continueCount: number) => void;
}

export interface JudgeOutcome {
  steps: LoopStep[];
  success: boolean;
  stopReason?: string;
  continueCount: number;
}

const CONTINUATION_MARK = '【验证未通过——继续任务】';

export async function runWithVerificationJudge(
  loop: JudgeLoop,
  basePrompt: string,
  opts: JudgeOptions = {}
): Promise<JudgeOutcome> {
  const maxContinuations = opts.maxContinuations ?? 2;
  const tag = opts.tag ?? '';

  let allSteps: LoopStep[] = [];
  let continueCount = 0;
  let sawSuccess = false;
  let last: { success: boolean; steps: LoopStep[]; stopReason?: string } | null = null;

  for (;;) {
    const prompt = continueCount === 0
      ? basePrompt + tag
      : basePrompt + tag + CONTINUATION_BLOCK(lastStopSummary(last));
    last = await loop.run(prompt);
    allSteps = allSteps.concat(last.steps);
    if (last.success) sawSuccess = true; // 任一轮出现 PASS 即整体成功（evidence 语义）
    opts.onRunComplete?.(last, continueCount);

    const hadTools = last.steps.some(s => Array.isArray(s.toolCalls) && s.toolCalls.length > 0);
    if (last.success) break;
    if (!hadTools) break;              // end_turn 纯文本 → 自然停（闲聊/纯回答）
    if (continueCount >= maxContinuations) break;
    continueCount++;
  }

  return {
    steps: allSteps,
    success: sawSuccess,
    stopReason: last?.stopReason,
    continueCount,
  };
}

function CONTINUATION_BLOCK(lastStopSummary: string | undefined): string {
  return (
    NL + NL + CONTINUATION_MARK +
    NL + `上一轮结束原因：${lastStopSummary ?? 'no-verification'}。系统未观察到验证通过信号（ALL_TESTS_PASSED / VERIFICATION: PASS）。` +
    NL + '请继续完成任务：完成剩余工作，运行声明的验证命令并确认输出，验证通过后停止。' +
    NL + '若任务确已完成但缺少验证，请补运行验证命令。'
  );
}

function lastStopSummary(last: { steps: LoopStep[]; stopReason?: string } | null): string | undefined {
  if (!last) return undefined;
  return last.stopReason ?? (last.steps.length > 0 ? String(last.steps[last.steps.length - 1].verificationSignal ?? '') : undefined);
}

const NL = '\n';
