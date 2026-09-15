// tests/memory/ChatFactMemoryC2.test.ts
// 包C 缺陷6 对抗性回归（2026-09-13 记忆系统审计）+ 写路径"宽进严排"新语义同步：
//   (a) 第一人称正则无词界缺陷 → confidenceOf 用 /\b(?:my|i|we|our)\b/i + 大写开头；
//   (b) CJK 范围扩宽（Ext-A / 全角形式）；
//   (c) turnTag 去重键剥离【…】前缀（跨分钟同句不重复落卡）。
//   2026-09-13 改造：落卡单元 = 对话对（source='dialogue-pair'，无条件落卡），
//   低置信句不再阻断落卡、只影响句级补充卡的发射与检索端软惩罚——原"不成卡"
//   断言相应改为"不成句级卡（仅对卡）"。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordChatFact, confidenceOf } from '../../src/memory/chatFactMemory.js';

let ws = '';
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-chatfact-c2-')); });
afterEach(() => { if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; } });

function cardCount(dir: string): number {
  const fp = path.join(dir, '.panshalach-memory.json');
  if (!fs.existsSync(fp)) return 0;
  return JSON.parse(fs.readFileSync(fp, 'utf8')).cards.length;
}
function cards(dir: string): any[] {
  const fp = path.join(dir, '.panshalach-memory.json');
  return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')).cards : [];
}
const sentenceCards = (dir: string): any[] => cards(dir).filter((c) => c.summary.startsWith('【对话事实'));

describe('包C 缺陷6a：第一人称词界（无词界时任何含字母 i 的英文句命中）', () => {
  it('含字母 i、无独立 my/i/we/our 的英文句 → 0.4 低置信，不成句级卡（对卡仍无条件落）', async () => {
    assert.equal(confidenceOf('Unit testing works nicely'), 0.4, '分类器：无第一人称词 → 0.4');
    const r = await recordChatFact(ws, 'Unit testing works nicely', '');
    assert.equal(r.recorded, true, '宽进：对卡无条件落卡');
    assert.equal(cardCount(ws), 1, '仅对卡 1 张');
    assert.equal(sentenceCards(ws).length, 0, '低置信句不成句级卡（旧 /(my|i|we|our)/i 会误判成卡）');
  });

  it('独立第一人称词仍命中（词界加严不误伤）', async () => {
    assert.equal(confidenceOf('My favorite editor is Zed'), 0.7, '\\bmy\\b + 大写开头 → 0.7');
    const r = await recordChatFact(ws, 'My favorite editor is Zed', '');
    assert.equal(r.recorded, true);
    assert.equal(sentenceCards(ws).length, 1, '0.7 句照常发射句级卡（+对卡共 2 张）');
    assert.equal(cardCount(ws), 2);
  });
});

describe('包C 缺陷6b：CJK 范围扩宽（Ext-A / 全角形式）', () => {
  it('Ext-A 字符句（U+3400 起）→ 可成卡（旧 [一-龥] 丢弃）', async () => {
    const extA = '㐀㐁㐂㐃㐄㐅㐆㐇㐈㐊㐋㐌㐍㐎'; // U+3400..U+340D，14 字（≥ 最短门 12）
    assert.equal(confidenceOf(extA), 0.8, 'Ext-A 在 CJK 宽范围内');
    const r = await recordChatFact(ws, extA, '');
    assert.equal(r.recorded, true, `旧 [一-龥] 不认 Ext-A → 整句被丢弃，got ${r.recorded}`);
    assert.equal(cardCount(ws), 2, '句级卡 1 + 对卡 1');
  });

  it('全角标点句（U+FF01）→ 可成卡', async () => {
    const full = '配置文件路径写死了，这是坑！！'; // 含全角 ！(U+FF01)，14 字
    const r = await recordChatFact(ws, full, '');
    assert.equal(r.recorded, true);
  });
});

describe('包C 缺陷6c：跨分钟同句去重（去重键剥离【…】时间戳前缀）', () => {
  it('同一句两次 recordConversationTurn 间隔 61 秒（跨分钟）→ 盘上不再新增', async () => {
    const realNow = Date.now;
    // :50 起跳，+61s 必跨分钟 → 旧实现 turnTag 进 summary → summary 全等失败 → 重复落卡
    const base = new Date('2026-09-13T10:00:50.000Z').getTime();
    try {
      Date.now = () => base;
      const r1 = await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
      assert.equal(r1.recorded, true, '前置：第一句正常成卡');
      assert.equal(cardCount(ws), 2, '对卡 1 + 句级卡 1（"了解"过短不成句级卡）');

      Date.now = () => base + 61_000;
      const r2 = await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
      assert.equal(r2.recorded, false, '跨分钟同句必须命中去重（旧实现误判为新卡重复落盘）');
      assert.equal(r2.reason, 'duplicate');
    } finally {
      Date.now = realNow;
    }
    assert.equal(cardCount(ws), 2, '盘上仍 2 张卡');
  });

  it('句级卡 summary 仍带【…】时间戳前缀（展示契约保持，仅去重键剥离）', async () => {
    await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
    const sent = sentenceCards(ws)[0];
    assert.ok(sent, '句级卡在场');
    assert.ok(sent.summary.startsWith('【对话事实'), '句级卡保留来源标记（展示用）');
    assert.ok(!cards(ws).find((c) => c.source === 'dialogue-pair')!.summary.startsWith('【'), '对卡无【】前缀（Q:/A: 形态）');
  });

  it('不同句子跨分钟照常成新卡（去重不误伤）', async () => {
    const realNow = Date.now;
    const base = new Date('2026-09-13T10:00:50.000Z').getTime();
    try {
      Date.now = () => base;
      await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
      Date.now = () => base + 61_000;
      const r2 = await recordChatFact(ws, '我的团队在杭州，做前端方向', '好的');
      assert.equal(r2.recorded, true, '不同句子跨分钟照常成卡');
    } finally {
      Date.now = realNow;
    }
    assert.equal(cardCount(ws), 4, '两轮各（对卡 1 + 句级卡 1）共 4 张');
  });
});
