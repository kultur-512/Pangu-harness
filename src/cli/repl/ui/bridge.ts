// src/cli/repl/ui/bridge.ts
// Enhanced thin adapter for ink UI.
// Exposes helpers for engine to push rich events without knowing about React.

import type { Session } from '../Session.js';
import type { OutputRenderer } from '../types.js';
import type { UiBridge, FeedItem, UiState } from '../types.js';

export interface BridgeContext {
  session: Session;
  renderer: OutputRenderer;
  repl: any;
}

let currentDispatch: ((action: any) => void) | null = null;
let currentHistory: string[] = [];

// M2.0: interactive confirm state (rich UI approval bridge).
// The resolver lives OUTSIDE React state on purpose: the engine awaits the
// promise while the reducer only carries the serializable request for render.
export interface ConfirmRequest {
  tool: string;
  description: string;
  danger?: boolean;
  diff?: any[];
}
let currentConfirm: { request: ConfirmRequest; resolve: (d: 'y' | 'n' | 'a') => void } | null = null;

export function createBridge(
  session: Session,
  renderer: OutputRenderer,
  repl: any
): UiBridge & {
  pushStep: (step: any) => void;
  pushCritique: (c: any) => void;
  pushTool: (t: any) => void;
  pushBudget: (ratio: number) => void;
  requestConfirm: (message: string) => Promise<boolean>;
  addHistory: (cmd: string) => void;
} {
  const pushFeed = (item: Omit<FeedItem, 'id'>) => {
    const withId: FeedItem = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      ...(item as any),
    };
    if (currentDispatch) {
      currentDispatch({ type: 'PUSH_FEED', item: withId });
      // If it's a phase, also surface it in top bar
      if ((item as any).type === 'phase' && (item as any).phase) {
        currentDispatch({ type: 'SET_PHASE', phase: (item as any).phase });
      }
    } else {
      try {
        if (item.type === 'text' && (item as any).text) {
          renderer.writeLine((item as any).text);
        }
      } catch {}
    }
  };

  const setTop = (partial: Partial<UiState['top']>) => {
    if (currentDispatch) currentDispatch({ type: 'SET_TOP', partial });
  };

  const setRunning = (running: boolean) => {
    if (currentDispatch) currentDispatch({ type: 'SET_RUNNING', running });
  };

  // M2.0: legacy setter kept for the old reducer action (unused by the new
  // approval flow); the new Promise-based bridge is `setConfirm` below.
  const setConfirmLegacy = (confirm: UiState['confirm'] | undefined) => {
    if (currentDispatch) currentDispatch({ type: 'SET_CONFIRM', confirm });
  };

  const submitInput = (text: string) => {
    if (repl && typeof repl.handleInput === 'function') {
      repl.handleInput(text).catch(() => {});
    } else if (repl && typeof repl.executeTask === 'function') {
      repl.executeTask(text).catch(() => {});
    }
  };

  const updateInput = (value: string) => {
    if (currentDispatch) currentDispatch({ type: 'UPDATE_INPUT', value });
  };

  // P1.4: live streaming buffers
  const appendStream = (kind: 'thinking' | 'message', text: string) => {
    if (!text || !currentDispatch) return;
    currentDispatch({ type: 'APPEND_STREAM', kind, text });
  };

  /**
   * Reset the live stream buffers.
   * - resetStream()          → clear both (turn settled)
   * - resetStream('thinking')→ clear only thinking (a new segment of that kind starts)
   * - resetStream('message') → clear only message
   */
  const resetStream = (kind?: 'thinking' | 'message') => {
    if (!currentDispatch) return;
    currentDispatch({ type: 'RESET_STREAM', kind });
  };

  // P4-4.2: queued-messages badge (rich bottom bar)
  const setQueueCount = (total: number, tasks: number, steers: number) => {
    if (!currentDispatch) return;
    currentDispatch({ type: 'SET_QUEUE_COUNT', total, tasks, steers });
  };

  // M2.0: rich approval bridge — the engine awaits setConfirm(request);
  // PanshaApp's ConfirmBar calls resolveConfirm(decision) on y/n/a/Esc.
  const setConfirm = (request: ConfirmRequest): Promise<'y' | 'n' | 'a'> =>
    new Promise((resolve) => {
      currentConfirm = { request, resolve };
      if (currentDispatch) currentDispatch({ type: 'SET_CONFIRM_STATE', confirm: request });
    });

  const resolveConfirm = (decision: 'y' | 'n' | 'a') => {
    const c = currentConfirm;
    currentConfirm = null;
    if (currentDispatch) currentDispatch({ type: 'SET_CONFIRM_STATE', confirm: undefined });
    if (c) c.resolve(decision);
  };

  const hasPendingConfirm = () => currentConfirm !== null;

  // Rich helpers
  const pushStep = (step: any) => {
    // Push a compact step header as a 'step' item
    pushFeed({
      type: 'step',
      stepNumber: step.stepNumber || 0,
      thinking: step.thinking,
      plan: step.plan,
      toolCalls: step.toolCalls,
      result: step.result,
    } as any);

    // Surface reasoning as a collapsible ThoughtBlock if we have thinking text
    if (step && typeof step.thinking === 'string' && step.thinking.trim()) {
      const full = step.thinking.trim();
      const short = full.length > 140 ? full.slice(0, 137) + '…' : full;
      pushFeed({
        type: 'thought',
        stepNumber: step.stepNumber || 0,
        short,
        full,
      } as any);
    }

    // If plan looks substantial, also surface as markdown for nice formatting
    if (step && typeof step.plan === 'string' && step.plan.trim().length > 0) {
      pushFeed({
        type: 'markdown',
        stepNumber: step.stepNumber || 0,
        content: step.plan.trim(),
      } as any);
    }
  };

  const pushCritique = (c: any) => {
    pushFeed({ type: 'critique', stepNumber: c.stepNumber || 0, critique: c.critique } as any);
  };

  const pushTool = (t: any) => {
    // Normalize from multiple shapes:
    // - legacy loose: { tool, target, args, result, status }
    // - real ToolCall: { toolName, params: [{name, value}, ...], result?, verificationResult?, rawBlock? }
    const toolName = t?.toolName || t?.tool || t?.name || 'tool';
    let target = t?.target || t?.file || t?.path || '';
    let argsSummary = t?.argsSummary || '';
    if (!argsSummary) {
      if (Array.isArray(t?.params)) {
        argsSummary = t.params
          .map((p: any) => `${p?.name || ''}=${String(p?.value ?? '').slice(0, 40)}`)
          .join(', ');
      } else if (t?.args) {
        try { argsSummary = JSON.stringify(t.args).slice(0, 80); } catch {}
      }
    }
    if (!target && Array.isArray(t?.params)) {
      const p = t.params.find((pp: any) => pp && (pp.name === 'path' || pp.name === 'file' || pp.name === 'target'));
      if (p) target = String(p.value || '');
    }
    const result = t?.result || t?.verificationResult || t?.output || undefined;
    const status = t?.status || (t?.success === false ? 'fail' : (result ? 'ok' : (t?.running === false ? 'ok' : 'running')));

    pushFeed({
      type: 'tool',
      tool: toolName,
      target,
      argsSummary,
      result,
      status,
    } as any);
  };

  const pushBudget = (ratio: number) => {
    pushFeed({ type: 'budget', usedRatio: ratio } as any);
    setTop({ budgetRatio: ratio });
  };

  // Simple confirm using a promise + dispatch
  let confirmResolver: ((yes: boolean) => void) | null = null;

  // @deprecated (fix-p2): legacy confirm helper — the real approval flow uses
  // setConfirm()/resolveConfirm(). No caller remains; kept for compat.
  const requestConfirm = (message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      confirmResolver = resolve;
      setConfirmLegacy({
        message,
        onResolve: (yes: boolean) => {
          setConfirmLegacy(undefined);
          if (confirmResolver) {
            const r = confirmResolver;
            confirmResolver = null;
            r(yes);
          }
        },
      } as any);
    });
  };

  const addHistory = (cmd: string) => {
    if (!cmd || !cmd.trim()) return;
    currentHistory = [...currentHistory.filter(c => c !== cmd), cmd].slice(-50);
    if (currentDispatch) {
      currentDispatch({ type: 'SET_HISTORY', history: currentHistory });
    }
  };

  // fix-rich-local-cmds (②B): provider→model options are PURELY LOCAL — the
  // startup prefetch (providerPrefetch) fills .panshalach.json providers[].models,
  // so this reads only the local config (millisecond, no per-keypress network).
  const providerOptions = async (): Promise<{ providers: Array<{ name: string; models: string[] }> }> => {
    try {
      const { ConfigManager } = await import('../ConfigManager.js');
      const cfg: any = (new ConfigManager(session.workspace || process.cwd())).getAll?.() ?? {};
      const providers: Array<{ name: string; models: string[] }> = [];
      const p = cfg?.providers;
      if (p && typeof p === 'object') {
        for (const name of Object.keys(p)) {
          const models = Array.isArray(p[name]?.models) ? p[name].models.map(String) : [];
          providers.push({ name, models });
        }
      }
      return { providers };
    } catch {
      return { providers: [] };
    }
  };

  const bridge: any = {
    pushFeed,
    setTop,
    setRunning,
    // M2.0: real approval bridge
    setConfirm,
    resolveConfirm,
    hasPendingConfirm,
    submitInput,
    updateInput,
    appendStream,
    resetStream,
    setQueueCount,
    pushStep,
    pushCritique,
    pushTool,
    pushBudget,
    requestConfirm,
    addHistory,
    // fix-picker-3 (②): provider→model options for the /model two-stage picker
    providerOptions,
  };

  bridge.__registerDispatch = (dispatch: (action: any) => void) => {
    currentDispatch = dispatch;
  };
  bridge.__unregisterDispatch = () => {
    currentDispatch = null;
  };

  // Seed initial state
  setTop({
    tier: session.tier,
    model: session.model || 'default',
    workspace: session.workspace || process.cwd(),
    budgetRatio: 0,
  });

  return bridge;
}

export function registerDispatchToBridge(bridge: any, dispatch: (action: any) => void) {
  if (bridge && typeof bridge.__registerDispatch === 'function') bridge.__registerDispatch(dispatch);
}
export function unregisterDispatchFromBridge(bridge: any) {
  if (bridge && typeof bridge.__unregisterDispatch === 'function') bridge.__unregisterDispatch();
}
