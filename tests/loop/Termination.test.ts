// tests/loop/Termination.test.ts
// 0.7 单层终止语义的 loop 层回归（原 TwoLayerTermination.test.ts 收敛）。
// - end_turn（无工具调用）且【有正文】→ 1 步自然停，stopReason='answered'，success=true
// - end_turn 且【无正文】→ stopReason='no-verification'，success=false
// - PASS 后 end_turn → stopReason='completed'
// - 连续失败保护 / 步数耗尽 → 对应 stopReason
// - signal abort → stopReason='aborted'

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';

function makeLoop(modelClient: any, engine: any, opts: any = {}) {
  return new VerifyCritiqueLoop(modelClient, engine, { practicalMode: true, ...opts });
}

function textModel(responses: string[]) {
  let i = 0;
  return {
    callCount: 0,
    async complete(_prompt: string) {
      this.callCount++;
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
}

const engine = {
  async execute(calls: any[]) {
    return calls.length > 0 ? 'VERIFICATION: ALL_TESTS_PASSED' : 'nothing';
  },
};

describe('0.7 单层终止（loop 层）', () => {
  it('end_turn 有正文 → 1 步即停，stopReason=answered，success=true', async () => {
    const model = textModel(['你好，我是烛龙。']);
    const loop = makeLoop(model, engine, { maxSteps: 5 });
    const out = await loop.run('nihao');
    assert.equal(out.steps.length, 1, '闲聊 1 步即停');
    assert.equal(out.stopReason, 'answered');
    assert.equal(out.success, true, 'CC 式自然停即成功');
  });

  it('end_turn 无正文（只有结构块/空）→ stopReason=no-verification，success=false', async () => {
    const model = textModel(['<thinking>想一下</thinking><plan>计划</plan><verify>验证</verify>']);
    const loop = makeLoop(model, engine, { maxSteps: 5 });
    const out = await loop.run('empty reply');
    assert.equal(out.stopReason, 'no-verification');
    assert.equal(out.success, false, '无正文答复不是成功');
  });

  it('PASS 后 end_turn → success=true，stopReason=completed', async () => {
    const model = textModel([
      `
<thinking>跑验证</thinking>
<plan>echo</plan>
<verify>确认输出</verify>
<>
  <bash><command>echo ALL_TESTS_PASSED</command></bash>
</>
`,
      '验证已通过，任务完成。',
    ]);
    const loop = makeLoop(model, engine, { maxSteps: 5 });
    const out = await loop.run('task with declared verification');
    assert.equal(out.success, true, '轨迹含 PASS → success');
    assert.equal(out.stopReason, 'completed');
  });

  it('步数耗尽 → stopReason=max-steps（PARTIAL 不触发连错保护）', async () => {
    const alwaysTool = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <bash><command>echo hi</command></bash>
</>
`;
    const model = textModel([alwaysTool]);
    const loop = makeLoop(model, { async execute() { return 'PARTIAL: ran but not conclusive'; } }, { maxSteps: 3 });
    const out = await loop.run('never verifies');
    assert.equal(out.steps.length, 3);
    assert.equal(out.success, false, 'PARTIAL 是 evidence，非 PASS');
    assert.equal(out.stopReason, 'max-steps');
  });

  it('连续失败保护 → stopReason=consecutive-failures', async () => {
    const failTool = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <bash><command>exit 1</command></bash>
</>
`;
    const model = textModel([failTool]);
    const loop = makeLoop(model, { async execute() { return 'ERROR: command failed'; } }, {
      maxSteps: 10,
      maxConsecutiveFailures: 2,
    });
    const out = await loop.run('always fails');
    assert.equal(out.steps.length, 2, '连错 2 次（上限）即停');
    assert.equal(out.success, false);
    assert.equal(out.stopReason, 'consecutive-failures');
  });

  it('signal abort → stopReason=aborted（不再继续循环）', async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = {
      async complete() {
        calls++;
        controller.abort(); // 第一次调用后立刻中止
        return 'tool output would be here';
      },
    };
    const loop = makeLoop(model, engine, { maxSteps: 20, signal: controller.signal });
    const out = await loop.run('abort me');
    assert.equal(out.stopReason, 'aborted');
    assert.equal(calls, 1, 'abort 后不再发起新模型调用');
  });
});
