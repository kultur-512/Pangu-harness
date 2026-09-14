// tests/loop/FormatNudgeLadder.test.ts
// T4 失败恢复阶梯 + T6 假成功收紧（loop 级红→绿）。
//
// T4：formatNudgeUsed 布尔 → formatNudgeCount 计数器三级阶梯：
//   第 1 次 NO_TOOL_CALLS → 格式教学全文（现状保持）；
//   第 2 次 → 具体实例短命令（实证：元变量模板出块率 0%，必须用真实工具名实例化）；
//   第 3 次 → no-verification 终局（现状第 2 次就终局——少一次恢复机会）。
//   连续 NO_TOOL_CALLS 计数喂 guardrails（只计数上报，不新增硬闸）。
//
// T6：execution 意图 + 全程零工具调用 → answered 不计 success（口径对齐）；
//     EXIT_CODE:0 判真实验证需验证特征词/验证标记（防 echo 刷 PASS）。

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

describe('T4 失败恢复阶梯（NO_TOOL_CALLS 三级引导）', () => {
  it('连续空转：第1步教学全文 → 第2步具体实例短命令 → 第3步 no-verification 终局', async () => {
    const model = textModel([IDLE_TEXT]);
    const loop = new VerifyCritiqueLoop(model, { async execute() { return 'x'; } }, {
      maxSteps: 10,
      executionIntent: true,
      practicalMode: true,
    });
    const out = await loop.run('修复 bug');

    // 3 步阶梯：初始 + nudge1 + nudge2，第 3 次空转终局
    assert.equal(model.promptsSeen.length, 3, `应恰好 3 次模型调用（初始+两级引导），got ${model.promptsSeen.length}`);
    assert.equal(out.steps.length, 3);
    assert.equal(out.stopReason, 'no-verification', '第 3 次空转才终局');
    assert.equal(out.success, false);

    // 第 2 次 prompt：教学全文（现状保持）
    assert.ok(
      model.promptsSeen[1].includes('工具调用格式（必须遵守）'),
      '第 1 次引导必须是格式教学全文'
    );
    assert.ok(
      model.promptsSeen[1].includes('只输出了文字说明而没有输出任何工具调用块'),
      '第 1 次引导保留【重要】空转说明'
    );

    // 第 3 次 prompt：具体实例短命令（不得再发一遍全文教学）
    const p2 = model.promptsSeen[2];
    assert.ok(p2.includes('上一步没有工具调用'), '第 2 次引导必须点名"上一步没有工具调用"');
    assert.ok(p2.includes('<read_file>'), `必须用具体工具名实例化（元变量模板出块率 0%），got: ${p2}`);
    assert.ok(p2.includes('<file_path>sample.txt</file_path>'), '必须带具体参数实例');
    assert.ok(p2.includes('<>'), '必须给出可照抄的块边界');
    assert.ok(p2.includes('</>'), '必须给出块结束标记');
    assert.ok(
      !p2.includes('工具调用格式（必须遵守）'),
      '第 2 次引导是短命令，不再重复全文教学'
    );
  });

  it('具体实例取 availableToolNames 的第一个读类工具（glob 优先时实例化 glob/pattern）', async () => {
    const model = textModel([IDLE_TEXT]);
    const engine = {
      executor: { availableTools: () => ['bash', 'glob', 'grep', 'read_file'] },
      async execute() { return 'x'; },
    };
    // availableTools 排序为 bash,glob,grep,read_file → 读类优先序 read_file>glob>grep
    // （实现按 read_file>glob>grep 优先级挑第一个存在的）
    const loop = new VerifyCritiqueLoop(model, engine, {
      maxSteps: 10, executionIntent: true, practicalMode: true,
    });
    await loop.run('任务');
    const p2 = model.promptsSeen[2];
    assert.ok(p2.includes('<read_file>'), 'read_file 存在时优先实例化 read_file');
  });

  it('读类工具缺失时实例化首个可用工具（自造引擎只有 run_report）', async () => {
    const model = textModel([IDLE_TEXT]);
    const engine = {
      executor: { availableTools: () => ['run_report', 'zap'] },
      async execute() { return 'x'; },
    };
    const loop = new VerifyCritiqueLoop(model, engine, {
      maxSteps: 10, executionIntent: true, practicalMode: true,
    });
    await loop.run('任务');
    const p2 = model.promptsSeen[2];
    assert.ok(
      p2.includes('<run_report>'),
      `无读类工具时用首个可用工具实例化，got: ${p2}`
    );
  });

  it('阶梯中途动手 → 正常执行，不再升级引导；恢复后计数清零', async () => {
    const toolBlock = '\n<>\n  <bash><command>echo ALL_TESTS_PASSED</command></bash>\n</>\n';
    const model = textModel([IDLE_TEXT, toolBlock, '任务完成。']);
    const loop = new VerifyCritiqueLoop(model, { async execute() { return 'ALL_TESTS_PASSED'; } }, {
      maxSteps: 10, executionIntent: true, practicalMode: true,
    });
    const out = await loop.run('修复 bug');
    assert.equal(out.stopReason, 'completed', '第 2 步动手且 PASS → completed');
    assert.equal(out.success, true);
    // 第 3 步（收尾答复）本身又是一次空转 → 计数 1；若无"恢复即清零"逻辑，
    // 计数会带着第 1 步的 1 累加成 2。
    assert.equal(loop.getIronLawStatus().consecutiveNoToolCalls, 1, '工具调用恢复后计数清零重计');
  });

  it('连续空转计数上报 guardrails（consecutiveNoToolCalls=3）', async () => {
    const model = textModel([IDLE_TEXT]);
    const loop = new VerifyCritiqueLoop(model, { async execute() { return 'x'; } }, {
      maxSteps: 10, executionIntent: true, practicalMode: true,
    });
    await loop.run('任务');
    assert.equal(
      loop.getIronLawStatus().consecutiveNoToolCalls, 3,
      '3 步全空转 → 连续空转计数 3（只计数上报，不设硬闸）'
    );
  });
});

describe('T6 假成功收紧（loop 级）', () => {
  it('execution 意图全程零工具调用：阶梯走完后终局 no-verification，success=false（不得 answered 记成功）', async () => {
    const model = textModel([IDLE_TEXT]);
    const loop = new VerifyCritiqueLoop(model, { async execute() { return 'x'; } }, {
      maxSteps: 10, executionIntent: true, practicalMode: true,
    });
    const out = await loop.run('列出 src 下的文件');
    assert.notEqual(out.stopReason, 'answered', '零动作不得记 answered');
    assert.equal(out.stopReason, 'no-verification');
    assert.equal(out.success, false, 'execution 意图 + 零工具调用 → answered 不计 success');
  });

  it('EXIT_CODE:0 但无验证特征词/标记（echo 刷的）→ 本步不计 didRealVerification', async () => {
    const toolBlock = '\n<>\n  <bash><command>echo hello</command></bash>\n</>\n';
    const model = textModel([toolBlock]);
    const engine = { async execute() { return 'BASH_SUCCESS:\nhello\nEXIT_CODE:0'; } };
    const loop = new VerifyCritiqueLoop(model, engine, { maxSteps: 2, practicalMode: true });
    const out = await loop.run('任务');
    assert.equal(
      out.steps[0].didRealVerification, false,
      '裸 EXIT_CODE:0（echo 类输出、无验证特征词/标记）不触发 didRealVerification'
    );
    assert.equal(
      loop.getIronLawStatus().verifiedCount, 0,
      'verificationAttempts 不增长（防 echo/跑错命令刷验证计数）'
    );
  });

  it('EXIT_CODE:0 + 验证特征词（test 字样输出）→ 计真实验证', async () => {
    const toolBlock = '\n<>\n  <bash><command>npm test</command></bash>\n</>\n';
    const model = textModel([toolBlock]);
    const engine = { async execute() { return 'BASH_SUCCESS:\n14 tests passing\nEXIT_CODE:0'; } };
    const loop = new VerifyCritiqueLoop(model, engine, { maxSteps: 2, practicalMode: true });
    const out = await loop.run('任务');
    assert.equal(
      out.steps[0].didRealVerification, true,
      '输出含验证特征词（test）→ EXIT_CODE:0 计真实验证'
    );
  });

  it('EXIT_CODE:0 + VERIFICATION 标记（真实 engineAdapter 追加形状）→ 计真实验证', async () => {
    const toolBlock = '\n<>\n  <bash><command>node build.js</command></bash>\n</>\n';
    const model = textModel([toolBlock]);
    const engine = { async execute() { return 'BASH_SUCCESS:\nbuilt\nEXIT_CODE:0\nVERIFICATION: PASS'; } };
    const loop = new VerifyCritiqueLoop(model, engine, { maxSteps: 2, practicalMode: true });
    const out = await loop.run('任务');
    assert.equal(out.steps[0].didRealVerification, true, '输出含 VERIFICATION 标记 → 计真实验证');
  });
});
