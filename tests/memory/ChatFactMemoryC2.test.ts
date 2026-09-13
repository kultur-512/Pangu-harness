// tests/memory/ChatFactMemoryC2.test.ts
// 包C 缺陷6 对抗性回归（2026-09-13 记忆系统审计）：
//   (a) 第一人称正则 /(my|i|we|our)/i 无词界——任何含字母 i 的英文句都命中；
//       修复：/\b(?:my|i|we|our)\b/i。
//   (b) [一-龥] URO 窄——扩为与包 B 对齐的 CJK 范围（0x3000-0x9FFF +
//       0xFF00-0xFFEF + Ext-A 0x3400-0x4DBF）。
//   (c) turnTag（分钟级时间戳）拼进 summary 且去重键是 summary 全等 → 跨分钟
//       同句重复落卡。修复：去重键 = 剥离【…】前缀后的句子内容；summary 仍带
//       时间戳供展示。现有用例是同分钟调用，恰好掩盖了该缺陷——这里补跨分钟。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordChatFact } from '../../src/memory/chatFactMemory.js';

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

describe('包C 缺陷6a：第一人称词界（无词界时任何含字母 i 的英文句命中）', () => {
  it('含字母 i、有大写、但无独立 my/i/we/our 的英文句 → 不成卡（旧实现误判成卡）', async () => {
    const r = await recordChatFact(ws, 'Unit testing works nicely', '');
    assert.equal(r.recorded, false, `旧 /(my|i|we|our)/i 把 unit 里的 i 当第一人称 → 误落卡`);
    assert.equal(cardCount(ws), 0);
  });

  it('独立第一人称词仍命中（词界加严不误伤）', async () => {
    const r = await recordChatFact(ws, 'My favorite editor is Zed', '');
    assert.equal(r.recorded, true, '\\bmy\\b 独立词照常命中');
    assert.equal(cardCount(ws), 1);
  });
});

describe('包C 缺陷6b：CJK 范围扩宽（Ext-A / 全角形式）', () => {
  it('Ext-A 字符句（U+3400 起）→ 可成卡（旧 [一-龥] 丢弃）', async () => {
    const extA = '㐀㐁㐂㐃㐄㐅㐆㐇㐈㐊㐋㐌㐍㐎'; // U+3400..U+340D，14 字（≥ 最短门 12）
    const r = await recordChatFact(ws, extA, '');
    assert.equal(r.recorded, true, `旧 [一-龥] 不认 Ext-A → 整句被丢弃，got ${r.recorded}`);
    assert.equal(cardCount(ws), 1);
  });

  it('全角标点句（U+FF01）→ 可成卡', async () => {
    const full = '配置文件路径写死了，这是坑！！'; // 含全角 ！(U+FF01)，14 字
    const r = await recordChatFact(ws, full, '');
    assert.equal(r.recorded, true);
  });
});

describe('包C 缺陷6c：跨分钟同句去重（去重键剥离【…】时间戳前缀）', () => {
  it('同一句两次 recordConversationTurn 间隔 61 秒（跨分钟）→ 盘上仍 1 张卡', async () => {
    const realNow = Date.now;
    // :50 起跳，+61s 必跨分钟 → 旧实现 turnTag 进 summary → summary 全等失败 → 重复落卡
    const base = new Date('2026-09-13T10:00:50.000Z').getTime();
    try {
      Date.now = () => base;
      const r1 = await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
      assert.equal(r1.recorded, true, '前置：第一句正常成卡');
      assert.equal(cardCount(ws), 1);

      Date.now = () => base + 61_000;
      const r2 = await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
      assert.equal(r2.recorded, false, '跨分钟同句必须命中去重（旧实现误判为新卡重复落盘）');
      assert.equal(r2.reason, 'duplicate');
    } finally {
      Date.now = realNow;
    }
    assert.equal(cardCount(ws), 1, '盘上仍 1 张卡');
  });

  it('summary 仍带【…】时间戳前缀（展示契约保持，仅去重键剥离）', async () => {
    await recordChatFact(ws, '我在上海工作，职位是后端工程师', '了解');
    const c = cards(ws)[0];
    assert.ok(c.summary.startsWith('【对话事实'), 'summary 保留来源标记（展示用）');
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
    assert.equal(cardCount(ws), 2);
  });
});
