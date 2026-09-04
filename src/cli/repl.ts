// src/cli/repl.ts
// ZIS REPL entry point (blueprint v1.1 + Hermes-style streaming default)
//
// Behavior:
// - startRepl({resume}) → 默认进入 **流式交互模式**（对标 Hermes）
//   - 进程内事件直连（P0.2），富 UI 优先、行模式兜底；非 TTY 静默降级经典
//   - M2.2: --resume [id|last] 恢复 rollout（turns + 审批状态）
// - runOneShot() → 单条命令执行（保持原有兼容行为）

import { createDefaultModelProvider, setSharedModelProvider } from './repl/ModelProvider.js';
import { Session } from './repl/Session.js';
import { Repl } from './repl/Repl.js';

export interface StartReplOptions {
  /** M2.2: 'last' | specific rollout/session id */
  resume?: string;
  /** P3-3.5: fork the resume target into `<id>--branch-<name>` before starting */
  branch?: string;
}

/**
 * fix-a6-routing: PANSHA_MODEL env seeds a session's model (headless one-shot
 * multi-provider, e.g. PANSHA_MODEL="a6:openPangu-7B"). Testable unit.
 */
export function applyEnvModel(session: Session): Session {
  const envModel = process.env.PANSHA_MODEL;
  if (envModel && typeof envModel === 'string' && envModel.trim()) {
    session.model = envModel.trim();
  }
  return session;
}

export async function startRepl(opts: StartReplOptions = {}): Promise<void> {
  // P0-fix: seed the process-wide shared provider ONCE at the entry so the
  // interactive runner, classic fallback and /serve all share hot config state.
  const provider = createDefaultModelProvider();
  try { setSharedModelProvider(provider as any); } catch {}

  // fix-rich-local-cmds (②A): background prefetch of provider model lists into
  // .panshalach.json (fire-and-forget; offline/slow endpoints skipped silently).
  try {
    const { prefetchProviderModels } = await import('./repl/providerPrefetch.js');
    prefetchProviderModels(process.cwd()).catch(() => {});
  } catch {}

  // M2.2: resolve --resume into a restored Session (best-effort, never blocks startup)
  // P3-3.5: --branch forks the resolved target into a NEW rollout (origin untouched)
  let session: Session | undefined;
  if (opts.resume || opts.branch) {
    try {
      const { listRecent, resumeSession, appendMeta, forkRollout, BRANCH_SEPARATOR } = await import('./repl/rolloutStore.js');
      const { createOutputRenderer } = await import('./repl/OutputRenderer.js');
      const r = createOutputRenderer();
      const recent = listRecent(10);
      const resolveTarget = () => opts.resume === 'last' || !opts.resume
        ? recent[0]
        : recent.find((x) => x.id === opts.resume || x.id.startsWith(opts.resume!));
      let target = resolveTarget();

      // Branch: origin stays read-only; the branch replays origin events under
      // a new id `<origin>--branch-<name>`, then we resume THAT.
      if (opts.branch && target) {
        const branchId = `${target.id}${BRANCH_SEPARATOR}${opts.branch}`;
        forkRollout(target.id, branchId);
        r.info(`已分支：${target.id} → ${branchId}（原会话只读，/resume 可回到原分支）`);
        const branchEntry = listRecent(50).find((x) => x.id === branchId);
        target = branchEntry ?? { ...target, id: branchId };
      } else if (opts.branch && !target) {
        r.warn('--branch 需要一个可恢复的源会话（先跑一次任务或指定 --resume <id>）');
      }

      if (target) {
        session = new Session({ workspace: target.workspace, tier: (target.tier as any) || 'high' });
        session.id = target.id;
        const turns = resumeSession(session, target.id);
        appendMeta(session);
        // B7: mark the session as resumed so the interactive layer can show
        // "已恢复会话" (sseInteractive reads (session as any).__resumed).
        (session as any).__resumed = { from: target.id, turns };
        r.info(`已恢复会话 ${target.id}（${turns} 轮上下文，模式 ${session.approvalMode}）`);
      } else {
        r.warn(`未找到可恢复的会话（${opts.resume ?? 'last'}），已开新会话。可用: pangu --resume last`);
      }
    } catch {
      // resume is best-effort
    }
  }

  // === 默认路径：进程内事件驱动的交互式 CLI（Hermes 风格） ===
  try {
    const { startSseInteractive } = await import('./repl/sseInteractive.js');
    await startSseInteractive({
      provider,
      session,
      // B2: pass the session's live tier/workspace as the defaults so the
      // interactive layer can seed fresh sessions with them too.
      defaultTier: session?.tier,
      defaultWorkspace: session?.workspace,
    });
    return;
  } catch (err) {
    // 任何严重错误都继续走降级路径，不要让用户卡住
    // （startSseInteractive 内部已有非 TTY 降级，这里是最后兜底）
  }

  // === 降级路径：经典行模式（原有行为） ===
  const repl = new Repl({ provider, ...(session ? { session } : {}) });
  await repl.start();
}

export async function runOneShot(args: string[]): Promise<void> {
  // 单次命令执行保持原有路径
  const provider = createDefaultModelProvider();
  try { setSharedModelProvider(provider as any); } catch {}
  const session = applyEnvModel(new Session());
  const repl = new Repl({ session, provider });
  await repl.runOneShot(args);
}

// Default export for convenience
export default { startRepl, runOneShot };
