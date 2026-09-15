// 对话事实记忆（0.8.2 → 2026-09-13 写路径"宽进严排"改造）：
// 对卡无条件落卡（source='dialogue-pair'）/ 去重 / 噪音不再整轮拒收
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

  it('正常对话 → 对卡 1 张 + 句级补充卡（宽进严排）', async () => {
    const r = await recordChatFact(ws, '我今天买了一辆红色的特斯拉', '好的，已记录你的新车信息');
    assert.equal(r.recorded, true);
    const file = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach-memory.json'), 'utf8'));
    // 对卡（无条件）+ user/assistant 高置信句级补充卡
    const pair = file.cards.filter((c: any) => c.source === 'dialogue-pair');
    assert.equal(pair.length, 1, '每轮恰 1 张对卡');
    assert.equal(pair[0].kind, 'preference', 'kind 沿用 preference（容量桶语义不变）');
    assert.equal(typeof pair[0].confidence, 'number', '对卡带分类器置信度');
    for (const c of file.cards) {
      assert.equal(c.kind, 'preference');
      assert.equal(c.memoryCategory, 'insight', 'insight 才在 high 档可见');
    }
    assert.ok(file.cards.some((c: any) => c.summary.includes('特斯拉')));
  });

  it('短输入 / 问候噪音 → 只落对卡（噪音不再整轮拒收，质量后移到检索端软惩罚）', async () => {
    const r1 = await recordChatFact(ws, '1', '答');
    assert.equal(r1.recorded, true, '过短轮也落对卡（宽进）');
    const f1 = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach-memory.json'), 'utf8'));
    assert.equal(f1.cards.length, 1, '且仅对卡 1 张（碎片被写入侧拦住，无句级卡）');
    assert.equal(f1.cards[0].source, 'dialogue-pair');

    const ws2 = tmpWs();
    const r2 = await recordChatFact(ws2, '你好', '你好！');
    assert.equal(r2.recorded, true, '问候轮也落对卡');
    const f2 = JSON.parse(fs.readFileSync(path.join(ws2, '.panshalach-memory.json'), 'utf8'));
    assert.equal(f2.cards.length, 1, '且仅对卡 1 张');
    fs.rmSync(ws2, { recursive: true, force: true });
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
