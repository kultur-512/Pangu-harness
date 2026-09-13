// tests/memory/TimeAnchor.test.ts
// 记忆时间锚定（0.8.3 · temporal-reasoning 题型 0/15 归因修复）：
//   架构原则：区分"何时记的"（lastSeen，衰减语义不动）与"记的是何时的事"
//   （factDate，新增）与"现在是何时"（消费者 prompt 注入）。
//   失败主因（13/15）：播种把 Date.now() 写进卡前缀冒充事实时间（假日期污染）
//   + QA prompt 没有"今天是几号"。本文件锁三件事：
//     (a) resolveToday 三态（env 合法/非法/未设）；
//     (b) recordConversationTurn/recordFactLines 的 sessionDate → 事实时间贯通
//         （前缀日期级、去时分秒、factDate/factDateText 落盘、解析失败回退当天）；
//     (c) 消费者（StructuredReasoner chat 指令）今天感知。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveToday } from '../../src/memory/timeAnchor.js';
import { recordConversationTurn, recordChatFact, recordFactLines } from '../../src/memory/chatFactMemory.js';
import { StructuredReasoner } from '../../src/reasoning/StructuredReasoner.js';

let ws = '';
let savedEnv = '';
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-timeanchor-'));
  savedEnv = process.env.PANSHA_TODAY ?? '';
  delete process.env.PANSHA_TODAY;
});
afterEach(() => {
  if (savedEnv) process.env.PANSHA_TODAY = savedEnv;
  else delete process.env.PANSHA_TODAY;
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
});

function cards(dir: string): any[] {
  const fp = path.join(dir, '.panshalach-memory.json');
  return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')).cards : [];
}

const REAL_TODAY = (): string => new Date().toISOString().slice(0, 10);

describe('resolveToday：PANSHA_TODAY 三态', () => {
  it('env 合法（yyyy-MM-dd）→ 采用 env', () => {
    process.env.PANSHA_TODAY = '2023-01-19';
    assert.equal(resolveToday(), '2023-01-19');
  });

  it('env 格式非法 → 回退真实今天', () => {
    process.env.PANSHA_TODAY = '2023/01/19';
    assert.equal(resolveToday(), REAL_TODAY());
    process.env.PANSHA_TODAY = 'not-a-date';
    assert.equal(resolveToday(), REAL_TODAY());
  });

  it('env 日历非法（2023-02-31 会被 Date 滚动成 3 月）→ 回退真实今天', () => {
    // V8 实证：new Date('2023-02-31') 不抛错而是滚动 → 2023-03-03，
    // 仅查 Number.isNaN(getTime()) 会误收假日期，必须组件回环校验。
    process.env.PANSHA_TODAY = '2023-02-31';
    assert.equal(resolveToday(), REAL_TODAY());
  });

  it('env 未设 → 真实当天', () => {
    assert.equal(resolveToday(), REAL_TODAY());
  });
});

describe('recordConversationTurn：sessionDate → 事实时间贯通', () => {
  it('sessionDate（LME haystack_dates 格式）→ 前缀为日期级事实时间，不含时分秒；factDate/factDateText 落盘', async () => {
    const r = await recordConversationTurn(
      ws, '我今天买了一辆红色的特斯拉', '好的，已记录你的新车信息',
      { sessionDate: '2023/01/19 (Thu) 05:19' }
    );
    assert.equal(r.recorded > 0, true, '前置：正常成卡');
    const file = cards(ws);
    assert.ok(file.length >= 1);
    // 2026-09-13 宽进严排：对卡（Q:/A: 形态，无【】前缀）+ 句级卡（带前缀），
    // 事实时间贯通两者（factDate/factDateText）。
    const sentenceCards = file.filter((c) => c.summary.startsWith('【对话事实·'));
    assert.ok(sentenceCards.length >= 1, '句级卡在场');
    for (const c of sentenceCards) {
      assert.ok(c.summary.includes('·2023-01-19】'), `前缀用事实日期: ${c.summary.slice(0, 24)}`);
      assert.ok(!/\d{2}:\d{2}/.test(c.summary), `前缀不得带时分秒: ${c.summary.slice(0, 24)}`);
    }
    for (const c of file) {
      assert.equal(c.factDateText, '2023-01-19', 'factDateText=yyyy-MM-dd 落盘（对卡同享）');
      assert.equal(c.factDate, Date.UTC(2023, 0, 19), 'factDate=该日 UTC ms');
      // lastSeen 语义不动（"何时记的"= 当天，非事实日期）
      assert.ok(Math.abs(c.lastSeen - Date.now()) < 60_000, 'lastSeen 仍是记录时刻（衰减语义不变）');
    }
  });

  it('不带 opts → 回退当天（PANSHA_TODAY 可控验证），产品语义不变', async () => {
    process.env.PANSHA_TODAY = '2024-06-01';
    const r = await recordConversationTurn(ws, '我在上海工作，职位是后端工程师', '了解');
    assert.equal(r.recorded > 0, true);
    const file = cards(ws);
    const sentenceCards = file.filter((c) => c.summary.startsWith('【对话事实·'));
    assert.ok(sentenceCards.length >= 1, '句级卡在场');
    for (const c of sentenceCards) {
      assert.ok(c.summary.includes('·2024-06-01】'), `不传 sessionDate 时事实时间=今天: ${c.summary.slice(0, 24)}`);
      assert.ok(!/\d{2}:\d{2}/.test(c.summary));
    }
    for (const c of file) {
      assert.equal(c.factDateText, '2024-06-01', '对卡 factDateText 同步回退今天');
    }
  });

  it('sessionDate 解析失败 → 回退当天（不落假日期）', async () => {
    process.env.PANSHA_TODAY = '2024-06-01';
    await recordConversationTurn(ws, '我在上海工作，职位是后端工程师', '了解', { sessionDate: 'garbage-no-date' });
    for (const c of cards(ws)) {
      assert.equal(c.factDateText, '2024-06-01', '解析失败回退今天（对卡/句级卡一致）');
    }
    const sentenceCards = cards(ws).filter((c) => c.summary.startsWith('【对话事实·'));
    assert.ok(sentenceCards.every((c) => c.summary.includes('·2024-06-01】')), '句级卡前缀回退今天');
  });

  it('去重键跨事实日期仍生效（stripTurnTag 对日期级新格式照常剥前缀）', async () => {
    const a = await recordConversationTurn(ws, '我在上海工作，职位是后端工程师', '了解', { sessionDate: '2023/01/19 (Thu) 05:19' });
    assert.equal(a.recorded > 0, true);
    // 同句不同事实日期：句级卡前缀不同（id 随 summary 变）但去重键剥前缀后相同 →
    // 不重复落卡；对卡（无日期前缀，Q/A 全同）也命中去重。
    const b = await recordConversationTurn(ws, '我在上海工作，职位是后端工程师', '了解', { sessionDate: '2023/05/20 (Sat) 10:00' });
    assert.equal(b.recorded, 0, '同句换事实日期不得重复落卡');
    assert.equal(b.reason, 'duplicate');
    assert.equal(cards(ws).length, 2, '盘上仍（对卡 1 + 句级卡 1）共 2 张');
  });
});

describe('recordChatFact / recordFactLines：sessionDate 透传', () => {
  it('recordChatFact 透传 sessionDate', async () => {
    const r = await recordChatFact(ws, '我今天买了一辆红色的特斯拉', '好的', { sessionDate: '2023/01/19 (Thu) 05:19' });
    assert.equal(r.recorded, true);
    assert.ok(cards(ws).every((c) => c.factDateText === '2023-01-19'));
  });

  it('recordFactLines 透传 sessionDate → 卡带事实时间字段', async () => {
    const r = await recordFactLines(ws, ['用户的猫叫 Murphy，三岁', '用户住在西雅图'], { sessionDate: '2023/05/23 (Tue) 08:00' });
    assert.equal(r.recorded, 2, '前置：两行都落卡');
    assert.ok(cards(ws).every((c) => c.factDateText === '2023-05-23'), 'factDateText 透传落盘');
    assert.ok(cards(ws).every((c) => c.factDate === Date.UTC(2023, 4, 23)));
  });

  it('recordFactLines 不传 sessionDate → 不带 factDateText 字段（老卡渲染不变）', async () => {
    await recordFactLines(ws, ['用户的猫叫 Murphy，三岁', '用户住在西雅图']);
    assert.ok(cards(ws).every((c) => c.factDateText === undefined), '无字段老卡语义');
  });
});

describe('消费者今天感知：StructuredReasoner chat 指令', () => {
  it('buildChatSystemDirective 注入"今天是 …"（PANSHA_TODAY 可控）', () => {
    process.env.PANSHA_TODAY = '2023-01-19';
    const d = StructuredReasoner.buildChatSystemDirective();
    assert.ok(d.includes('今天是 2023-01-19。'), 'chat system 指令带今天');
    assert.ok(d.includes('事实日期'), '指明与记忆卡事实日期做差');
  });
});
