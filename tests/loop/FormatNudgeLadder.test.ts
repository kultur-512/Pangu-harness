// tests/loop/FormatNudgeLadder.test.ts
// 2026-09-16 success 语义摘除后的空转行为锁定：
//   旧 T4 三级 nudge 阶梯（教学全文 → 具体实例 → no-verification 终局）已摘除；
//   旧 T6"execution + 全程零工具时 answered 不计 success"假成功防线已摘除。
//   新语义：空转步有正文 → answered 计 success；无正文 → no-verification；
//   历史渲染仍本地化（内部信号词 NO_TOOL_CALLS 不喂给模型）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';

/** 纯 complete 客户端（文本协议路径），记录 prompt 序列。 */
function textModel(responses: string[]) {
  let i = 0;
  return {
    promptsSeen: [] as string[],
    async complete(prompt: string) {
      this.promptsSeen.push(String(prompt));
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
}

const IDLE_TEXT = '我觉得直接改配置就行，不需要动手。';

describe('空转步语义（nudge 阶梯摘除后）', () => {
  it('execution 意图 + 空转有正文 → 1 步 answered 计 success（不再三级引导）', async () => {
    const model = textModel([IDLE_TEXT]);
    const loop = new VerifyCritiqueLoop(model, { async execute() { return 'x'; } }, {
      maxSteps: 10,
      executionIntent: true,
      practicalMode: true,
    });
    const out = await loop.run('修复 bug');

    // 2026-09-16 窄版纠偏：execution 意图 + 全程零工具 + 首次空谈 → 注入一次
    // 纠偏重试；二次仍空谈 → 尊重 answered。
    assert.equal(model.promptsSeen.length, 2, '纠偏一次后二次空谈尊重 answered');
    assert.equal(out.steps.length, 2);
    assert.ok(model.promptsSeen[1].includes('需要实际行动'), '第 2 次 prompt 携带纠偏提示');
    assert.equal(out.stopReason, 'answered', '空转有正文 → answered');
    assert.equal(out.success, true, 'answered 一律计 success（T6 摘除）');
  });

  it('空转无正文 → no-verification（不计 success）', async () => {
    const model = textModel(['   ']);
    const loop = new VerifyCritiqueLoop(model, { async execute() { return 'x'; } }, {
      maxSteps: 10,
      executionIntent: true,
      practicalMode: true,
    });
    const out = await loop.run('修复 bug');
    assert.equal(out.stopReason, 'no-verification');
    assert.equal(out.success, false);
  });

  it('工具步后空转总结 → answered；历史渲染本地化（不喂 NO_TOOL_CALLS 字面）', async () => {
    const TOOL_STEP = `
<thinking>先看文件</thinking>
<plan>读配置</plan>
<verify>确认内容</verify>
<>
  <read_file>
    <file_path>sample.txt</file_path>
  </read_file>
</>
`;
    const model = textModel([TOOL_STEP, '工作区里是示例配置文件，内容已确认。']);
    const loop = new VerifyCritiqueLoop(model, { async execute() { return 'READ_SUCCESS: sample.txt (1 lines total)'; } }, {
      maxSteps: 10,
      executionIntent: true,
      practicalMode: true,
    });
    const out = await loop.run('看下 sample.txt');

    assert.equal(out.stopReason, 'answered', '工具步后总结 → answered');
    assert.equal(out.success, true, '有工具工作的 answered 计 success');
    // 第 2 次 prompt 携带历史——本地化断言
    const hist = model.promptsSeen[1];
    assert.ok(hist.includes('[历史执行记录]'), '携带历史');
    assert.ok(!hist.includes('NO_TOOL_CALLS'), '内部信号词不喂模型');
    assert.ok(hist.includes('Step 1 ['), '步骤渲染存在');
  });
});
