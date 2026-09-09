// src/cli/repl/compactStrategies.ts
// compaction strategy is a pluggable interface — swap the
// summarization prompt without touching compactService. Built-ins: 'default'
// (existing template) + 'topic' (cluster by userInput keywords, sectioned).
// Custom strategies register via registerStrategy; unknown ids fall back to
// default. compactService reads .panshalach.json compaction.strategy.

import type { Turn } from './types.js';

export interface CompactStrategy {
  id: string;
  buildPrompt(removed: Turn[], opts?: any): string;
  postprocess?(summary: string): string;
}

/** Shared per-turn brief (kept identical to compactService's). */
export function turnBrief(t: Turn): string {
  const u = (t.userInput || '').replace(/\s+/g, ' ').slice(0, 80);
  const r = t.result?.summary || '';
  return `[${u}]${r ? ` → ${r}` : ''}`;
}

/**
 * M2-7：摘要 prompt 的不对称保留约束——用户指令原文逐字保留，其余（结果/得分/教训）
 * 可压缩。本步只落 prompt 约束（吃到 80% 收益）；compactService 分区改造留 R8。
 */
export const VERBATIM_RULE =
  '硬约束：用户指令原文必须逐字保留（原样引用，不改写、不省略、不合并）；结果、得分与教训可压缩。';

const strategies = new Map<string, CompactStrategy>();

const DEFAULT_STRATEGY: CompactStrategy = {
  id: 'default',
  buildPrompt: (removed, opts) => {
    const lines = removed.map((t, i) => `${i + 1}. ${turnBrief(t)}`);
    return [
      opts?.instruction ?? '请把以下历史任务轮次压缩成一段不超过 300 字的摘要，保留：每项任务的核心诉求、关键结果与得分、重要教训（失败原因/约束）。',
      VERBATIM_RULE,
      '只输出摘要正文，不要寒暄。',
      '---',
      ...lines,
    ].join('\n');
  },
};

/** topic strategy: cluster removed turns by userInput keyword sections. */
const TOPIC_STRATEGY: CompactStrategy = {
  id: 'topic',
  buildPrompt: (removed, opts) => {
    // cluster by first meaningful token of userInput (fallback 'misc')
    const groups = new Map<string, string[]>();
    for (const t of removed) {
      const brief = turnBrief(t);
      const word = /[A-Za-z\u4e00-\u9fff]{2,}/.exec(t.userInput || '')?.[0] ?? 'misc';
      const key = word.slice(0, 16).toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(brief);
    }
    const sections = [...groups.entries()].map(([k, v]) => `## ${k}\n${v.join('\n')}`);
    return [
      '请把以下历史轮次按主题分节压缩（每节 ≤ 80 字），保留核心诉求/结果/教训。',
      VERBATIM_RULE,
      '只输出摘要正文。',
      '---',
      ...sections,
    ].join('\n');
  },
};

export function registerStrategy(s: CompactStrategy): void {
  if (s && s.id) strategies.set(s.id, s);
}

export function getStrategy(id: string): CompactStrategy {
  return strategies.get(id) || DEFAULT_STRATEGY;
}

export function listStrategies(): string[] {
  return [...strategies.keys()];
}

// seed built-ins
registerStrategy(DEFAULT_STRATEGY);
registerStrategy(TOPIC_STRATEGY);
