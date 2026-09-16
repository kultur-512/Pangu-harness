// src/cli/repl/classicRepl.ts
// Classic line-mode REPL fallback.
// Used when:
// - Not running in a rich TTY
// - SSE interactive mode cannot be started
// - User explicitly wants the old behavior

import { Repl } from './Repl.js';
import { getSharedModelProvider } from './ModelProvider.js';
import { Session } from './Session.js';
import { applyConfigModel, applyEnvModel } from './modelSeed.js';

export interface ClassicReplOptions {
  /** B8: carry a restored session (e.g. --resume) into the classic fallback. */
  session?: Session;
}

export async function startClassicRepl(opts: ClassicReplOptions = {}): Promise<void> {
  // 共享 provider 单例（懒创建）保持热配置状态
  // consistent with the interactive runner and /serve.
  const provider = getSharedModelProvider();
  const repl = new Repl({
    provider,
    ...(opts.session
      // D1：env 优先（applyEnvModel）→ 配置兜底（applyConfigModel），
      // 与 rich/line 路径同序（PANSHA_MODEL 此前在 classic 路径同样被忽略）。
      ? { session: applyConfigModel(applyEnvModel(opts.session), opts.session.workspace) as Session }
      : { session: applyConfigModel(applyEnvModel(new Session())) as Session }),
  });
  await repl.start();
}

export async function runClassicOneShot(args: string[]): Promise<void> {
  const provider = getSharedModelProvider();
  const session = applyConfigModel(applyEnvModel(new Session())) as Session;
  const repl = new Repl({ session, provider });
  await repl.runOneShot(args);
}
