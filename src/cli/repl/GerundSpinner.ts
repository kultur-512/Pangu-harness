// src/cli/repl/GerundSpinner.ts
// 趣味动名词 spinner 标签（纯中文词表）+ CC 同款字符帧序列（0.8 UI 对齐 U1）。
// nextGerund() never repeats the previous word. Pure logic — the caller owns
// the redraw interval and elapsed-time formatting (timers are gate-relevant).

const GERUNDS: readonly string[] = [
  '推演中', '反刍中', '煨煮中', '潜行中', '勾勒中',
  '编排中', '研磨中', '淬炼中', '穿行中', '搭建中',
  '凝神中', '翻检中', '运筹中', '梳理中', '抽丝剥茧中', '穿针引线中',
];

let lastIndex = -1;

export function gerundCount(): number {
  return GERUNDS.length;
}

// ==================== U1：字符帧序列（CC 同款） ====================

/** spinner 帧字符序列（CC 同款六帧）。 */
export const SPINNER_FRAMES: readonly string[] = ['·', '✢', '✳', '✶', '✻', '✽'];

/** 帧间隔（ms）：120ms 一帧循环。 */
export const SPINNER_FRAME_MS = 120;

/** 动词轮换周期（ms）：帧动画 120ms 连续，动名词每 4s 换一个。 */
export const GERUND_ROTATE_MS = 4000;

let frameIndex = 0;

/** 顺序取下一帧字符（循环；模块级游标，resetSpinnerFrame 归零）。 */
export function nextSpinnerFrame(): string {
  const f = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
  frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  return f;
}

/** 帧游标归零（任务边界 / 测试用）。 */
export function resetSpinnerFrame(): void {
  frameIndex = 0;
}

/** 重绘节奏：动画开启（TTY+光标可控）→ 120ms 帧；退化（reducedMotion/非 TTY）→ 旧 4s 文本刷新。 */
export function spinnerRedrawMs(animated: boolean): number {
  return animated ? SPINNER_FRAME_MS : GERUND_ROTATE_MS;
}

/** 动词轮换桶：elapsedMs 落在第几个 4s 周期（桶变化即换动词，帧动画不停）。 */
export function gerundBucket(elapsedMs: number, rotateMs: number = GERUND_ROTATE_MS): number {
  return Math.floor(Math.max(0, elapsedMs) / rotateMs);
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
