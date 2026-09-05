// tests/loop/ContinuationJudge.test.ts
// 接口契约 v3.1：外置验证判官（CC Stop-Hook 等价）的单元测试。
// - 无工具调用的纯文本回合 → 自然停，不判官（闲聊 1 步即停）
// - 有工具但未验证 → 判官有界续跑（默认 ≤2 次），续跑 prompt 携带原因
// - 任一轮出现 PASS（success）→ 立即停止续跑，整体 success=true

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithVerificationJudge } from '../../src/loop/continuationJudge.js';
import type { LoopStep } from '../../src/loop/VerifyCritiqueLoop.js';

function step(withTool: boolean, signal: 'PASS' | 'FAIL' | 'NO_TOOL_CALLS' = 'FAIL'): LoopStep {
  return {
    stepNumber: 1,
    reasoning: { thinking: 't', plan: 'p' },
    toolCalls: withTool ? [{ toolName: 'bash', params: [], rawBlock: '' }] : [],
    verificationResult: signal === 'PASS' ? 'VERIFICATION: ALL_TESTS_PASSED' : 'no output',
    verificationSignal: signal,
  } as any;
}

function scriptedLoop(runs: Array<{ success: boolean; steps: LoopStep[]; stopReason?: string }>) {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    loop: {
      async run(prompt: string) {
        prompts.push(prompt);
        const r = runs[Math.min(i, runs.length - 1)];
        i++;
        return { success: r.success, steps: r.steps, stopReason: r.stopReason };
      },
    },
  };
}

describe('接口契约 v3.1：外置验证判官', () => {
  it('纯文本回合（无工具调用）→ 1 步自然停，不判官', async () => {
    const { loop, prompts } = scriptedLoop([
      { success: false, steps: [step(false, 'NO_TOOL_CALLS')], stopReason: 'no-verification' },
    ]);
    const out = await runWithVerificationJudge(loop as any, 'nihao', { tag: '[T]' });
    assert.equal(out.continueCount, 0, '闲聊不判官');
    assert.equal(out.success, false);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].endsWith('[T]'));
  });

  it('有工具但未验证 → 有界续跑 ≤2 次，续跑 prompt 携带原因', async () => {
    const { loop, prompts } = scriptedLoop([
      { success: false, steps: [step(true)], stopReason: 'max-steps' },
      { success: false, steps: [step(true)], stopReason: 'max-steps' },
      { success: false, steps: [step(true)], stopReason: 'max-steps' },
      { success: false, steps: [step(true)], stopReason: 'max-steps' },
    ]);
    const out = await runWithVerificationJudge(loop as any, 'task', { tag: '[T]' });
    assert.equal(out.continueCount, 2, '有界 2 次');
    assert.equal(prompts.length, 3, '1 次原始 + 2 次续跑');
    assert.ok(prompts[1].includes('【验证未通过——继续任务】'), '续跑携带原因');
    assert.ok(prompts[1].includes('max-steps'));
    assert.ok(out.steps.length >= 3, 'steps 跨轮累积');
  });

  it('续跑中出现 PASS → 立即停止续跑，整体 success=true', async () => {
    const { loop } = scriptedLoop([
      { success: false, steps: [step(true)], stopReason: 'max-steps' },
      { success: true, steps: [step(true, 'PASS')], stopReason: 'completed' },
    ]);
    const out = await runWithVerificationJudge(loop as any, 'task', {});
    assert.equal(out.success, true);
    assert.equal(out.continueCount, 1);
  });

  it('首轮 PASS（evidence）+ 次轮 end_turn → 停止且整体 success=true', async () => {
    const { loop } = scriptedLoop([
      { success: true, steps: [step(true, 'PASS')], stopReason: 'completed' },
      { success: true, steps: [step(false, 'NO_TOOL_CALLS')], stopReason: 'no-verification' },
    ]);
    const out = await runWithVerificationJudge(loop as any, 'task', {});
    assert.equal(out.success, true);
    assert.equal(out.continueCount, 0, 'success 后不判官');
  });
});
