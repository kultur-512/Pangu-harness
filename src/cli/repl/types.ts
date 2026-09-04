// src/cli/repl/types.ts
// Panshalach (ZIS: Panshalach Interactive Shell 的历史简称，保留内部注释名) 类型定义
// 严格遵守蓝图 v1.1

import type { Tier } from '../../tiers/TierConfig.js';
import type { BudgetReport } from '../../PanshalachChaser.js';
import type { ToolCall } from '../../types/toolCall.js';

// ==================== StepEvent ====================
export type StepEvent =
  | { version: 1; type: 'phase'; phase: 'explore' | 'rollout' | 'judge' | 'done'; data?: any }
  | {
      version: 1;
      type: 'step';
      rolloutId: string;
      stepNumber: number;
      thinking?: string;
      plan?: string;
      toolCalls: ToolCall[];
      result?: string;
      aborted?: boolean;
    }
  | { version: 1; type: 'critique'; rolloutId: string; stepNumber: number; critique: string }
  | { version: 1; type: 'softLimit'; usedRatio: number }
  | { version: 1; type: 'degradation'; reason: string }
  // M1-2.4 (append-only per instruction): approval request surfaces through the
  // same onStep channel so rich/line UIs can render a confirm card.
  | {
      version: 2;
      type: 'approval.request';
      requestId: string;
      tool: string;
      description: string;
      danger: boolean;
    };

// ==================== Session ====================
export interface Turn {
  id: string;
  timestamp: number;
  userInput: string;
  userInputType: 'command' | 'task' | 'multiline';
  result?: {
    success: boolean;
    summary: string;
    trajectoryId?: string;
    budgetReport?: BudgetReport;
  };
  tier: Tier;
  durationMs?: number;
}

export interface SessionFile {
  schemaVersion: 1;
  id: string;           // uuid
  name?: string;
  createdAt: number;
  updatedAt: number;
  tier: Tier;
  workspace: string;
  model: string;
  // M1-2.4 (append-only per instruction): approval state persists with the session
  approvalMode?: 'readonly' | 'default' | 'full';
  sessionApprovalAllowlist?: string[];
  turns: Turn[];
  stats: {
    totalTurns: number;
    totalTokens: number;
    totalDurationMs: number;
  };
}

export interface SessionSummary {
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  tier: Tier;
  workspace: string;
  turnCount: number;
}

// ==================== Command System ====================
export interface CommandContext {
  session: any;           // Session instance (forward ref to avoid circular)
  registry: any;          // CommandRegistry
  renderer: OutputRenderer;
  input: InputReader;
  repl: any;              // Repl instance
  provider?: ModelProvider; // P3: ModelProvider for resolving clients (never pass null to PanshalachChaser)
}

export interface CommandResult {
  message?: string;
  data?: any;
  exit?: boolean;           // trigger REPL exit
  clearScreen?: boolean;
}

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  category: 'system' | 'state' | 'task' | 'session' | 'config';
  usage?: string;
  execute(ctx: CommandContext, args: string[]): Promise<CommandResult>;
}

// ==================== Output & Input ====================
export type ColorName = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray' | 'bold' | 'reset';

export interface SpinnerHandle {
  stop(): void;
  text(text: string): void;
}

export interface OutputRenderer {
  write(text: string): void;
  writeLine(text: string): void;
  color(text: string, color: ColorName): string;
  startSpinner(text: string): SpinnerHandle;
  table(headers: string[], rows: string[][]): void;
  codeBlock(content: string, lang?: string): void;
  error(msg: string): void;
  warn(msg: string): void;
  success(msg: string): void;
  info(msg: string): void;
  clearScreen(): void;
  stream(text: string): void;           // for streaming model output
}

export interface InputReader {
  read(prompt?: string): Promise<string>;
  pause(): void;
  resume(): void;
  close(): void;
  on(event: 'line', listener: (line: string) => void): void;
  on(event: 'keypress', listener: (key: any) => void): void;
  history: string[];
  // Extended for multiline / completer integration (implementation only)
  waitForNextLine?(): Promise<string>;
  enterMultiline?(): void;
  exitMultiline?(): void;
  isMultiline?(): boolean;
}

// ==================== Config ====================
export interface ProviderConfig {
  type: 'openai-compatible';
  baseUrl: string;
  apiKey?: string;
  /** Pre-cached or user-provided model list. If empty/missing, registry will try to fetch from /models */
  models?: string[];
  /** Per-model context window in tokens. If missing for a model, default to 256000 (256K) */
  modelContexts?: Record<string, number>;
}

export interface PanshalachConfig {
  tier?: Tier;
  workspace?: string;
  model?: string;
  providers?: Record<string, ProviderConfig>;
  repl?: {
    colorEnabled?: boolean;
    autoCompact?: boolean;
    maxHistory?: number;
    showStepDetails?: boolean;
    sessionDir?: string;
  };
  memory?: {
    autoRefine?: boolean;
    maxCardsPerLoad?: number;
  };
  confirmation?: {
    skipFor?: Tier[];
  };
}

// ==================== Misc ====================
export interface StepCallback {
  (event: StepEvent): void;
}

// ==================== P3: ModelProvider abstraction (per ModelProvider blueprint) ====================
/** 流式 chunk（P1.1）：reasoning 对应 reasoning_content 风格的思考增量 */
export type ModelStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string };

/** 最小可调用模型客户端接口，与 PanshalachChaser 兼容 */
export interface ModelClient {
  complete(prompt: string, opts?: CompleteOptions): Promise<string | ModelClientOutput>;
  /**
   * P1.1: optional token-level streaming. When present, the chaser wrapper
   * prefers it over complete() and re-emits deltas as protocol-v2 events.
   * Must yield at least the full text across chunks; implementers may also
   * just fall back internally to complete() if streaming is unavailable.
   */
  streamChat?(prompt: string, opts?: CompleteOptions): AsyncIterable<ModelStreamChunk>;
}

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  // 未来可按需扩展（stream、tools 等）
  [key: string]: unknown;
}

export interface ModelClientOutput {
  content?: string;
  raw?: string;
  toolCalls?: unknown[];
  detectedFormat?: string;
}

/** 模型提供者：负责把模型名解析为可调用客户端。create* 不可用时必须返回 null（不 throw）。 */
export interface ModelProvider {
  /** 默认模型名（REPL 初始值） */
  readonly defaultModel: string;
  /** 可用模型名列表（供 /model 补全与校验） */
  listModels(): string[];
  /** 校验模型名是否可用 */
  isModelAvailable(name: string): boolean;
  /** 根据模型名创建可调用客户端；不可用返回 null（不 throw） */
  createClient(name: string): ModelClient | null;
  /** 解析当前默认可用客户端；无可用返回 null */
  createDefaultClient(): ModelClient | null;

  // Scnet / remote provider support (optional but implemented for scnet)
  listProviderModels?(providerName: string): Promise<string[] | null>;
  listProviderModelsWithContext?(providerName: string): Promise<Array<{ id: string; contextLength: number }> | null>;
  adoptRemoteModels?(providerName: string, models: string[], contexts?: Record<string, number>): void;

  /** Get the context window (in tokens) for a given model name. Falls back to 256000. */
  getModelContextLength?(name: string): number;

  /**
   * For provider shorthand names ("a6", "scnet", etc.), returns the concrete model id that will be used.
   * For normal names returns the input as-is.
   */
  getEffectiveModel?(name: string): string;

  /**
   * Force the provider to re-read .panshalach.json and environment for providers (e.g. after user creates config).
   */
  invalidateProviderCache?(): void;
}

// ==================== P2-A: Path expansion for @path in run/simulate ====================
export interface PathExpansionResult {
  /** Safe resolved absolute paths that are within the workspace root (prefix-checked) */
  expanded: string[];
  /** Original @-tokens (without @) that resolved outside the workspace or failed prefix check */
  rejected: string[];
}

/**
 * Expand @path tokens found in user input.
 * - Uses path.resolve against workspace
 * - Prefix check: resolved must be inside workspace root (or equal)
 * - Returns expanded (safe absolutes) + rejected (original token without leading @)
 * - Also returns a cleaned string with @tokens removed (for task body)
 */
import { resolve as pathResolve, sep as pathSep } from 'node:path';

export function expandAtPaths(input: string, workspace: string): { result: PathExpansionResult; cleaned: string } {
  if (!input || !workspace) {
    return { result: { expanded: [], rejected: [] }, cleaned: input || '' };
  }

  const wsRoot = pathResolve(workspace);
  const wsPrefix = wsRoot.endsWith(pathSep) ? wsRoot : wsRoot + pathSep;

  const tokens: string[] = [];
  // Match @token (stop at whitespace or common punctuation that is not path-like)
  // Support @src/foo, @src\foo, @"with spaces" is not supported; use unquoted simple paths.
  const re = /@([^\s"'`]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    tokens.push(m[1]);
  }

  const expanded: string[] = [];
  const rejected: string[] = [];

  for (const t of tokens) {
    // resolve relative to workspace
    const abs = pathResolve(wsRoot, t);
    const safe = (abs === wsRoot) || abs.startsWith(wsPrefix);
    if (safe) {
      expanded.push(abs);
    } else {
      rejected.push(t);
    }
  }

  // Build cleaned task: remove the @token occurrences (keep surrounding text)
  let cleaned = input;
  for (const t of tokens) {
    // Remove "@t" occurrences (word boundary-ish)
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp('@' + esc, 'g'), '');
  }
  // Collapse extra spaces that may result
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  return {
    result: { expanded, rejected },
    cleaned: cleaned || input,
  };
}

// ==================== Ink UI (Path B) — additive only ====================

export type FeedItem =
  | { id: string; type: 'text'; text: string; level?: 'info' | 'warn' | 'error' | 'success' }
  | { id: string; type: 'phase'; phase: 'explore' | 'rollout' | 'judge' | 'done' }
  | { id: string; type: 'step'; stepNumber: number; thinking?: string; plan?: string; toolCalls?: any[] }
  | { id: string; type: 'critique'; stepNumber: number; critique: string }
  | {
      id: string;
      type: 'tool';
      tool: string;
      target?: string;
      argsSummary?: string;
      result?: string;
      status: 'running' | 'ok' | 'fail';
    }
  | { id: string; type: 'thought'; short: string; full?: string }
  | { id: string; type: 'budget'; usedRatio: number }
  | { id: string; type: 'markdown'; content: string };

export interface UiState {
  top: {
    tier: string;
    model: string;
    workspace: string;
    budgetRatio: number; // 0..1
    /** P0.3: heuristic estimated-context usage ratio (0..1), chars/4 over nominal window */
    ctxRatio?: number;
  };
  feed: FeedItem[];
  input: {
    value: string;
    history: string[];
    multiline: boolean;
  };
  confirm?: {
    message: string;
    onResolve: (yes: boolean) => void;
  };
  running: boolean;
  /** P1.4: live in-flight buffers (cleared when the turn settles) */
  streamThinking: string;
  streamMessage: string;
}

export interface UiBridge {
  pushFeed(item: Omit<FeedItem, 'id'>): void;
  setTop(partial: Partial<UiState['top']>): void;
  setRunning(running: boolean): void;
  setConfirm(confirm: UiState['confirm'] | undefined): void;
  submitInput(text: string): void;
  updateInput(value: string): void;
}

export interface InkStartResult {
  started: boolean;
}
