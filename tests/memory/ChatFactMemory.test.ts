// 对话事实记忆（0.8.2）：确定性落卡 / 去重 / 噪音门（LongMemEval 真实路径驱动）
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordChatFact } from '../../src/memory/chatFactMemory.js';

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lme-chatfact-'));
}

describe('recordChatFact', () => {
  let ws: string;
  beforeEach(() => { ws = tmpWs(); });

  it('正常对话 → 句级拆卡（user/assistant 事实句各一张）', async () => {
    const r = await recordChatFact(ws, '我今天买了一辆红色的特斯拉', '好的，已记录你的新车信息');
    assert.equal(r.recorded, true);
    const file = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach-memory.json'), 'utf8'));
    // 0.8.2 句级拆卡：user 事实句 + assistant 事实句各成一张卡
    assert.equal(file.cards.length, 2);
    for (const c of file.cards) {
      assert.equal(c.kind, 'preference');
      assert.equal(c.memoryCategory, 'insight', 'insight 才在 high 档可见');
      assert.ok(c.summary.startsWith('【对话事实'), '句级卡带来源标记');
    }
    assert.ok(file.cards.some((c: any) => c.summary.includes('特斯拉')));
  });

  it('短输入 / 问候噪音 → 不落卡', async () => {
    assert.equal((await recordChatFact(ws, '1', '答')).recorded, false, '过短');
    assert.equal((await recordChatFact(ws, '你好', '你好！')).recorded, false, '问候');
  });

  it('重复内容 → 去重不落卡', async () => {
    await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
    const r2 = await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
    assert.equal(r2.recorded, false, 'duplicate');
    assert.equal(r2.reason, 'duplicate');
  });

  it('PANSHA_CHAT_MEMORY=0 → 功能关闭', async () => {
    process.env.PANSHA_CHAT_MEMORY = '0';
    try {
      const r = await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
      assert.equal(r.reason, 'disabled');
    } finally {
      delete process.env.PANSHA_CHAT_MEMORY;
    }
  });
});
