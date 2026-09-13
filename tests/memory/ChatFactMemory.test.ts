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

  it('正常对话 → 落卡（preference/insight，summary 带双方内容）', async () => {
    const r = await recordChatFact(ws, '我今天买了一辆红色的特斯拉', '好的，已记录你的新车信息');
    assert.equal(r.recorded, true);
    const file = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach-memory.json'), 'utf8'));
    assert.equal(file.cards.length, 1);
    assert.equal(file.cards[0].kind, 'preference');
    assert.equal(file.cards[0].memoryCategory, 'insight', 'insight 才在 high 档可见');
    assert.ok(file.cards[0].summary.includes('特斯拉'));
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
