// tests/memory/RelTime.test.ts
// B9 相对时间检索信号（ROADMAP B9）单测：
//   - relTime.parseRelativeTimeRanges 五类覆盖：
//     (1) 绝对日期（中/英/ISO，组件回环校验防 2023-02-31 滚动）
//     (2) 中文相对（今天/昨天/前天/本周/上周/上上周/本月/上个月/今年/去年）
//     (3) 英文相对（today/yesterday/last week/last month/this year/last year/
//         N days|weeks|months|years ago / in the past N months）
//     (4) 歧义规避（裸 3月/May → 距 today 最近的历史月份；小写 may 仅
//         独立词+后接年份或前接 in/on 才认作月份）
//     (5) 非法输入 → []
//   - store 集成：factDate 落 range → _relevance +1 → 排序上升；无 factDate
//     老卡不变；PANSHA_TODAY 锚定经 resolveToday() 贯通。
// range 口径：[start, end) 半开区间，UTC ms；factDate = 当日 00:00 UTC ms
// （与 chatFactMemory.parseFactDate 同锚）。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRelativeTimeRanges } from '../../src/memory/relTime.js';
import { RefinedMemoryStore, setSemanticEmbedderForTest } from '../../src/memory/RefinedMemoryStore.js';

// 手工核定：2026-09-14 是周一（2026-01-01 周四，第 257 天 → (257-1)%7=4 → 周一）
const TODAY = '2026-09-14';

const U = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const R = (a: string, b: string): { start: number; end: number } => ({ start: U(a), end: U(b) });
const norm = (rs: Array<{ start: number; end: number }>) =>
  rs.map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start || a.end - b.end);
const eq = (
  got: Array<{ start: number; end: number }>,
  want: Array<{ start: number; end: number }>,
  msg?: string,
) =>
  assert.deepEqual(
    norm(got),
    norm(want),
    (msg ? `${msg} — ` : '') + JSON.stringify({ got: norm(got), want: norm(want) }),
  );

// ==================== (1) 绝对日期 ====================
describe('B9a：绝对日期（月/日/年粒度 + 回环校验）', () => {
  it('中文：2023年3月 → 月 range；2023年3月15日 → 日 range；2023年 → 年 range', () => {
    eq(parseRelativeTimeRanges('2023年3月', TODAY), [R('2023-03-01', '2023-04-01')]);
    eq(parseRelativeTimeRanges('2023年3月15日', TODAY), [R('2023-03-15', '2023-03-16')]);
    eq(parseRelativeTimeRanges('2023年', TODAY), [R('2023-01-01', '2024-01-01')]);
  });

  it('ISO：2023-03 → 月 range；2023-03-15 → 日 range；斜杠 2023/03/15 同', () => {
    eq(parseRelativeTimeRanges('2023-03', TODAY), [R('2023-03-01', '2023-04-01')]);
    eq(parseRelativeTimeRanges('2023-03-15', TODAY), [R('2023-03-15', '2023-03-16')]);
    eq(parseRelativeTimeRanges('2023/03/15', TODAY), [R('2023-03-15', '2023-03-16')]);
  });

  it('英文：March 2023 → 月 range；April 10, 2023 → 日 range；in 2023 → 年 range', () => {
    eq(parseRelativeTimeRanges('March 2023', TODAY), [R('2023-03-01', '2023-04-01')]);
    eq(parseRelativeTimeRanges('April 10, 2023', TODAY), [R('2023-04-10', '2023-04-11')]);
    eq(parseRelativeTimeRanges('in 2023', TODAY), [R('2023-01-01', '2024-01-01')]);
  });

  it('组件回环校验：2023-02-31 / 2023年2月31日 不滚动成 3 月 → []', () => {
    assert.equal(parseRelativeTimeRanges('2023-02-31', TODAY).length, 0);
    assert.equal(parseRelativeTimeRanges('2023年2月31日', TODAY).length, 0);
    assert.equal(parseRelativeTimeRanges('February 30, 2023', TODAY).length, 0);
  });
});

// ==================== (2) 中文相对 ====================
describe('B9b：中文相对时间（today=2026-09-14 周一）', () => {
  it('今天/昨天/前天 → 单日 range', () => {
    eq(parseRelativeTimeRanges('今天', TODAY), [R('2026-09-14', '2026-09-15')]);
    eq(parseRelativeTimeRanges('昨天', TODAY), [R('2026-09-13', '2026-09-14')]);
    eq(parseRelativeTimeRanges('前天', TODAY), [R('2026-09-12', '2026-09-13')]);
  });

  it('本周/上周/上上周（周一为周首）', () => {
    eq(parseRelativeTimeRanges('本周', TODAY), [R('2026-09-14', '2026-09-21')]);
    eq(parseRelativeTimeRanges('上周', TODAY), [R('2026-09-07', '2026-09-14')]);
    eq(parseRelativeTimeRanges('上上周', TODAY), [R('2026-08-31', '2026-09-07')]);
  });

  it('本月/上个月/今年/去年', () => {
    eq(parseRelativeTimeRanges('本月', TODAY), [R('2026-09-01', '2026-10-01')]);
    eq(parseRelativeTimeRanges('上个月', TODAY), [R('2026-08-01', '2026-09-01')]);
    eq(parseRelativeTimeRanges('今年', TODAY), [R('2026-01-01', '2027-01-01')]);
    eq(parseRelativeTimeRanges('去年', TODAY), [R('2025-01-01', '2026-01-01')]);
  });

  it('上个月不被上上周/上月别名串扰；跨年回退（1月的上个月=去年12月）', () => {
    eq(parseRelativeTimeRanges('上个月', TODAY), [R('2026-08-01', '2026-09-01')]);
    eq(parseRelativeTimeRanges('上月', TODAY), [R('2026-08-01', '2026-09-01')]);
    eq(parseRelativeTimeRanges('上个月', '2026-01-05'), [R('2025-12-01', '2026-01-01')]);
  });
});

// ==================== (3) 英文相对 ====================
describe('B9c：英文相对时间', () => {
  it('today / yesterday', () => {
    eq(parseRelativeTimeRanges('today', TODAY), [R('2026-09-14', '2026-09-15')]);
    eq(parseRelativeTimeRanges('yesterday', TODAY), [R('2026-09-13', '2026-09-14')]);
  });

  it('last week / last month / this year / last year', () => {
    eq(parseRelativeTimeRanges('last week', TODAY), [R('2026-09-07', '2026-09-14')]);
    eq(parseRelativeTimeRanges('last month', TODAY), [R('2026-08-01', '2026-09-01')]);
    eq(parseRelativeTimeRanges('this year', TODAY), [R('2026-01-01', '2027-01-01')]);
    eq(parseRelativeTimeRanges('last year', TODAY), [R('2025-01-01', '2026-01-01')]);
  });

  it('N days/weeks/months/years ago（days=单日；weeks=自然周块；months=日历月；years=日历年）', () => {
    eq(parseRelativeTimeRanges('3 days ago', TODAY), [R('2026-09-11', '2026-09-12')]);
    eq(parseRelativeTimeRanges('2 weeks ago', TODAY), [R('2026-08-31', '2026-09-07')]);
    eq(parseRelativeTimeRanges('2 months ago', TODAY), [R('2026-07-01', '2026-08-01')]);
    eq(parseRelativeTimeRanges('3 years ago', TODAY), [R('2023-01-01', '2024-01-01')]);
  });

  it('in the past N months → 滚动窗口 [today-N 月, 明天)', () => {
    eq(parseRelativeTimeRanges('in the past 3 months', TODAY), [R('2026-06-14', '2026-09-15')]);
    // 月末钳制：3月31日 - 2 个月 → 1月31日
    eq(parseRelativeTimeRanges('in the past 2 months', '2026-03-31'), [R('2026-01-31', '2026-04-01')]);
  });
});

// ==================== (4) 歧义规避 ====================
describe('B9d：歧义规避（裸月份 → 最近历史月；may 限定的判月条件）', () => {
  it('裸 3月 → 今年 3 月（已过）；9月 → 当月；12月 → 未来月回退去年', () => {
    eq(parseRelativeTimeRanges('3月', TODAY), [R('2026-03-01', '2026-04-01')]);
    eq(parseRelativeTimeRanges('9月', TODAY), [R('2026-09-01', '2026-10-01')], '当月不算未来');
    eq(parseRelativeTimeRanges('12月', TODAY), [R('2025-12-01', '2026-01-01')]);
  });

  it('裸大写 May → 最近历史月；in may（小写+in 前缀）→ 同；may 2023（小写+年份）→ 指定年月', () => {
    eq(parseRelativeTimeRanges('May', TODAY), [R('2026-05-01', '2026-06-01')]);
    eq(parseRelativeTimeRanges('in may', TODAY), [R('2026-05-01', '2026-06-01')]);
    eq(parseRelativeTimeRanges('may 2023', TODAY), [R('2023-05-01', '2023-06-01')]);
  });

  it('小写 may 无年份且无 in/on 前缀 → 不是日期（You may go / may be → []）', () => {
    assert.equal(parseRelativeTimeRanges('You may go', TODAY).length, 0);
    assert.equal(parseRelativeTimeRanges('may be late', TODAY).length, 0);
  });

  it('混合查询多 range：上个月和 March 2023 → 2 个 range；2023年3月 不被二次解析', () => {
    eq(
      parseRelativeTimeRanges('上个月和 March 2023', TODAY),
      [R('2026-08-01', '2026-09-01'), R('2023-03-01', '2023-04-01')],
    );
    eq(parseRelativeTimeRanges('2023年3月', TODAY), [R('2023-03-01', '2023-04-01')], '掩码扫描防年月二次匹配');
  });
});

// ==================== (5) 非法输入 ====================
describe('B9e：非法输入 → []', () => {
  it('空串/无时间表达/非字符串/非法 todayIso → []', () => {
    assert.equal(parseRelativeTimeRanges('', TODAY).length, 0);
    assert.equal(parseRelativeTimeRanges('no dates in this text', TODAY).length, 0);
    assert.equal(parseRelativeTimeRanges(undefined as unknown as string, TODAY).length, 0);
    assert.equal(parseRelativeTimeRanges('上个月', 'not-a-date').length, 0);
    assert.equal(parseRelativeTimeRanges('上个月', '2026-02-30').length, 0, 'today 本身非法（回环）→ []');
    assert.equal(parseRelativeTimeRanges('2023年13月', TODAY).length, 0, '13 月非法');
  });
});

// ==================== store 集成（B9 接线 + PANSHA_TODAY 锚定） ====================
describe('B9f：store 集成——factDate 落 range → 排序上升；老卡不变；PANSHA_TODAY 贯通', () => {
  let ws = '';
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-reltime-')); });
  afterEach(() => {
    setSemanticEmbedderForTest(null);
    delete process.env.PANSHA_TODAY;
    if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
  });

  const mkCard = (id: string, summary: string, extra: Record<string, unknown> = {}): any => {
    const now = Date.now();
    return {
      id, kind: 'preference', category: 'OTHER', memoryCategory: 'insight', summary,
      weight: 0.8, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now,
      applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now, ...extra,
    };
  };

  const makeStore = (): RefinedMemoryStore => {
    const store = new RefinedMemoryStore(ws, 'mem.json');
    const t = Date.now() - 60 * 60 * 1000; // 久远基准：两卡同处衰减第一段，eff 严格相等
    store.save([
      // newer：更新（+60s）、无 factDate —— 无时间信号时它按 lastSeen tie-break 排前
      mkCard('newer-nofact', '发型师推荐的护发素', { lastSeen: t + 60_000 }),
      // older：带 factDate（若命中查询 range 应翻到第一）
      mkCard('older-fact', '牙医预约改到了周二上午', { lastSeen: t, factDate: U('2026-08-10'), factDateText: '2026-08-10' }),
    ]);
    // 语义等权 embedder：cos 恒等 → 排序差异只能来自 _relevance（B9 信号）
    setSemanticEmbedderForTest((texts) => texts.map(() => [1, 0]));
    return store;
  };

  it('查询含"上个月" → factDate=2026-08-10 落 range +1 → 翻到第一', () => {
    process.env.PANSHA_TODAY = TODAY;
    const r = makeStore().loadFiltered({
      tier: 'high', semantic: true, queryText: '上个月我都做了什么', keywords: [],
    });
    assert.equal(r[0]?.id, 'older-fact', `factDate 命中 → 置顶，got ${r[0]?.id}`);
  });

  it('无 factDate 老卡：时间查询下天然不加分，仍按 lastSeen 序（行为不变）', () => {
    process.env.PANSHA_TODAY = TODAY;
    const store = new RefinedMemoryStore(ws, 'mem2.json');
    const t = Date.now() - 60 * 60 * 1000;
    store.save([
      mkCard('old-a', '机房巡检记录', { lastSeen: t }),
      mkCard('new-b', '牙医预约改到了周二上午', { lastSeen: t + 60_000 }),
    ]);
    setSemanticEmbedderForTest((texts) => texts.map(() => [1, 0]));
    const r = store.loadFiltered({ tier: 'high', semantic: true, queryText: '上个月我都做了什么', keywords: [] });
    assert.deepEqual(r.map((c) => c.id), ['new-b', 'old-a'], '无 factDate → 无加分 → tie-break lastSeen 倒序');
  });

  it('非时间查询 → factDate 卡不加分（与 B9 上线前同序）', () => {
    process.env.PANSHA_TODAY = TODAY;
    const r = makeStore().loadFiltered({
      tier: 'high', semantic: true, queryText: '牙医预约是哪天', keywords: [],
    });
    assert.equal(r[0]?.id, 'newer-nofact', '无时间表达 → 无 range → 无加分');
  });

  it('semantic 未激活 → 不解析不加分（纯词面路径逐字节不变）', () => {
    process.env.PANSHA_TODAY = TODAY;
    const r = makeStore().loadFiltered({ tier: 'high', keywords: ['牙医'] });
    assert.equal(r[0]?.id, 'older-fact', '词面命中牙医 +1，newer-nofact 0 —— 非 B9 通路');
    const r2 = makeStore().loadFiltered({
      tier: 'high', semantic: false, queryText: '上个月我都做了什么', keywords: [],
    });
    assert.equal(r2[0]?.id, 'newer-nofact', 'semantic=false → 老公式，lastSeen tie-break');
  });

  it('PANSHA_TODAY 换锚 → range 随之移动（2026-01-01 的"上个月"≠ 2026-08）', () => {
    process.env.PANSHA_TODAY = '2026-01-01';
    const r = makeStore().loadFiltered({
      tier: 'high', semantic: true, queryText: '上个月我都做了什么', keywords: [],
    });
    assert.equal(r[0]?.id, 'newer-nofact', '上个月=2025-12 → 2026-08 factDate 不命中 → 不加分');
  });
});
