// src/memory/timeAnchor.ts
// 记忆时间锚定（0.8.3）：消费者"今天"的单一来源。
//
// 架构原则（temporal-reasoning 题型 0/15 归因，2026-09-13）：
//   - "何时记的"  → lastSeen（chatFactMemory 既有衰减语义，不动）
//   - "记的是何时的事" → factDate/factDateText（chatFactMemory 新增）
//   - "现在是何时" → resolveToday()（消费者 prompt 注入；本模块）
//
// 评测/测试可控性：PANSHA_TODAY 环境变量显式指定今天（评测 runner 把
// LongMemEval 的 question_date 注入进来），格式校验通过才采用——防止假日期
// 污染（V8 对越界日期是滚动不是报错：new Date('2023-02-31') → 3 月 3 日，
// 必须组件回环校验）。未设/非法 → 回退真实当天，产品路径行为不变。

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验 yyyy-MM-dd 是否为真实存在的日历日期（防 Date 滚动误收，如 02-31）。 */
export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 真实当天（UTC 日期，与既有 turnTag 的 toISOString 口径一致）。 */
export function realToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 今天 = PANSHA_TODAY（合法 yyyy-MM-dd）或真实当天。
 * 消费者（PromptBuilder 身份行 / StructuredReasoner chat 指令 / 评测 runner）
 * 统一经此取"今天"，保证天内字节稳定（stable 段缓存友好）且评测可控。
 */
export function resolveToday(): string {
  const raw = process.env.PANSHA_TODAY?.trim();
  if (raw && isValidIsoDate(raw)) return raw;
  return realToday();
}
