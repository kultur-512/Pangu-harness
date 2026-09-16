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

/**
 * feed 白名单：只有这些 type 的 item 可以原样进入 ink 渲染树。
 * 引擎内部事件（tools/pre-execute / tools/post-execute / approval.request /
 * memory.finalized / 任意未知 type）一律归一化为安全的 text item——
 * 裸对象/裸字符串进入 ink 树会触发 "Text string must be rendered inside
 * <Text> component" 崩溃（真机 0.8.3 实测，任务一开始整个 UI unmount）。
 */
const SAFE_FEED_TYPES: ReadonlySet<string> = new Set([
  'text', 'phase', 'step', 'critique', 'tool', 'thought', 'budget', 'markdown',
]);

/** 未知/畸形 item 的单行灰字摘要（type + 少量可读字段），绝不返回裸字符串/任意对象。 */
function safeSummaryItem(item: any): { type: 'text'; text: string; level: 'info' } {
  const t = item && item.type ? String(item.type) : 'event';
  const parts: string[] = [];
  if (item && typeof item === 'object') {
    for (const k of ['tool', 'phase', 'reason', 'message', 'error']) {
      const v = (item as any)[k];
      if (v != null && String(v).trim()) parts.push(`${k}=${String(v).replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  } else if (item != null) {
    parts.push(String(item).slice(0, 120));
  }
  return { type: 'text', text: parts.length ? `· ${t} ${parts.join(' ')}` : `· ${t}`, level: 'info' };
}

/** 把任意 pushFeed 入参归一化为可安全渲染的 feed item（永不返回裸字符串/任意对象）。 */
export function toSafeFeedItem(item: any): { type: string; [k: string]: any } {
  if (typeof item === 'string') {
    return { type: 'text', text: item, level: 'info' };
  }
  if (item && typeof item === 'object' && SAFE_FEED_TYPES.has(String(item.type))) {
    // REVIEW M2：白名单分支还要校验关键字段类型——{type:'text', text:{...}}
    // 这类畸形 item 原样透传会把非字符串塞进 <Text>（同款 ink 崩溃旁路）。
    // text.text / markdown.content 非字符串 → 降级为单行摘要。
    const t = String(item.type);
    if (t === 'text' && typeof item.text !== 'string') return safeSummaryItem(item);
    if (t === 'markdown' && typeof item.content !== 'string') return safeSummaryItem(item);
    return item;
  }
  // 未知/内部事件 → 单行灰字摘要（type + 少量可读字段），绝不透传原对象
  return safeSummaryItem(item);
}

// interactive confirm state (rich UI approval bridge).
// The resolver lives OUTSIDE React state on purpose: the engine awaits the
// promise while the reducer only carries the serializable request for render.
export interface ConfirmRequest {
  tool: string;
  description: string;
  danger?: boolean;
  diff?: any[];
}
let currentConfirm: { request: ConfirmRequest; resolve: (d: 'y' | 'n' | 'a') => void } | null = null;

// CC 式 /tier 交互滑杆（rich）——resolver 同样活在 React 之外：
// 斜杠命令 await openTierPicker()，TierPicker 组件按键后 resolveTierPicker。
export interface TierPickerState {
  tiers: string[];
  sublabels: string[];
  index: number;
}
let currentTierPicker: { resolve: (index: number | null) => void } | null = null;

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
  // re-entrancy guard: 无 dispatch 时的 renderer.writeLine 兜底本身会被
  // renderer 的 feedSink 送回 pushFeed（ink 启动窗口期 feedSink 已挂、
  // dispatch 未注册）——不加守卫会无限递归栈溢出。
  let feedFallbackWriting = false;

  const pushFeed = (item: Omit<FeedItem, 'id'>) => {
    // 归一化门：任何调用方（含 mapSseToBridge fallback / Repl onStep）推来的
    // 未知事件在此收敛为安全 item，裸对象/裸字符串绝不进入 ink 树。
    const safe: any = toSafeFeedItem(item);
    const withId: FeedItem = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      ...(safe as any),
    };
    if (currentDispatch) {
      currentDispatch({ type: 'PUSH_FEED', item: withId });
      // If it's a phase, also surface it in top bar
      if ((withId as any).type === 'phase' && (withId as any).phase) {
        currentDispatch({ type: 'SET_PHASE', phase: (withId as any).phase });
      }
    } else if (feedFallbackWriting) {
      // 兜底链路重入——丢弃（无 UI 可显示）
    } else {
      try {
        if (withId.type === 'text' && (withId as any).text) {
          feedFallbackWriting = true;
          renderer.writeLine((withId as any).text);
        }
      } catch {} finally {
        feedFallbackWriting = false;
      }
    }
  };

  const setTop = (partial: Partial<UiState['top']>) => {
    if (currentDispatch) currentDispatch({ type: 'SET_TOP', partial });
  };

  const setRunning = (running: boolean) => {
    if (currentDispatch) currentDispatch({ type: 'SET_RUNNING', running });
  };

  // legacy setter kept for the old reducer action (unused by the new
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

  // live streaming buffers
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

  // queued-messages badge (rich bottom bar)
  const setQueueCount = (total: number, tasks: number, steers: number) => {
    if (!currentDispatch) return;
    currentDispatch({ type: 'SET_QUEUE_COUNT', total, tasks, steers });
  };

  // rich approval bridge — the engine awaits setConfirm(request);
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

  // /clear（rich）：清空对话 feed（ink 拥有屏幕，行模式 ANSI 清屏在这里无意义）
  const clearScreen = () => {
    if (currentDispatch) currentDispatch({ type: 'CLEAR_FEED' });
  };

  // CC 式 /tier 交互滑杆（rich）：挂起斜杠命令直到用户确认/取消。
  // 返回 null = rich UI 未挂载（dispatch 未注册，启动窗口/降级）→ 调用方回退
  // 单行静态说明；>= 0 = 确认的档位下标；-1 = 取消。
  const openTierPicker = (opts: { tiers: string[]; sublabels?: string[]; index: number }): Promise<number | null> => {
    if (!currentDispatch) return Promise.resolve(null);
    // REVIEW M1：入口防孤儿——上一个 picker 未决（组件被卸载/重开竞态）时
    // 先按"取消"落定旧 Promise，再覆盖 resolver；否则旧 await 永不 settle，
    // 且覆盖后其 resolver 被丢弃成孤儿。
    if (currentTierPicker) {
      const stale = currentTierPicker;
      currentTierPicker = null;
      try { stale.resolve(-1); } catch {}
    }
    return new Promise((resolve) => {
      currentTierPicker = { resolve };
      const picker: TierPickerState = {
        tiers: (opts.tiers || []).map((t) => String(t || '')),
        sublabels: (opts.sublabels || []).map((s) => String(s || '')),
        index: Number(opts.index) || 0,
      };
      currentDispatch!({ type: 'SET_TIER_PICKER', picker });
    });
  };

  const resolveTierPicker = (index: number) => {
    const c = currentTierPicker;
    currentTierPicker = null;
    if (currentDispatch) currentDispatch({ type: 'SET_TIER_PICKER', picker: undefined });
    if (c) c.resolve(Number(index));
  };

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

  // @deprecated: legacy confirm helper — the real approval flow uses
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

  // provider→model options are PURELY LOCAL — the
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
    // real approval bridge
    setConfirm,
    resolveConfirm,
    hasPendingConfirm,
    // /clear（rich 清空 feed）+ /tier 交互滑杆
    clearScreen,
    openTierPicker,
    resolveTierPicker,
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
    // provider→model options for the /model two-stage picker
    providerOptions,
  };

  bridge.__registerDispatch = (dispatch: (action: any) => void) => {
    currentDispatch = dispatch;
  };
  bridge.__unregisterDispatch = () => {
    currentDispatch = null;
    // REVIEW M1：ink 应用在 picker 挂起期间 unmount 时，若只注销 dispatch，
    // currentTierPicker 残留 → await openTierPicker 永不 settle（斜杠命令悬挂）。
    // 未决 picker 一律按"未挂载"落定 resolve(null)；同类的未决审批同理按拒绝
    // 落定（engine await 的 promise 不允许跨 unmount 悬挂）。
    if (currentTierPicker) {
      const stale = currentTierPicker;
      currentTierPicker = null;
      try { stale.resolve(null); } catch {}
    }
    if (currentConfirm) {
      const staleConfirm = currentConfirm;
      currentConfirm = null;
      try { staleConfirm.resolve('n'); } catch {}
    }
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
