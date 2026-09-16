// tests/loop/Resilience073.test.ts
// 0.7.3 T2 行为锁定（docs/panshalach/USABLE-PLAN-0.7.3.md）：
//   T2#4 中断现场落盘：aborted 轨迹带 partialText + 已解析 toolCalls 补
//         "aborted before dispatch" 合成失败结果（call/result 成对进历史）。
//   T2#5 answered 空转防呆：execution 意图 + 无真实验证 + 有正文无工具调用
//         → 第一次注入格式提醒重试一步；第二次无动作按 no-verification 终局。
//   T2#6 窗口预算：loop windowTokens 超窗口 70% → 裁 history 中段（保前2+后2步）。
//   T2#7 finish_reason=length：截断响应禁判 answered，注入精简提示继续。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';

function makeLoop(modelClient: any, engine: any, opts: any = {}) {
  return new VerifyCritiqueLoop(modelClient, engine, { practicalMode: true, ...opts });
}

const writeCallBlock = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <write_file>
    <file_path>out.txt</file_path>
    <content>pong</content>
  </write_file>
</>
`;

describe('0.7.3 T2#4 中断现场落盘（loop 层）', () => {
  it('abort 于 complete 返回后：partialText 保留 + 已解析 toolCalls 补合成失败结果', async () => {
    const controller = new AbortController();
    const model = {
      async complete() {
        // 返回带正文 + 工具调用的响应，然后立刻中止（模拟 Ctrl+C 竞态窗口）
        controller.abort();
        return '我已经分析了文件，接下来写入修复。' + writeCallBlock;
      },
    };
    const engine = {
      executeCalls: [] as any[],
      async execute(calls: any[]) { this.executeCalls.push(calls); return 'VERIFICATION: PASS'; },
    };
    const loop = makeLoop(model, engine, { maxSteps: 10, signal: controller.signal });
    const out = await loop.run('修复 out.txt');

    assert.equal(out.stopReason, 'aborted');
    assert.equal(out.partialText, '我已经分析了文件，接下来写入修复。', '已流出正文必须作为部分结果带回');
    assert.equal(engine.executeCalls.length, 0, 'abort 后不得执行任何工具');

    // call/result 成对进历史：合成失败步携带原 toolCalls + aborted before dispatch
    const synth = out.steps.find((s) => s.verificationResult.includes('aborted before dispatch'));
    assert.ok(synth, '必须为已解析 toolCalls 补合成失败结果');
    assert.equal(synth.toolCalls.length, 1);
    assert.equal(synth.toolCalls[0].toolName, 'write_file');
    assert.equal(synth.verificationSignal, 'FAIL');
  });

  it('abort 时无正文 → partialText 为 undefined（不编造空串现场）', async () => {
    const controller = new AbortController();
    const model = {
      async complete() {
        controller.abort();
        return writeCallBlock; // 纯工具块，剥离后无正文
      },
    };
    const loop = makeLoop(model, { async execute() { return 'VERIFICATION: PASS'; } },
      { maxSteps: 10, signal: controller.signal });
    const out = await loop.run('任务');
    assert.equal(out.stopReason, 'aborted');
    assert.equal(out.partialText, undefined);
    assert.ok(out.steps.some((s) => s.verificationResult.includes('aborted before dispatch')));
  });
});

describe('0.7.3 T2#5 answered 空转防呆（execution 意图）', () => {
  function textModel(responses: string[]) {
    let i = 0;
    return {
      prompts: [] as string[],
      async complete(p: string) {
        this.prompts.push(p);
        return responses[Math.min(i++, responses.length - 1)];
      },
    };
  }
  it('只说话不动作 → 有正文即 answered（2026-09-16 success 语义摘除后）', async () => {
    const model = textModel([
      '我觉得直接改配置就行，不需要动手。',
    ]);
    const loop = makeLoop(
      model,
      { async execute() { return 'VERIFICATION: PASS'; } },
      { maxSteps: 6, isStrongMode: true, practicalMode: false } // execution 意图（isStrongMode）
    );
    const out = await loop.run('修复 bug');
    assert.equal(out.stopReason, 'answered', '空转有正文 → answered（nudge 阶梯已摘除）');
    assert.equal(out.success, true, 'answered 一律计 success（T6 假成功防线摘除）');
    assert.equal(out.steps.length, 1, '一步即停，不再注入格式提醒重试');
  });

  it('非 execution 意图（practical 弱模式）保持旧行为：有正文 1 步 answered', async () => {
    const model = textModel(['你好，这是纯答复。']);
    const loop = makeLoop(model, { async execute() { return 'x'; } }, { maxSteps: 5 });
    const out = await loop.run('随便聊聊');
    assert.equal(out.stopReason, 'answered', 'isStrongMode=false 且无 taskStyle → 防呆不生效');
    assert.equal(out.steps.length, 1);
  });
});

describe('0.7.3 T2#6 loop 窗口预算（70% 预算线）', () => {
  it('history 组装超 windowTokens*70% → 单步封顶 + 迭代裁中段，复查后在预算内（A4）', async () => {
    const captured: string[] = [];
    const bigResult = 'X'.repeat(2600) + '\nVERIFICATION: NEUTRAL'; // 每步 ~2.6k+ 字符，≤4000 不触发 T2#9 结果修剪
    const toolBlock = `
<thinking>t</thinking>
<plan>p</plan>
<verify>v</verify>
<>
  <bash>
    <command>echo step</command>
  </bash>
</>
`;
    const model = {
      async complete(p: string) {
        captured.push(p);
        return toolBlock;
      },
    };
    const loop = makeLoop(model, { async execute() { return bigResult; } }, {
      maxSteps: 6,
      windowTokens: 2048, // 70% ≈ 1433 tokens ≈ 5734 chars；5 步 history ≈ 13k chars 必超
    });
    await loop.run('循环任务');

    const last = captured[captured.length - 1];
    // A4 新语义：每步 ~2.6k 字符 > 单步预算（5734×0.2≈1147）→ 先单步封顶；
    // 5 步封顶后 ≈5k ≤ 5734 → 无需裁中段。复查保证总长在预算内。
    const budgetChars = 2048 * 4 * 0.7;
    assert.ok(last.length <= budgetChars, `裁剪后复查必须在预算内：${last.length} > ${budgetChars}`);
    assert.ok(last.includes('本步内容过长已截断（单步窗口预算）'), '巨步必须单步封顶');
    assert.ok(last.includes('VERIFICATION: NEUTRAL'), '封顶保留尾段（验证信号可见）');
    assert.ok(last.includes('Step 1 [') && last.includes('Step 5 ['), '首尾步保留');
    assert.equal(captured.length, 6);
  });

  it('未超预算时不裁（windowTokens 提供但 history 小）', async () => {
    const captured: string[] = [];
    const model = {
      async complete(p: string) {
        captured.push(p);
        return '纯文本答复';
      },
    };
    const loop = makeLoop(model, { async execute() { return 'VERIFICATION: PASS'; } }, { maxSteps: 1, windowTokens: 32768 });
    await loop.run('小任务');
    assert.ok(!captured[0].includes('步已裁剪'), '小 history 不裁');
  });
});

describe('0.7.3 T2#7 finish_reason=length 禁判 answered', () => {
  it('truncated 响应：不终局、注入截断提示、继续下一步；永不 answered', async () => {
    const prompts: string[] = [];
    let calls = 0;
    const model = {
      async complete(p: string) {
        prompts.push(p);
        calls++;
        // 模拟网关 finish_reason=length：内容被拦腰截断（对象携带 truncated）
        return { content: `这是被 max_tokens 截断的半截答复 ${calls}……`, truncated: true };
      },
    };
    const loop = makeLoop(model, { async execute() { return 'VERIFICATION: PASS'; } }, { maxSteps: 3 });
    const out = await loop.run('回答一个长问题');

    assert.equal(out.steps.length, 3, '截断响应不得 1 步 answered 终局（跑满 maxSteps 兜底）');
    assert.notEqual(out.stopReason, 'answered', '截断响应禁判 answered');
    assert.equal(out.success, false);
    const withNotice = prompts.filter((p) => p.includes('max_tokens 截断'));
    assert.ok(withNotice.length >= 1, '必须注入截断提示继续下一步');
  });
});
