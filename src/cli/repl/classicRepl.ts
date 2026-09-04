// src/cli/repl/classicRepl.ts
// Classic line-mode REPL fallback.
// Used when:
// - Not running in a rich TTY
// - SSE interactive mode cannot be started
// - User explicitly wants the old behavior

import { Repl } from './Repl.js';
import { getSharedModelProvider } from './ModelProvider.js';
import { Session } from './Session.js';

export interface ClassicReplOptions {
  /** B8: carry a restored session (e.g. --resume) into the classic fallback. */
  session?: Session;
}

export async function startClassicRepl(opts: ClassicReplOptions = {}): Promise<void> {
  // 共享 provider 单例（懒创建）保持热配置状态
  // consistent with the interactive runner and /serve.
  const provider = getSharedModelProvider();
  const repl = new Repl({ provider, ...(opts.session ? { session: opts.session } : {}) });
  await repl.start();
}

export async function runClassicOneShot(args: string[]): Promise<void> {
  const provider = getSharedModelProvider();
  const session = new Session();
  const repl = new Repl({ session, provider });
  await repl.runOneShot(args);
}
