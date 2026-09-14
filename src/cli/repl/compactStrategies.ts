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

/** 完整 brief 的用户指令上限：超过则显式标记截断（不再静默丢原文）。 */
export const TURN_BRIEF_MAX_CHARS = 2000;

/**
 * B2：摘要输入用完整用户指令（≤2000 字符，超长显式标记）。
 * 旧 turnBrief 的 80 字符静默截断与 VERBATIM_RULE"逐字保留"硬约束自相矛盾：
 * 摘要模型根本看不到原文，合成轮替换后超 80 字符的用户指令永久丢失。
 * 空白不归一化（逐字保留语义）；摘要 prompt 是自由文本，容忍多行。
 */
export function turnFullBrief(t: Turn): string {
  const u = String(t.userInput || '').trim();
  const capped = u.length > TURN_BRIEF_MAX_CHARS
    ? u.slice(0, TURN_BRIEF_MAX_CHARS) + '…[超长已截断]'
    : u;
  const r = t.result?.summary || '';
  return `[${capped}]${r ? ` → ${r}` : ''}`;
}

/**
 * M2-7：摘要 prompt 的不对称保留约束——用户指令原文逐字保留（≤2000 字符内，
 * 与 turnFullBrief 的截断标记对齐），其余（结果/得分/教训）可压缩。
 */
export const VERBATIM_RULE =
  '硬约束：每条 [ ] 内的用户指令原文（≤2000 字符）必须逐字保留在摘要中（原样引用，不改写、不省略、不合并）；带"超长已截断"标记的部分按已截断原文引用，不得补写；结果、得分与教训可压缩。';

const strategies = new Map<string, CompactStrategy>();

const DEFAULT_STRATEGY: CompactStrategy = {
  id: 'default',
  buildPrompt: (removed, opts) => {
    const lines = removed.map((t, i) => `${i + 1}. ${turnFullBrief(t)}`);
    return [
      // C3（0.8.2 审查）：删"不超过 300 字"总额约束——它与 VERBATIM_RULE 的
      // 逐字保留数学上互斥（多条被移除轮时不可能同时满足），模型要么违反
      // 字数（摘要过长 → 注入端截断）要么丢指令。改为两段式结构化输出。
      opts?.instruction ?? [
        '请把以下历史任务轮次压缩为两段：',
        '【第一段·用户指令清单】逐条列出每轮 [ ] 内的用户指令原文（不改写、不省略、不合并）；',
        '【第二段·要点】结果、得分与重要教训（失败原因/约束）可自由压缩。',
      ].join('\n'),
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
      const brief = turnFullBrief(t);
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
