// src/memory/relTime.ts
// B9 相对时间检索信号（ROADMAP B9，零依赖、纯函数）：
// 把查询文本里的时间表达解析成 [start, end) 半开区间（UTC ms），供
// RefinedMemoryStore.loadFiltered 给"card.factDate 落入任一 range"的卡
// _relevance +1（cap 3 不变）。
//
// 锚定一致性：factDate = 事实当日 00:00 的 UTC ms（chatFactMemory.parseFactDate），
// 本模块产出的日/月/年 range 全部按 UTC 日界对齐，`factDate ∈ [start, end)` 即
// "事实落在该表达所指的日/月/年"。
//
// 设计约束（按登记项）：
//  - 零依赖：不 import 任何模块；"今天"由调用方注入（todayIso，产品路径传
//    timeAnchor.resolveToday() → 尊重 PANSHA_TODAY，评测锚定与产品同门），
//    本模块不读环境变量。
//  - 组件回环校验：V8 对越界日期滚动不报错（2023-02-31 → 03-03），逐组件
//    回读比对，非法 → 丢弃该 match（不产 range，也不回退到粗粒度）。
//  - 歧义规避：裸月份（"3月"/"May"）无年份 → 距 today 最近的历史月份
//    （月份 ≤ 当月取今年、未来月份取去年）；小写 "may" 仅在独立词 + 后接
//    年份或前接 in/on 时认作月份（"You may go" 不是日期）。裸英文月名需
//    首字母大写（"March" 动词 "march" 不误收）。
//  - 掩码扫描：每类 matcher 命中后把原文对应 span 抹成等长空格再跑下一类
//    （先长后短：年月日 → 年月 → 裸月），防 "2023年3月" 被 "2023年"+"3月"
//    二次匹配；handler 判非法时 span 照样抹除（2023年2月31日 不得退化成 2 月）。
//  - 任何异常由调用方兜底（store 侧 try/catch → 空 range → 不加分）。

/** 半开时间区间 [start, end)，UTC ms（与 factDate 同锚）。 */
export interface RelTimeRange {
  start: number;
  end: number;
}

const DAY_MS = 86_400_000;

interface TodayAnchor {
  y: number;
  /** 1-12 */
  mo: number;
  d: number;
  /** 当日 00:00 UTC ms */
  ms: number;
}

/** 组件回环校验的 UTC ms（防 2023-02-31 → 03-03 滚动）；非法 → null。 */
function utcMsOf(y: number, mo: number, d: number): number | null {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const dt = new Date(ms);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? ms : null;
}

function parseTodayIso(todayIso: string): TodayAnchor | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(todayIso ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = utcMsOf(y, mo, d);
  return ms === null ? null : { y, mo, d, ms };
}

/** 月份加减（年自然回绕）；mo 结果恒 1-12。 */
function addMonths(y: number, mo: number, delta: number): { y: number; mo: number } {
  const t = y * 12 + (mo - 1) + delta;
  return { y: Math.floor(t / 12), mo: (((t % 12) + 12) % 12) + 1 };
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function monthRange(y: number, mo: number): RelTimeRange {
  return { start: Date.UTC(y, mo - 1, 1), end: Date.UTC(y, mo, 1) };
}

function yearRange(y: number): RelTimeRange {
  return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1) };
}

function dayRange(ms: number): RelTimeRange {
  return { start: ms, end: ms + DAY_MS };
}

/** 周一 00:00 UTC（1970-01-01 是周四：(days+3)%7 → 周一=0）。 */
function weekStartMs(t: TodayAnchor): number {
  const days = Math.floor(t.ms / DAY_MS);
  return t.ms - ((days + 3) % 7) * DAY_MS;
}

/** 裸月份（无年份）→ 距 today 最近的历史月份：未来月回退去年，当月/已过月取今年。 */
function nearestPastMonth(t: TodayAnchor, mo: number): RelTimeRange {
  return monthRange(mo > t.mo ? t.y - 1 : t.y, mo);
}

/** 裸"月日"（无年份）→ 最近历史月份中的该日；非法日（2月30）→ null。 */
function nearestPastDay(t: TodayAnchor, mo: number, d: number): RelTimeRange | null {
  const ms = utcMsOf(mo > t.mo ? t.y - 1 : t.y, mo, d);
  return ms === null ? null : dayRange(ms);
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

/**
 * 解析查询文本中的时间表达 → 去重后的 [start,end) 区间数组（UTC ms）。
 * 非法输入（非字符串/空串/非法 todayIso/无时间表达）→ []。
 * 匹配顺序即优先级（长模式在前、掩码防二次匹配）：
 *   中文 年月日 → 年月 → 年；ISO/-斜杠 全日期 → 年月；
 *   英文 月日,年 → 月 年 → 月日(裸,大写或 in/on) → in/on 月 → 裸大写月；
 *   中文 裸月日 → 裸月；中文相对词；英文相对词；N ago；(in) the past N units；in yyyy。
 */
export function parseRelativeTimeRanges(queryText: string, todayIso: string): Array<RelTimeRange> {
  const t = parseTodayIso(todayIso);
  if (!t) return [];
  if (typeof queryText !== 'string' || queryText.length === 0) return [];
  let text = queryText;
  const out: Array<RelTimeRange> = [];
  const seen = new Set<string>();

  /** 掩码条件：命中产区间 / span 含数字（疑似日期残段——非法日期也必须抹掉，
   *  防 "2023年2月31日" 退化成 2 月被后续 matcher 重解析）/ span 含月名词。
   *  纯虚词 span（如 "in the"）不掩——后续 matcher（"(in) the past N …"）还需要它。 */
  const containsMonthWord = (s: string): boolean => {
    for (const w of String(s).toLowerCase().split(/[^a-z]+/)) {
      if (w && MONTH_NAMES[w] !== undefined) return true;
    }
    return false;
  };

  /** 掩码扫描：命中 span 先抹成等长空格（防后续 matcher 二次匹配），再交给 handler。 */
  const scan = (source: string, flags: string, handle: (m: RegExpExecArray) => RelTimeRange | null): void => {
    const rx = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      if (m[0].length === 0) { rx.lastIndex++; continue; }
      const r = handle(m);
      if (r || /\d/.test(m[0]) || containsMonthWord(m[0])) {
        text = text.slice(0, m.index) + ' '.repeat(m[0].length) + text.slice(m.index + m[0].length);
      }
      if (r) {
        const key = `${r.start}:${r.end}`;
        if (!seen.has(key)) { seen.add(key); out.push(r); }
      }
    }
  };
  const monthOf = (s: string): number | null => MONTH_NAMES[String(s ?? '').toLowerCase()] ?? null;

  // ---- 中文绝对：yyyy年M月d日（日）→ yyyy年M月（月）→ yyyy年（年） ----
  scan('(\\d{4})年(\\d{1,2})月(\\d{1,2})日', 'g', (m) => {
    const ms = utcMsOf(Number(m[1]), Number(m[2]), Number(m[3]));
    return ms === null ? null : dayRange(ms);
  });
  scan('(\\d{4})年(\\d{1,2})月', 'g', (m) => {
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? monthRange(Number(m[1]), mo) : null;
  });
  scan('(\\d{4})年', 'g', (m) => yearRange(Number(m[1])));

  // ---- ISO：yyyy-M-d（日）→ yyyy-M（月）；斜杠同形（haystack_dates 口径） ----
  // review 建议-1/2：左边界防标识符误收（lme-2023-07 / v2024-01）；带 T 时刻的
  // ISO 串（factDate 侧 parseFactDate 支持）不再失配。
  scan('(?<![A-Za-z\\d./-])(\\d{4})-(\\d{1,2})-(\\d{1,2})(?:T\\d{2}:\\d{2})?\\b', 'g', (m) => {
    const ms = utcMsOf(Number(m[1]), Number(m[2]), Number(m[3]));
    return ms === null ? null : dayRange(ms);
  });
  scan('(?<![A-Za-z\\d./-])(\\d{4})-(\\d{1,2})(?![\\d-])', 'g', (m) => {
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? monthRange(Number(m[1]), mo) : null;
  });
  scan('(\\d{4})\\/(\\d{1,2})\\/(\\d{1,2})\\b', 'g', (m) => {
    const ms = utcMsOf(Number(m[1]), Number(m[2]), Number(m[3]));
    return ms === null ? null : dayRange(ms);
  });
  scan('(\\d{4})\\/(\\d{1,2})(?![\\d/])', 'g', (m) => {
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? monthRange(Number(m[1]), mo) : null;
  });

  // ---- 英文带年份（无歧义，大小写不敏感）：Month d, yyyy（日）→ Month yyyy（月） ----
  scan('\\b([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+(\\d{4})\\b', 'gi', (m) => {
    const mo = monthOf(m[1]);
    if (!mo) return null;
    const ms = utcMsOf(Number(m[3]), mo, Number(m[2]));
    return ms === null ? null : dayRange(ms);
  });
  scan('\\b([A-Za-z]{3,9})\\.?\\s+(\\d{4})\\b', 'g', (m) => {
    const mo = monthOf(m[1]);
    return mo ? monthRange(Number(m[2]), mo) : null;
  });

  // ---- 英文月日无年份（日粒度）：裸月名需首字母大写（动词 march/ Sit-in 不误收）；
  //      或 in/on 前缀（大小写不限——前缀已消歧）----
  scan('\\b([A-Z][a-z]{2,8})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*,?\\s*\\d{4})', 'g', (m) => {
    const mo = monthOf(m[1]);
    return mo ? nearestPastDay(t, mo, Number(m[2])) : null;
  });
  scan('\\b(?:in|on)\\s+([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b', 'gi', (m) => {
    const mo = monthOf(m[1]);
    return mo ? nearestPastDay(t, mo, Number(m[2])) : null;
  });

  // ---- 英文裸月（无年）：in/on + 月名（大小写不限）→ 最近历史月；
  //      其余裸月名需首字母大写（句首 "May I ask" 的模态 may 属已申报的固有歧义，
  //      规格只保护小写 may）----
  scan('\\b(?:in|on)\\s+([A-Za-z]{3,9})\\b(?!\\s*[,\\s]*\\d)', 'gi', (m) => {
    const mo = monthOf(m[1]);
    return mo ? nearestPastMonth(t, mo) : null;
  });
  scan('\\b([A-Z][a-z]{2,8})\\b', 'g', (m) => {
    const mo = monthOf(m[1]);
    return mo ? nearestPastMonth(t, mo) : null;
  });

  // ---- 中文裸月日（日）→ 裸月（最近历史月） ----
  scan('(\\d{1,2})月(\\d{1,2})日', 'g', (m) => {
    const mo = Number(m[1]);
    if (mo < 1 || mo > 12) return null;
    return nearestPastDay(t, mo, Number(m[2]));
  });
  scan('(\\d{1,2})月', 'g', (m) => {
    const mo = Number(m[1]);
    return mo >= 1 && mo <= 12 ? nearestPastMonth(t, mo) : null;
  });

  // ---- 中文相对词 ----
  scan('(上上周|上周|上个月|上月|这个月|本月|今天|今日|昨天|前天|本周|今年|去年)', 'g', (m) => {
    switch (m[1]) {
      case '今天':
      case '今日':
        return dayRange(t.ms);
      case '昨天':
        return dayRange(t.ms - DAY_MS);
      case '前天':
        return dayRange(t.ms - 2 * DAY_MS);
      case '本周':
        return { start: weekStartMs(t), end: weekStartMs(t) + 7 * DAY_MS };
      case '上周':
        return { start: weekStartMs(t) - 7 * DAY_MS, end: weekStartMs(t) };
      case '上上周':
        return { start: weekStartMs(t) - 14 * DAY_MS, end: weekStartMs(t) - 7 * DAY_MS };
      case '本月':
      case '这个月':
        return monthRange(t.y, t.mo);
      case '上个月':
      case '上月': {
        const p = addMonths(t.y, t.mo, -1);
        return monthRange(p.y, p.mo);
      }
      case '今年':
        return yearRange(t.y);
      case '去年':
        return yearRange(t.y - 1);
      default:
        return null;
    }
  });

  // ---- 英文相对词 ----
  scan('\\b(today|yesterday|last\\s+week|last\\s+month|this\\s+month|this\\s+week|this\\s+year|last\\s+year)\\b', 'gi', (m) => {
    const k = m[1].toLowerCase().replace(/\s+/g, ' ');
    const ws0 = weekStartMs(t);
    switch (k) {
      case 'today': return dayRange(t.ms);
      case 'yesterday': return dayRange(t.ms - DAY_MS);
      case 'last week': return { start: ws0 - 7 * DAY_MS, end: ws0 };
      case 'this week': return { start: ws0, end: ws0 + 7 * DAY_MS };
      case 'last month': { const p = addMonths(t.y, t.mo, -1); return monthRange(p.y, p.mo); }
      case 'this month': return monthRange(t.y, t.mo);
      case 'this year': return yearRange(t.y);
      case 'last year': return yearRange(t.y - 1);
      default: return null;
    }
  });

  // ---- N days/weeks/months/years ago：days=单日；weeks=自然周块；months=日历月；years=日历年 ----
  scan('\\b(\\d{1,3})\\s*(days?|weeks?|months?|years?)\\s+ago\\b', 'gi', (m) => {
    const n = Number(m[1]);
    if (!n) return null;
    const unit = m[2].toLowerCase();
    if (unit.startsWith('day')) return dayRange(t.ms - n * DAY_MS);
    if (unit.startsWith('week')) {
      const ws0 = weekStartMs(t);
      return { start: ws0 - n * 7 * DAY_MS, end: ws0 - (n - 1) * 7 * DAY_MS };
    }
    if (unit.startsWith('month')) {
      const p = addMonths(t.y, t.mo, -n);
      return monthRange(p.y, p.mo);
    }
    return yearRange(t.y - n);
  });

  // ---- (in) the past N units → 滚动窗口 [today-N 单位, 明天)（月末钳制） ----
  scan('\\b(?:in\\s+)?the\\s+past\\s+(\\d{1,3})\\s*(days?|weeks?|months?|years?)\\b', 'gi', (m) => {
    const n = Number(m[1]);
    if (!n) return null;
    const unit = m[2].toLowerCase();
    let start: number;
    if (unit.startsWith('day')) start = t.ms - n * DAY_MS;
    else if (unit.startsWith('week')) start = t.ms - n * 7 * DAY_MS;
    else if (unit.startsWith('month')) {
      const p = addMonths(t.y, t.mo, -n);
      start = Date.UTC(p.y, p.mo - 1, Math.min(t.d, daysInMonth(p.y, p.mo)));
    } else {
      const y = t.y - n;
      start = Date.UTC(y, t.mo - 1, Math.min(t.d, daysInMonth(y, t.mo)));
    }
    return { start, end: t.ms + DAY_MS };
  });

  // ---- in yyyy → 年粒度（裸 4 位数字不认，规格未列且误收率高） ----
  scan('\\bin\\s+(\\d{4})\\b', 'gi', (m) => yearRange(Number(m[1])));

  return out;
}
