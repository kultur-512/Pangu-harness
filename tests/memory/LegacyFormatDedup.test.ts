// tests/memory/LegacyFormatDedup.test.ts
// 【7】遗留格式互去重锁定测试（2026-09-13 迭代包 · 不修行为，锁定既有）：
// 去重键 = stripTurnTag（剥离前导【…】前缀）后的内容，与时间戳粒度/前缀
// 文案无关——老分钟级前缀卡（0.8.3 之前产品产物）、评测【S·date】前缀行
// （run-cells.mjs seedCompact 播种产物）与新产品对卡同内容互不去重、互不重复落盘。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordConversationTurn, recordFactLines } from '../../src/memory/chatFactMemory.js';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';

let ws = '';
const prevMemFile = process.env.PANSHA_MEMORY_FILE;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-legacy-dedup-'));
  delete process.env.PANSHA_MEMORY_FILE;
});
afterEach(() => {
  if (prevMemFile === undefined) delete process.env.PANSHA_MEMORY_FILE;
  else process.env.PANSHA_MEMORY_FILE = prevMemFile;
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
});

/** 手工写一张老格式卡（模拟 0.8.3 之前/评测播种的盘面遗留）。 */
function seedLegacy(wsDir: string, id: string, summary: string): void {
  const now = Date.now();
  new RefinedMemoryStore(wsDir).save([{
    id, kind: 'preference', category: 'OTHER', memoryCategory: 'insight',
    summary, weight: 0.5, taskStyle: 'all', count: 1,
    lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '遗留格式',
    decayWeight: 1.0, lastUsedAt: now,
  } as any]);
}

const readCards = (wsDir: string): any[] =>
  JSON.parse(fs.readFileSync(path.join(wsDir, '.panshalach-memory.json'), 'utf8')).cards;

describe('【7a】老分钟级前缀卡 × 新日期级同内容互去重（锁定既有）', () => {
  it('盘上老分钟级前缀对卡 → recordConversationTurn 同句 → recorded=0 且老格式卡原样保留', async () => {
    seedLegacy(ws, 'legacy-pair', '【对话事实·用户·2023-05-01 10:30】Q: Do you like tea?\nA: Yes, oolong daily.');
    const r = await recordConversationTurn(ws, 'Do you like tea?', 'Yes, oolong daily.');
    assert.equal(r.recorded, 0, '前缀剥离后同内容 → 不重复落盘');
    assert.equal(r.reason, 'duplicate');
    const cards = readCards(ws);
    assert.equal(cards.length, 1, '盘上仍只有 1 张卡');
    assert.ok(
      cards[0].summary.startsWith('【对话事实·用户·2023-05-01 10:30】'),
      '幸存的是老分钟级前缀卡（新格式未覆盖/未追加）'
    );
  });

  it('盘上老分钟级前缀句级卡 → 同句的用户侧句级候选不落新日期级重复卡', async () => {
    seedLegacy(ws, 'legacy-sent', '【对话事实·用户·2023-05-01 10:30】I ride my bike on Sundays');
    const r = await recordConversationTurn(ws, 'I ride my bike on Sundays', 'Noted, weekends are good.');
    const cards = readCards(ws);
    // 新日期级候选 `【对话事实·用户·<today>】I ride my bike on Sundays` 必须被老卡去重掉
    assert.ok(
      !cards.some((c) => /^【对话事实·用户·\d{4}-\d{2}-\d{2}】I ride my bike/.test(c.summary)),
      '同句不得以新日期级前缀重复落盘'
    );
    assert.ok(
      cards.some((c) => c.summary.startsWith('【对话事实·用户·2023-05-01 10:30】')),
      '老格式卡原样保留'
    );
    // 该轮仍会落对卡（对卡内容与遗留句卡不同键）——recorded 只计对卡
    assert.equal(r.recorded, 1);
    assert.equal(cards.length, 2);
  });
});

describe('【7b】评测【S·date】前缀行（recordFactLines）× 产品对卡同内容互去重（锁定既有）', () => {
  it('评测 S·date 前缀行在盘 → 产品同内容 turn recorded=0（评测播种不诱发产品重复卡）', async () => {
    const seeded = await recordFactLines(ws, ['【S·2023-01-19】Q: Is the sky blue?\nA: probably.']);
    assert.equal(seeded.recorded, 1, '前置：S·date 行落盘');
    const r = await recordConversationTurn(ws, 'Is the sky blue?', 'probably.');
    assert.equal(r.recorded, 0, 'stripTurnTag 对【S·date】同样生效 → 同内容不再落卡');
    const cards = readCards(ws);
    assert.equal(cards.length, 1, '盘上仍只有评测播种的 1 张');
    assert.ok(cards[0].summary.startsWith('【S·2023-01-19】'));
  });

  it('产品对卡在盘 → 评测精确同内容行 recorded=0（反向亦不重复）', async () => {
    await recordConversationTurn(ws, 'Is the sky blue?', 'probably.');
    assert.equal(readCards(ws).length, 1, '前置：产品对卡落盘');
    const r = await recordFactLines(ws, ['Q: Is the sky blue?\nA: probably.']);
    assert.equal(r.recorded, 0, 'recordFactLines 的 summary 全等去重命中产品对卡');
    assert.equal(readCards(ws).length, 1);
  });
});
