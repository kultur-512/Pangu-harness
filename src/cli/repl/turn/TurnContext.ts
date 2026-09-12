// src/cli/repl/turn/TurnContext.ts
// M1-TurnController（0.8 第 2 步，四模块搬家）：TurnContext 巨状态显式化模块。
// TurnContext 接口 + createTurnContext 工厂 + 纯状态操作函数（原 sseInteractive
// 模块级函数中只依赖 ctx 的部分，body 逐字节保持）。
// 依赖纪律：本模块是 turn/ 的叶子，只依赖 repl/ 外部模块，不反向 import turn/ 其余模块。

import readline from 'readline';
import { createOutputRenderer } from '../OutputRenderer.js';
import { Session } from '../Session.js';
import { InputQueue } from '../InputQueue.js';
import { AgentTree } from '../AgentTree.js';
import type { ModeRing } from '../ModeRing.js';
import type { ModelProvider } from '../types.js';

export type OutputRendererLike = ReturnType<typeof createOutputRenderer>;

export interface LineUiState {
  inlineLine: null | 'gerund' | 'thinking';
  messageStreaming: boolean;
  streamedAnswerChars: number;
  /** U2 流式正文行缓冲残段：不足一个完整段（\n / 。收尾）时暂存，段结束冲刷。 */
  messageBuf: string;
  verbose: boolean;
  thinkingStart: number;
  thinkingBuf: string;
  thinkingPrinted: boolean;
  taskStartedAt: number;
  taskEndedAt: number;
  ghostIgnored: boolean;
  stepCount: number;
  lastSigintAt: number;
  idleCtrlCAt: number;
  toolStack: Array<{ tool: string; params: Record<string, string> }>;
  pendingTool: { tool: string; summary: string; doing: string; at: number } | null;
}

export function createLineUiState(): LineUiState {
  return {
    inlineLine: null,
    messageStreaming: false,
    streamedAnswerChars: 0,
    messageBuf: '',
    verbose: process.env.PANSHA_VERBOSE === '1',
    thinkingStart: 0,
    thinkingBuf: '',
    thinkingPrinted: false,
    taskStartedAt: 0,
    taskEndedAt: 0,
    ghostIgnored: false,
    stepCount: 0,
    lastSigintAt: 0,
    idleCtrlCAt: 0,
    toolStack: [],
    pendingTool: null,
  };
}

/** in-flight background compaction 句柄（compactService.startBackgroundCompact 返回形状）。 */
export interface BgCompactHandle { isReady(): boolean; result(): any; cancel(): void }

export interface TurnContext {
  session: Session;
  /** 显式注入的 provider（opts.provider；缺省时运行时 resolveSharedClient 兜底）。 */
  provider?: ModelProvider;
  /** 清活行纪律包装后的 renderer（所有正式输出前先 \r\x1b[K）。 */
  renderer: OutputRendererLike;
  /** rich UI bridge（Ink 未启动时 current=null）。ref 形态保证初始 lambda 见到更新。 */
  bridgeRef: { current: any };
  lineUi: LineUiState;
  queue: InputQueue;
  agentTree: AgentTree;
  modeRing: ModeRing;
  ctxWindowTokens: number;
  ctxUsedChars: number;
  /** line 模式主 readline（rich 路径恒 null）。 */
  lineRl: readline.Interface | null;
  lineSetPrompt: () => void;
  /** 待定命令建议：只在 line 空闲态由「未知命令」分支置位；回车确认执行，Esc/其他输入取消。 */
  pendingSuggestion: string | null;
  modeBadgePending: boolean;
  tipGate: ReturnType<typeof createTipGate>;
  lastOutput: string;
  currentAbort: AbortController | null;
  lastInjectedSteers: string[];
  lastAborted: boolean;
  bgCompact: BgCompactHandle | null;
  treeTaskStart: number;
  mcpClients: Map<string, any>;
  mcpToolsReady: any[];
  mcpInitDone: boolean;
  sharedRegistry: any;
  /**
   * 测试注入缝（M1-TurnController 行为锁定）：默认未设置 → runTaskViaSse 走真实
   * `import('../../server/runAgentTask.js')`，运行时行为不变。
   */
  loadRunAgentTask?: () => Promise<{ runAgentTask: typeof import('../../../server/runAgentTask.js')['runAgentTask'] }>;
  /**
   * rich 桥 running 徽标状态：setRunning(true) 置位，result/done/error 任一复位清零。
   * 任务收尾的兜底复位只在仍为 true 时执行——防 result+done 双终态事件导致
   * setRunning(false) 重复下发（行为锁定测试断言 [true,false]）。
   */
  runningBadgeOn?: boolean;
  /**
   * CC 式 /tier 交互滑杆选择态（_ttyWrite 拦截 ←→/Enter/Esc；与 SlashMenu 互斥）。
   * active=false 或 null = 未激活。sublabels 供重绘副标注行。
   */
  effortSel: { active: boolean; tiers: string[]; sublabels: string[]; index: number } | null;
  /** line 模式 readline 原位重画（_refreshLine 包装；rich 路径恒空操作）。 */
  lineRefreshLine: () => void;
}

export function createTurnContext(init: {
  session: Session;
  provider?: ModelProvider;
  renderer?: OutputRendererLike;
}): TurnContext {
  return {
    session: init.session,
    provider: init.provider,
    renderer: init.renderer ?? createOutputRenderer(),
    bridgeRef: { current: null },
    lineUi: createLineUiState(),
    queue: new InputQueue(),
    agentTree: new AgentTree(),
    modeRing: null as unknown as ModeRing, // startSseInteractive / createModeRing 接线
    ctxWindowTokens: 32768,
    ctxUsedChars: 0,
    lineRl: null,
    lineSetPrompt: () => {},
    pendingSuggestion: null,
    modeBadgePending: true,
    tipGate: createTipGate(2),
    lastOutput: '',
    currentAbort: null,
    lastInjectedSteers: [],
    lastAborted: false,
    bgCompact: null,
    treeTaskStart: 0,
    mcpClients: new Map(),
    mcpToolsReady: [],
    mcpInitDone: false,
    effortSel: null,
    lineRefreshLine: () => {},
    sharedRegistry: null,
  };
}

/**
 * 情境 tip 节流 — 每类触发点一次性（key 去重）+ 每会话全局上限（默认 2 条）。
 */
export function createTipGate(max = 2) {
  let shown = 0;
  const seen = new Set<string>();
  return {
    canShow(key: string): boolean {
      return shown < max && !seen.has(key);
    },
    markShown(key: string): void {
      if (!seen.has(key)) {
        seen.add(key);
        if (shown < max) shown += 1;
      }
    },
    get shownCount(): number {
      return shown;
    },
  };
}

// ---- 状态操作（原 sseInteractive 模块级函数，body 逐字节保持） ----

export function clearInlineLine(ctx: TurnContext) {
  if (ctx.lineUi.inlineLine) {
    try { process.stdout.write('\r\x1b[K'); } catch {}
    ctx.lineUi.inlineLine = null;
  }
}

export function resolveCtxWindowTokens(ctx: TurnContext): number {
  const env = Number(process.env.PANSHA_CTX_WINDOW || 0);
  if (Number.isFinite(env) && env > 0) return env;
  try {
    const p = (ctx.provider ?? (ctx.session as any).provider) as any;
    const n = Number(p?.getModelContextLength?.(ctx.session.model));
    if (Number.isFinite(n) && n > 0 && n !== 256000) return n;
  } catch {}
  return 32768;
}

export function bumpCtx(ctx: TurnContext, text: any) {
  if (typeof text === 'string') ctx.ctxUsedChars += text.length;
}

export function isRunning(ctx: TurnContext): boolean {
  return ctx.currentAbort !== null;
}

export function recordOutput(ctx: TurnContext, text: string) {
  if (text && text.trim()) ctx.lastOutput = text.trim();
}

export function getLastOutput(ctx: TurnContext): string { return ctx.lastOutput; }

export function updateQueueCount(ctx: TurnContext) {
  if (typeof (ctx.bridgeRef as any).current?.setQueueCount === 'function') {
    try { ctx.bridgeRef.current.setQueueCount(ctx.queue.size, ctx.queue.taskCount, ctx.queue.steerCount); } catch {}
  }
}

export function emitFeed(ctx: TurnContext, text: string, level: 'info' | 'warn' | 'error' | 'success' = 'info', colorOverride?: 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray' | 'bold') {
  if (typeof (ctx.bridgeRef as any).current?.pushFeed === 'function') {
    try { ctx.bridgeRef.current.pushFeed({ type: 'text', text, level }); } catch {}
  } else {
    ctx.renderer.writeLine(ctx.renderer.color(text, colorOverride ?? (level === 'warn' ? 'yellow' : level === 'error' ? 'red' : 'gray')));
  }
}

// unified synchronous compaction — client resolution, success/
// failure feedback and TopBar meter reset live HERE (was duplicated at
// /compact and the critical sync-fallback).
export async function runSyncCompact(ctx: TurnContext, reasonPrefix = ''): Promise<any> {
  const { compactSession, estimateSessionTokens } = await import('../compactService.js');
  const { resolveSharedClient } = await import('../ModelProvider.js');
  const rich = !!ctx.bridgeRef.current; // same semantics as runTaskViaSse's useRich
  let client: any = null;
  try { client = (await resolveSharedClient(ctx.session.model, ctx.provider as any)).client; } catch {}
  const r = await compactSession(ctx.session, client);
  if (r.ok) {
    ctx.ctxUsedChars = estimateSessionTokens(ctx.session) * 4;
    const msg = reasonPrefix + r.message;
    if (rich && typeof ctx.bridgeRef.current.pushFeed === 'function') ctx.bridgeRef.current.pushFeed({ type: 'text', text: msg, level: reasonPrefix ? 'warn' : 'success' });
    else if (reasonPrefix) ctx.renderer.warn(msg);
    else ctx.renderer.success(msg);
    if (rich && typeof ctx.bridgeRef.current.setTop === 'function') {
      const nr = Math.min(1, (ctx.ctxUsedChars / 4) / ctx.ctxWindowTokens);
      try { ctx.bridgeRef.current.setTop({ ctxRatio: nr }); } catch {}
    }
  } else {
    if (rich && typeof ctx.bridgeRef.current.pushFeed === 'function') ctx.bridgeRef.current.pushFeed({ type: 'text', text: r.message, level: 'warn' });
    else ctx.renderer.warn(r.message);
  }
  return r;
}
