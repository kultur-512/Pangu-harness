// tests/loop/CjkBudget.test.ts
// 包B 对抗性回归（循环 / 计量 / 分段）：
//
// 【P0】CJK 收缩死循环：shrinkLargestToolMessage 旧实现按 ASCII 4 chars/token
// 反推 head/tail 字符数，而 estTokens 对 CJK 按 1.5 token/字符计 → 纯中文巨工具
// 结果收缩后 estTokens ≈ 5.1×capTokens 恒超 cap → enforceMessagesBudget 的
// for(;;) 永不收敛（生产常量复现：windowTokens=32768、16000 中文字符 tool 消息、
// 2 交换组，token 冻结在 23636 > cap 22937.6，迭代 18 万次不终止）。
// 修复三件套：
//   (a) 截断尺寸按 estTokens 反推——head+tail token 预算 = capTokens*0.85；
//   (b) for(;;) 迭代上限 + "本次收缩未使最大 tool 消息 token 数下降即退出"；
//   (c) 单条消息最小保留长度下限。
//
// 【P2】多调用分段失真：结果 '\n---\n' 分段数与调用数不匹配时，旧实现把整段
// resultText 复制进每条 tool 消息（N×20% 窗口）→ 改为有界预览 + 完整结果只落
// 最后一条，总预算不超窗口。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VerifyCritiqueLoop } from '../../src/loop/VerifyCritiqueLoop.js';
import { estTokens } from '../../src/cli/repl/tokenEstimate.js';

function bareLoop(windowTokens?: number): any {
  const loop = new VerifyCritiqueLoop({} as any, {} as any, { practicalMode: true });
  if (windowTokens !== undefined) (loop as any).windowTokens = windowTokens;
  return loop;
}

function tc(toolName: string): any {
  return { toolName, params: [{ name: 'file_path', value: 'a.txt' }], rawBlock: '' };
}

// ==================== 【P0】issue 1：CJK 收缩死循环 ====================
describe('C1【P0】CJK 收缩死循环（生产常量复现）', () => {
  it('纯中文 16000 字符 tool 消息 ×2 交换组：enforceMessagesBudget 有限时间收敛到 70% 预算内', () => {
    const loop = bareLoop(32768);
    loop.messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '任务：' + '设'.repeat(200) },
      { role: 'user', content: '注入1' },
      { role: 'assistant', content: 'A1', toolCalls: [{ id: 'c1' }] },
      { role: 'tool', toolCallId: 'c1', content: '中'.repeat(16000) },
      { role: 'user', content: '注入2' },
      { role: 'assistant', content: 'A2', toolCalls: [{ id: 'c2' }] },
      { role: 'tool', toolCallId: 'c2', content: '文'.repeat(16000) },
    ];
    const cap = 32768 * 0.7; // 22937.6
    const t0 = Date.now();
    const acted = loop.enforceMessagesBudget(cap);
    const dt = Date.now() - t0;
    assert.equal(acted, true, '必须做过裁剪');
    assert.ok(dt < 5000, `必须在有限时间返回（修复前迭代 18 万次不终止）：took ${dt}ms`);
    const tokens = loop.messagesTokens();
    assert.ok(tokens <= cap, `收缩后必须收敛到预算内：got ${tokens} > cap ${cap}`);
    // 每条巨 tool 消息都被压到单条封顶（20% 窗口）以内（允许截断标记的少量开销）
    const capPerMsg = 32768 * 0.7 * 0.2;
    for (const m of loop.messages) {
      if (m.role === 'tool') {
        const t = estTokens(typeof m.content === 'string' ? m.content : '');
        assert.ok(t <= capPerMsg + capPerMsg * 0.2, `单条 tool 消息必须收敛：got ${t} > ${capPerMsg}`);
        assert.ok(m.content.includes('工具输出过长已截断'), '带显式截断标记');
      }
    }
  });

  it('多条 CJK 巨结果逐条收缩仍有限终止（迭代上限 + 进展检查保护）', () => {
    const loop = bareLoop(8000);
    const msgs: any[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'SEED' },
    ];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: 'assistant', content: 'A' + i, toolCalls: [{ id: 'c' + i }] });
      msgs.push({ role: 'tool', toolCallId: 'c' + i, content: '结'.repeat(2000) });
    }
    loop.messages = msgs;
    const t0 = Date.now();
    const acted = loop.enforceMessagesBudget(8000 * 0.7);
    const dt = Date.now() - t0;
    assert.equal(acted, true);
    assert.ok(dt < 5000, `有限终止（修复前永不收敛）：${dt}ms`);
    // 总预算收敛（裁不到的尾部巨消息按预算语义保留——收缩只对超预算时的
    // 最大 tool 消息动手，总账收敛即停，与 ASCII 路径语义一致）
    assert.ok(loop.messagesTokens() <= 8000 * 0.7, `总预算收敛：${loop.messagesTokens()}`);
    // 巨消息确实被收缩过（存在带截断标记的 tool 消息）
    assert.ok(
      loop.messages.some((m: any) => m.role === 'tool' && String(m.content).includes('工具输出过长已截断')),
      '至少一条巨结果被二级收缩',
    );
  });

  it("ASCII 巨工具结果行为不回归（'T'.repeat(3000) 场景）", () => {
    const loop = bareLoop(1000);
    loop.messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'GIANT-SEED ' + 'S'.repeat(1000) },
      { role: 'assistant', content: 'A1', toolCalls: [{ id: 'c1' }] },
      { role: 'tool', toolCallId: 'c1', content: 'BIG ' + 'T'.repeat(3000) },
    ];
    const acted = loop.enforceMessagesBudget(700);
    assert.equal(acted, true, '必须做过裁剪');
    const msgs = loop.messages;
    assert.equal(msgs.length, 4, '组数不足时不丢组');
    assert.ok(msgs[3].content.includes('工具输出过长已截断'), '最大 tool 消息被二级截断');
    assert.ok(msgs[3].content.startsWith('BIG '), '保留头段');
    assert.ok(loop.messagesTokens() <= 700 + 400, `收缩后逼近预算：${loop.messagesTokens()}`);
  });
});

// ==================== 【P2】issue 5：多调用分段失真 ====================
describe('多调用分段失真：分段数 ≠ 调用数时有界预览 + 完整结果只落最后一条', () => {
  it('3 调用 1 段结果：前两条为有界预览（带说明标记），完整结果只在最后一条', () => {
    const loop = bareLoop(32768);
    const resultText = 'FULL-RESULT-BODY ' + 'y'.repeat(2000);
    loop.pushToolMessages([tc('read_file'), tc('grep'), tc('read_file')], null, resultText);
    const msgs = loop.messages;
    assert.equal(msgs.length, 3);
    // 前两条：有界预览 + 说明标记（旧实现整段复制 → 各 ~2017 字符且无标记）
    for (const m of [msgs[0], msgs[1]]) {
      assert.ok(m.content.includes('多调用结果无法按调用切分'), '预览必须带说明标记');
      assert.ok(m.content.length < 1000, `预览长度有界（旧实现 ≈ 整段长度）：${m.content.length}`);
    }
    // 最后一条：完整结果（本例远小于单条封顶，原样保留）
    assert.equal(msgs[2].content, resultText, '完整结果放最后一条');
    // 总预算有界：3 条之和不再 > 2× 整段
    const total = msgs.reduce((acc: number, m: any) => acc + m.content.length, 0);
    assert.ok(total < resultText.length * 2 + 2000, `总预算有界：${total}`);
  });

  it('3 调用 1 段结果且单条超预算：最后一条仍受单条封顶约束（总预算不超窗口）', () => {
    const loop = bareLoop(1000); // budgetChars = 800
    const resultText = 'HEAD ' + 'Z'.repeat(4000) + ' TAIL';
    loop.pushToolMessages([tc('a'), tc('b'), tc('c')], null, resultText);
    const msgs = loop.messages;
    assert.equal(msgs.length, 3);
    for (const m of msgs) {
      assert.ok(m.content.length < 1200, `每条 tool 消息长度有界：${m.content.length}`);
    }
    assert.ok(msgs[2].content.startsWith('HEAD ') && msgs[2].content.endsWith('TAIL'), '最后一条保留头尾');
  });

  it('单调用结果（分段天然匹配）：行为不回归（原文回灌 + 单条封顶）', () => {
    const loop = bareLoop(1000);
    loop.pushToolMessages([tc('read_file')], null, 'HEAD-MARK ' + 'X'.repeat(1200) + ' TAIL-MARK');
    assert.equal(loop.messages.length, 1);
    const c = loop.messages[0].content;
    assert.ok(c.startsWith('HEAD-MARK'), '保留头段');
    assert.ok(c.endsWith('TAIL-MARK'), '保留尾段');
    assert.ok(c.includes('工具输出过长已截断'), '带显式截断标记');
    assert.ok(c.length < 1200);
  });

  it('分段数匹配（多调用）：逐 call 切分不回归', () => {
    const loop = bareLoop(undefined);
    loop.pushToolMessages([tc('a'), tc('b')], null, 'P1\n---\nP2');
    assert.deepEqual(loop.messages.map((m: any) => m.content), ['P1', 'P2']);
  });
});
