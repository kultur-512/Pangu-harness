// tests/loop/ContextBudgetTrim.test.ts
// A4/A5 上下文预算与溢出应急：
// - A4 buildHistoryPrompt：裁剪后复查（迭代收缩直到 ≤ 预算）、单步封顶、
//   溢出应急档文案（"截断"而非"压缩"——确定性截断不是摘要压缩）
// - A5 messages 模式：trimMessages 保种子+末 2 组交换对（tool 与 assistant
//   tool_calls 成对、无孤儿）；溢出重试时真实裁剪（修"重试必然再溢出"）

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';

const ORIG_MESSAGES_MODE = process.env.PANSHA_MESSAGES_MODE;
function restoreEnv(): void {
  if (ORIG_MESSAGES_MODE === undefined) delete process.env.PANSHA_MESSAGES_MODE;
  else process.env.PANSHA_MESSAGES_MODE = ORIG_MESSAGES_MODE;
}

function mkStep(i: number, resultChars: number): any {
  return {
    stepNumber: i,
    reasoning: { thinking: `think-${i}`, plan: `plan-${i}`, verify: 'ok' },
    toolCalls: [],
    verificationResult: `STEP-${i}-RESULT-` + 'X'.repeat(resultChars),
    verificationSignal: 'PASS',
    critique: '',
  };
}

describe('A4 buildHistoryPrompt：裁剪复查与单步封顶', () => {
  const ORIG_NO_BUDGET_TRIM = process.env.PANSHA_NO_BUDGET_TRIM;
  afterEach(() => {
    if (ORIG_NO_BUDGET_TRIM === undefined) delete process.env.PANSHA_NO_BUDGET_TRIM;
    else process.env.PANSHA_NO_BUDGET_TRIM = ORIG_NO_BUDGET_TRIM;
  });

  it('PANSHA_NO_BUDGET_TRIM=1 → 禁用主动窗口裁剪（评测 A 档逃生门），溢出应急档不受影响', () => {
    process.env.PANSHA_NO_BUDGET_TRIM = '1';
    const loop = new VerifyCritiqueLoop({} as any, {} as any, { practicalMode: true });
    (loop as any).windowTokens = 1000; // budgetChars = 2800
    (loop as any).steps = [mkStep(1, 950), mkStep(2, 950), mkStep(3, 950), mkStep(4, 950), mkStep(5, 950), mkStep(6, 950)];
    const full = (loop as any).buildHistoryPrompt() as string;
    assert.ok(full.length > 2800, '逃生门下超预算也不裁（让真溢出可达网关）');
    assert.ok(full.includes('STEP-3-RESULT'), '全部步骤保留');

    // 溢出应急档不受逃生门影响——它是溢出后的恢复路径
    (loop as any).forcedCompactApplied = true;
    const trimmed = (loop as any).buildHistoryPrompt() as string;
    assert.ok(trimmed.includes('context_overflow 溢出应急'), '应急档仍生效');
    assert.ok(!trimmed.includes('STEP-3-RESULT'), '应急档仍裁中段');
    delete process.env.PANSHA_NO_BUDGET_TRIM;
  });

  it('裁剪后复查：保下的首尾步仍超预算时继续迭代收缩（旧实现切一刀就返回）', () => {
    const loop = new VerifyCritiqueLoop({} as any, {} as any, { practicalMode: true });
    (loop as any).windowTokens = 1000; // budgetChars = 2800
    // 6 步 × ~1000 字符：旧逻辑保前2+后2（≈4000+ 字符）仍超预算直接返回
    (loop as any).steps = [mkStep(1, 950), mkStep(2, 950), mkStep(3, 950), mkStep(4, 950), mkStep(5, 950), mkStep(6, 950)];
    const res = (loop as any).buildHistoryPrompt() as string;
    assert.ok(res.length <= 2800, `裁剪后必须复查并收缩到预算内：got ${res.length}`);
    assert.ok(res.includes('步已截断（上下文窗口预算）'), '必须带显式截断标记');
    assert.ok(res.includes('STEP-1-RESULT') && res.includes('STEP-6-RESULT'), '首尾步必须保留');
  });

  it('单步封顶：巨步（>20% 预算）内容被截断，4 个巨步不再原样超窗', () => {
    const loop = new VerifyCritiqueLoop({} as any, {} as any, { practicalMode: true });
    (loop as any).windowTokens = 1000; // perStep = 560 chars
    (loop as any).steps = [mkStep(1, 3000), mkStep(2, 3000), mkStep(3, 3000), mkStep(4, 3000)];
    const res = (loop as any).buildHistoryPrompt() as string;
    assert.ok(res.includes('本步内容过长已截断（单步窗口预算）'), '巨步必须被单步封顶');
    assert.ok(res.length < 2800, `封顶后必须在预算内：got ${res.length}`);
  });

  it('溢出应急档：仅保首尾步，标记明示"截断"而非"压缩"', () => {
    const loop = new VerifyCritiqueLoop({} as any, {} as any, { practicalMode: true });
    (loop as any).forcedCompactApplied = true;
    (loop as any).steps = [mkStep(1, 100), mkStep(2, 100), mkStep(3, 100), mkStep(4, 100)];
    const res = (loop as any).buildHistoryPrompt() as string;
    assert.ok(res.includes('context_overflow 溢出应急'), '应急标记必须写明截断语义');
    assert.ok(res.includes('STEP-1-RESULT') && res.includes('STEP-4-RESULT'), '首尾保留');
    assert.ok(!res.includes('STEP-2-RESULT') && !res.includes('STEP-3-RESULT'), '中段移除');
  });
});

describe('C1 messages 巨结果封顶与迭代收缩', () => {
  afterEach(() => {
    const o = process.env.PANSHA_NO_BUDGET_TRIM;
    if (o === undefined) delete process.env.PANSHA_NO_BUDGET_TRIM;
    else process.env.PANSHA_NO_BUDGET_TRIM = o;
  });

  it('pushToolMessages：单条工具结果超 20% 窗口预算 → 头 60% + 尾 25% 截断', () => {
    const loop = new VerifyCritiqueLoop({} as any, {} as any, { practicalMode: true });
    (loop as any).windowTokens = 1000; // per-message budget = 800 chars
    (loop as any).pushToolMessages(
      [{ toolName: 'read_file', params: [] }],
      null,
      'HEAD-MARK ' + 'X'.repeat(1200) + ' TAIL-MARK',
    );
    const msgs = (loop as any).messages;
    assert.equal(msgs.length, 1);
    const c = msgs[0].content;
    assert.ok(c.startsWith('HEAD-MARK'), '保留头段');
    assert.ok(c.endsWith('TAIL-MARK'), '保留尾段');
    assert.ok(c.includes('工具输出过长已截断'), '带显式截断标记');
    assert.ok(c.length < 1200, `截断后必须显著短于原文：${c.length}`);
  });

  it('enforceMessagesBudget：组数到底后对最大 tool 消息二级截断（防残余超窗）', () => {
    const loop = new VerifyCritiqueLoop({} as any, {} as any, { practicalMode: true });
    (loop as any).windowTokens = 1000; // cap = 700 tokens
    // 巨型首条 user（不可裁）+ 1 个组（trimMessages 无组可丢）+ 巨 tool 结果
    (loop as any).messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'GIANT-SEED ' + 'S'.repeat(1000) },
      { role: 'assistant', content: 'A1', toolCalls: [{ id: 'c1' }] },
      { role: 'tool', toolCallId: 'c1', content: 'BIG ' + 'T'.repeat(3000) },
    ];
    const acted = (loop as any).enforceMessagesBudget(700);
    assert.equal(acted, true, '必须做过裁剪');
    const msgs = (loop as any).messages;
    assert.equal(msgs.length, 4, '组数不足时不丢组');
    assert.ok(msgs[3].content.includes('工具输出过长已截断'), '最大 tool 消息被二级截断');
    assert.ok((loop as any).messagesTokens() <= 700 + 400, `收缩后逼近预算（种子除外）：${(loop as any).messagesTokens()}`);
  });

  it('PANSHA_NO_BUDGET_TRIM=1 → 发送前稳态预算检查跳过', () => {
    process.env.PANSHA_NO_BUDGET_TRIM = '1';
    const loop = new VerifyCritiqueLoop({} as any, {} as any, { practicalMode: true });
    (loop as any).windowTokens = 1000;
    (loop as any).messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'SEED ' + 'S'.repeat(2000) },
    ];
    const acted = (loop as any).enforceMessagesBudget(700);
    assert.equal(acted, false, '逃生门下不做任何裁剪');
  });
});

describe('A5 messages 模式：trimMessages', () => {
  afterEach(restoreEnv);

  it('白盒：保种子前缀+末 2 个 assistant 交换对，无孤儿 tool、无悬空 tool_calls', () => {
    const loop = new VerifyCritiqueLoop({} as any, {} as any, { practicalMode: true });
    (loop as any).messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'SEED' },
      { role: 'user', content: 'INJ-1' }, { role: 'assistant', content: 'A1', toolCalls: [{ id: 'c1' }] }, { role: 'tool', toolCallId: 'c1', content: 'T1' },
      { role: 'user', content: 'INJ-2' }, { role: 'assistant', content: 'A2', toolCalls: [{ id: 'c2' }] }, { role: 'tool', toolCallId: 'c2', content: 'T2' },
      { role: 'user', content: 'INJ-3' }, { role: 'assistant', content: 'A3' },
    ];
    (loop as any).trimMessages();
    const msgs = (loop as any).messages;
    assert.equal(msgs.length, 8);
    assert.deepEqual(msgs.map((m: any) => m.role), ['system', 'user', 'user', 'user', 'assistant', 'tool', 'user', 'assistant']);
    assert.ok(msgs[3].content.includes('条步骤历史已截断'), '截断标记为独立 user 消息');
    assert.ok(!msgs[3].content.includes('A1') && !msgs[3].content.includes('INJ-2'), '标记只报条数，不携带被截内容');
    // 配对完整性：每个 tool 消息的前一条必须是 assistant（OpenAI 孤儿校验）
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].role === 'tool') assert.equal(msgs[i - 1].role, 'assistant', `tool@${i} 前必须是 assistant`);
    }
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'assistant' && msgs[i].toolCalls?.length) {
        assert.ok(i + 1 < msgs.length && msgs[i + 1].role === 'tool', `assistant@${i} 的 tool_calls 必须紧跟 tool 结果`);
      }
    }
  });

  it('端到端：3 步后溢出 → 重试前真实裁剪 messages（旧实现只置 flag，重试必败）', async () => {
    const mkCall = (id: string) => ({
      toolName: 'bash',
      params: [{ name: 'command', value: 'echo ok' }],
      rawBlock: JSON.stringify({ id, type: 'function', function: { name: 'bash', arguments: '{"command":"echo ok"}' } }),
      format: 'openai-json',
    });
    let calls = 0;
    const model: any = { messagesSeen: [] as any[][] };
    model.chat = async (messages: any[]) => {
      calls++;
      model.messagesSeen.push(JSON.parse(JSON.stringify(messages)));
      if (calls === 4) {
        const e: any = new Error('maximum context length exceeded');
        e.status = 413;
        throw e;
      }
      if (calls <= 3) return { content: '运行验证', toolCalls: [mkCall('call_gw' + calls)], detectedFormat: 'openai-json' };
      return '验证通过。';
    };
    const engine = {
      toolSchemas: () => [{ name: 'bash', description: 'run shell', parameters: { type: 'object', properties: {} } }],
      async execute(_calls: any[]) { return 'ALL_TESTS_PASSED\nEXIT_CODE:0'; },
    };
    const loop = new VerifyCritiqueLoop(model, engine, { practicalMode: true, maxSteps: 6, systemSegment: 'STABLE' });
    const out = await loop.run('TASK');
    assert.ok(out.stopReason === 'answered' || out.stopReason === 'completed', `溢出重试必须成功落定：got ${out.stopReason}`);

    // 失败调用（第 4 次）：完整栈 = sys+seed+首步注入 + 3×(assistant+tool) = 9
    assert.equal(model.messagesSeen[3].length, 9, '溢出前是完整栈');
    // 重试调用（第 5 次）：前缀 3 + 截断标记 1 + 末 2 交换对 4 + 溢出提示注入 1 = 9
    const retry = model.messagesSeen[4];
    assert.equal(retry.length, 9, '重试前栈已被真实裁剪');
    assert.equal(retry[3].role, 'user');
    assert.ok(retry[3].content.includes('条步骤历史已截断'), '重试栈带截断标记');
    assert.deepEqual(
      retry.map((m: any) => m.role),
      ['system', 'user', 'user', 'user', 'assistant', 'tool', 'assistant', 'tool', 'user'],
    );
    for (let i = 1; i < retry.length; i++) {
      if (retry[i].role === 'tool') assert.equal(retry[i - 1].role, 'assistant', '无孤儿 tool 消息');
    }
    assert.equal(retry[4].toolCalls?.[0]?.id, 'call_gw2', '末 2 交换对的网关 id 原样保留');
  });
});
