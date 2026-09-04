// src/cli/repl/InputQueue.ts
// 排队消息 + 转向收件箱（纯逻辑，完全可测试
// under SMOKE — no stdin, no timers, no UI imports).
//
// Semantics (per Phase 4 instruction):
// - tasks: FIFO, drained after the current turn settles, then executed one by one
// - steers: user interjections (`!` prefix); consumed at the START of the next
//   runTaskViaSse and injected into that round's prompt; Ctrl+C abort clears
//   unconsumed steers (already-injected ones cannot be recalled) but KEEPS tasks
// - clear(): 双 Esc 清空

export type QueuedItem =
  | { kind: 'task'; text: string; ts: number }
  | { kind: 'steer'; text: string; ts: number };

export class InputQueue {
  private tasks: string[] = [];
  private steers: string[] = [];

  /** Queue a follow-up task (FIFO). */
  enqueueTask(text: string): void {
    const t = String(text || '').trim();
    if (t) this.tasks.push(t);
  }

  /** Queue a steering interjection (latest joins the tail; all are consumed together). */
  enqueueSteer(text: string): void {
    const t = String(text || '').trim();
    if (t) this.steers.push(t);
  }

  /** Remove and return ALL queued tasks, in FIFO order. */
  drainTasks(): string[] {
    const out = this.tasks.slice();
    this.tasks = [];
    return out;
  }

  /** Look at unconsumed steers without consuming them. */
  peekSteers(): string[] {
    return this.steers.slice();
  }

  /** Remove and return all steers (call right after injecting them into the prompt). */
  consumeSteers(): string[] {
    const out = this.steers.slice();
    this.steers = [];
    return out;
  }

  /** Pending tasks + unconsumed steers. */
  get size(): number {
    return this.tasks.length + this.steers.length;
  }

  get steerCount(): number {
    return this.steers.length;
  }

  get taskCount(): number {
    return this.tasks.length;
  }

  /** Double-Esc wipe: drops tasks AND steers. */
  clear(): void {
    this.tasks = [];
    this.steers = [];
  }
}

/**
 * Route a user line submitted WHILE a task is running.
 * - '/...'  → slash command (caller executes immediately, returns false here)
 * - '!...'  → steer ('!steer xxx' and bare '!xxx' both strip the marker)
 * - else    → queued task
 */
export function classifyRunningInput(text: string): { kind: 'command' | 'steer' | 'task'; payload: string } {
  const t = String(text || '').trim();
  if (t.startsWith('/')) return { kind: 'command', payload: t };
  if (t.startsWith('!')) {
    let body = t.slice(1);
    if (body.toLowerCase().startsWith('steer')) body = body.slice(5);
    return { kind: 'steer', payload: body.trim() };
  }
  return { kind: 'task', payload: t };
}

/** Build the injection block appended to the next round's task text. */
export function formatSteerInjection(steers: string[]): string {
  if (steers.length === 0) return '';
  return `\n\n【用户插话（运行中收到，必须在本轮考虑）】\n${steers.map((s) => `- ${s}`).join('\n')}`;
}
