// src/cli/repl/GerundSpinner.ts
// 趣味动名词 spinner 标签（纯中文词表）。
// nextGerund() never repeats the previous word. Pure logic — the caller owns
// the 4s interval and elapsed-time formatting (timers are gate-relevant).

const GERUNDS: readonly string[] = [
  '推演中', '反刍中', '煨煮中', '潜行中', '勾勒中',
  '编排中', '研磨中', '淬炼中', '穿行中', '搭建中',
  '凝神中', '翻检中', '运筹中', '梳理中', '抽丝剥茧中', '穿针引线中',
];

let lastIndex = -1;

export function gerundCount(): number {
  return GERUNDS.length;
}

/** Random gerund that is never an immediate repeat. */
export function nextGerund(): string {
  if (GERUNDS.length === 0) return '';
  if (GERUNDS.length === 1) return GERUNDS[0];
  let i = Math.floor(Math.random() * GERUNDS.length);
  while (i === lastIndex) {
    i = Math.floor(Math.random() * GERUNDS.length);
  }
  lastIndex = i;
  return GERUNDS[i];
}

/** Format a running label: `⟨gerund⟩… ⏱ Ns`. */
export function formatRunningLabel(elapsedMs: number, gerund?: string): string {
  const g = gerund ?? nextGerund();
  const sec = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${g}… ⏱ ${sec}s`;
}
