// src/cli/repl/compactService.ts
// context compaction — summarize old turns with the model, keep the
// most recent ones verbatim, and report the token-estimate drop.
//
// Context accounting (A2 计量修复):
//   measuredContextTokens(session)  — 真实优先：budgetReport.lastPromptTokens
//                                     （网关实测的最后一次请求 prompt 大小）
//   estimateSessionTokens(session)  — 回落口径：CJK-aware estTokens
//                                     = 1000 + Σ turns(user + summary + answer)
//
// The summarizer receives the removed turns and MUST preserve key signals:
// task essence, outcome, score, budget notes. A fake client can be injected
// for tests / offline runs.

import type { Session } from './Session.js';
import type { Turn } from './types.js';
import { getStrategy, turnBrief } from './compactStrategies.js';
import { appendCompactMarker } from './rolloutStore.js';
import { estTokens } from './tokenEstimate.js';
import { RefinedMemoryStore } from '../../memory/RefinedMemoryStore.js';
import fs from 'node:fs';
import path from 'node:path';

const KEEP_RECENT = 6;

// configured strategy id, cached per workspace (read once per process).
const strategyCache = new Map<string, string>();
function resolveStrategyId(session: Session): string {
  const ws = session.workspace || process.cwd();
  const cached = strategyCache.get(ws);
  if (cached) return cached;
  let id = 'default';
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ws, '.panshalach.json'), 'utf-8'));
    const s = raw?.compaction?.strategy;
    if (typeof s === 'string' && s) id = s;
  } catch {}
  strategyCache.set(ws, id);
  return id;
}

export interface CompactGeneration {
  /** 快照时的轮次总数 */
  turnCount: number;
  /** 快照时最后一轮的 id（rewind/steering 下 count 相同内容不同的守卫） */
  lastTurnId: string;
}

export interface CompactResult {
  ok: boolean;
  removed: number;
  kept: number;
  summary: string;
  beforeTokens: number;
  afterTokens: number;
  message: string;
  /** 接口契约 v3：快照代际——apply 时与活体会话比对，防 T0→T1 新增轮次被静默丢弃 */
  generation?: CompactGeneration;
  /** 被摘要覆盖的轮次 id（权威账本；apply 以此为界做安全合并，禁止重切 kept） */
  coveredTurnIds?: string[];
  /** 摘要来源显式化：model=模型生成；fallback=确定性逐轮 brief（不再静默） */
  summarySource?: 'model' | 'fallback' | '';
  /** 完整 synthetic turn（compact 标记事件内嵌它，使 replay 无需模型即可重建） */
  syntheticTurn?: Turn;
  /**
   * B1：补漏提炼信号随快照携带（被移除轮中 stopReason==='completed' 的
   * userInput 摘要）。compute 只计算不执行；applyCompactResult 在 marker
   * 写盘成功后统一执行——修两个缺陷：后台自动压缩路径此前完全不做提炼；
   * 手动路径在 marker 写盘失败时卡已落盘（重试会 count 虚增）。
   */
  successSignals?: Array<{ summary: string; evidence: string; taskStyle: string }>;
}

/**
 * 会话上下文 token 估算（无实测 usage 时的回落口径）。
 * 旧实现按 chars/4 且只数 userInput+summary——中文按 4 字符/token 系统性
 * 低估 ~2.5 倍，且丢掉 chat 答案正文（answerText）。改为 CJK-aware
 * estTokens 并纳入 answerText；固定基线 1000 tokens 对应旧的 4000 字符
 * system+契约开销假设。
 */
export function estimateSessionTokens(session: Session): number {
  let tokens = 1000; // system + tier contract + 工具 schema 固定开销（基线）
  for (const t of session.turns) {
    tokens += estTokens(t.userInput || '');
    tokens += estTokens(t.result?.summary || '');
    tokens += estTokens((t.result as any)?.answerText || '');
    tokens += 10; // 每轮角色/分隔符固定开销
  }
  return tokens;
}

/**
 * 真实上下文占用（tokens）——chaser 把每次模型调用的实测 usage 随
 * budgetReport 落盘，其中 lastPromptTokens 是"最后一次请求的 prompt 大小"，
 * ≈ 当前活体上下文（system+历史+全部步骤每次全量重发）。累计值
 * （estimatedUsedTokens）跨步重复计入历史，不能当上下文占用用。
 * 返回 null = 会话里没有任何实测锚点（旧会话/网关无 usage），调用方回落
 * estimateSessionTokens。
 */
export function measuredContextTokens(session: Session): number | null {
  for (let i = session.turns.length - 1; i >= 0; i--) {
    const br = (session.turns[i] as any)?.result?.budgetReport;
    const n = Number(br?.lastPromptTokens);
    if (br && br.usageMeasured === true && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function buildSummaryPrompt(removed: Turn[]): string {
  // now delegates to the configured strategy (kept as a compat shim).
  return getStrategy('default').buildPrompt(removed);
}

/** B2：fallback 摘要总长封顶——嵌套压缩不治理时摘要代代膨胀，可自身超窗。 */
const FALLBACK_SUMMARY_MAX_CHARS = 24000;
/** 被移除的上一代 [COMPACT] 合成轮，其旧摘要全文内联的上限（滚雪球治理）。 */
const NESTED_SUMMARY_MAX_CHARS = 400;

function fallbackSummary(removed: Turn[]): string {
  // Deterministic offline summary (also used when the model call fails):
  // preserves every removed turn's brief so "关键信息保留" stays verifiable.
  const lines = removed.map((t) => {
    let brief = turnBrief(t);
    // 嵌套压缩治理：[COMPACT] 合成轮的 result.summary 是上一代摘要全文，
    // turnBrief 的 r 字段无上限——不截断则每代压缩把全部历史摘要再内联一遍。
    if (String(t.userInput || '').startsWith('[COMPACT]') && String(t.result?.summary || '').length > NESTED_SUMMARY_MAX_CHARS) {
      brief = turnBrief({
        ...t,
        result: { ...(t.result || {}), summary: String(t.result?.summary || '').slice(0, NESTED_SUMMARY_MAX_CHARS) + '…[上一代摘要已截断]' },
      } as Turn);
    }
    return `- ${brief}`;
  });
  let out = `[COMPACT 历史摘要 · ${removed.length} 轮]\n` + lines.join('\n');
  if (out.length > FALLBACK_SUMMARY_MAX_CHARS) {
    out = out.slice(0, FALLBACK_SUMMARY_MAX_CHARS) + '\n…[摘要超长已截断]';
  }
  return out;
}

/**
 * Compact session.turns: summarize all but the last KEEP_RECENT turns into a
 * single synthetic turn. Model failure falls back to the deterministic brief
 * list (compaction must never lose information or block the user).
 *
 * B1 路径统一：手动 /compact 与后台自动压缩共用 compute（纯计算）+ apply
 * （唯一 mutation 路径，含 C2 写盘纪律与提炼执行）——旧行为里两条路径各自
 * 实现，后台路径漏提炼、手动路径提炼先于写盘（失败即 count 虚增）。
 */
export async function compactSession(
  session: Session,
  client: { complete(prompt: string, opts?: any): Promise<any> } | null | undefined
): Promise<CompactResult> {
  const res = await computeCompactResult(session, client ?? null);
  if (!res.ok) return res;
  return applyCompactResult(session, res);
}

/** Auto-compact trigger (CC-style): called before starting a new task. */
export interface AutoCompactTrigger {
  /**
   * M2-5 强制档：外部触发源（如 context_overflow）置 true 时绕过
   * 0.85 阈值与 12 轮门槛，只要有可压缩轮次（> KEEP_RECENT+1）即触发。
   * 调用侧：VerifyCritiqueLoop.onContextOverflow 回调里
   * `shouldAutoCompact(session, ratio, { force: true })`。
   */
  force?: boolean;
  /** 触发原因标注（记账/日志用，不影响判定）。 */
  reason?: string;
}
export function shouldAutoCompact(session: Session, ctxRatio: number, trigger?: AutoCompactTrigger): boolean {
  if (trigger?.force) return session.turns.length > KEEP_RECENT + 1;
  return ctxRatio >= 0.85 && session.turns.length > 12;
}

// ==================== background pre-compaction ====================
// The summary is computed on a SNAPSHOT of the removed turns, in the
// background, WITHOUT mutating session.turns (no races). The interactive
// layer applies the ready result at a task boundary via applyCompactResult.
// Model failure falls back to the deterministic summary. Re-entrancy: one
// in-flight compaction per session.

export interface CompactHandle {
  isReady(): boolean;
  result(): CompactResult | null;
  cancel(): void;
}

const inFlight = new Set<string>();

/**
 * 异常兜底结果（可导出测试）。N4（对抗评审 D3）：兜底也必须携带覆盖账本
 * （coveredTurnIds/generation/syntheticTurn），否则 apply 会在最易出错的路径上
 * 退回旧的"新增轮静默丢弃"行为。
 */
export function buildFallbackCompactResult(session: Session): CompactResult {
  const removed = session.turns.slice(0, Math.max(0, session.turns.length - KEEP_RECENT));
  const kept = session.turns.slice(-KEEP_RECENT);
  const summary = fallbackSummary(removed);
  return {
    ok: true, removed: removed.length, kept: kept.length,
    summary,
    beforeTokens: estimateSessionTokens(session), afterTokens: estimateSessionTokens(session),
    generation: { turnCount: session.turns.length, lastTurnId: session.turns[session.turns.length - 1]?.id ?? '' },
    coveredTurnIds: removed.map(t => t.id),
    summarySource: 'fallback',
    syntheticTurn: {
      id: 'compact-' + Date.now().toString(36),
      timestamp: Date.now(),
      userInput: `[COMPACT] 已压缩 ${removed.length} 轮历史`,
      userInputType: 'command' as const,
      tier: session.tier,
      result: { success: true, summary },
    },
    message: '后台压缩（异常兜底，确定性摘要）',
  };
}

/** Pure computation — never touches session.turns. */
async function computeCompactResult(
  session: Session,
  client: { complete(prompt: string, opts?: any): Promise<any> } | null
): Promise<CompactResult> {
  const beforeTokens = estimateSessionTokens(session);

  if (session.turns.length <= KEEP_RECENT + 1) {
    return {
      ok: false, removed: 0, kept: session.turns.length, summary: '',
      beforeTokens, afterTokens: beforeTokens,
      message: `轮次不足（${session.turns.length} ≤ ${KEEP_RECENT + 1}），无需压缩`,
    };
  }

  // SNAPSHOT the removed turns — later mutations (new tasks) must not race us.
  // 接口契约 v3：generation 在快照时刻定格（apply 时比对，防中间轮丢失）
  const generation: CompactGeneration = {
    turnCount: session.turns.length,
    lastTurnId: session.turns[session.turns.length - 1]?.id ?? '',
  };
  const removed = session.turns.slice(0, session.turns.length - KEEP_RECENT).map((t) => ({ ...t }));
  const kept = session.turns.slice(-KEEP_RECENT).map((t) => ({ ...t }));
  const successSignals = buildSuccessSignals(removed);

  let summary = '';
  let summarySource: 'model' | 'fallback' = 'fallback';
  if (client && typeof client.complete === 'function') {
    try {
      const out = await client.complete(getStrategy(resolveStrategyId(session)).buildPrompt(removed, { instruction: undefined }));
      summary = typeof out === 'string' ? out.trim() : String(out?.content ?? '').trim();
      if (summary) summarySource = 'model';
    } catch {}
  }
  if (!summary) summary = fallbackSummary(removed);

  const syntheticTurn: Turn = {
    id: 'compact-' + Date.now().toString(36),
    timestamp: Date.now(),
    userInput: `[COMPACT] 已压缩 ${removed.length} 轮历史`,
    userInputType: 'command' as const,
    tier: session.tier,
    result: { success: true, summary },
  };

  // Estimates: apply into a THROWAWAY view of the snapshot so we never mutate
  const estView = { turns: [{ ...syntheticTurn }, ...kept] } as Session;
  const afterTokens = estimateSessionTokens(estView);

  return {
    ok: true,
    removed: removed.length,
    kept: kept.length,
    summary,
    beforeTokens,
    afterTokens,
    generation,
    coveredTurnIds: removed.map(t => t.id),
    summarySource,
    syntheticTurn,
    successSignals,
    message: `后台压缩就绪：${removed.length} 轮 → 摘要（${summarySource === 'model' ? '模型摘要' : '确定性摘要兜底'}）；估算 ${beforeTokens} → ${afterTokens} tokens`,
  };
}

/**
 * B1：补漏信号源——被移除轮中【真实验证通过】（stopReason==='completed'，
 * answered 计 success 但非工程验证通过，不产卡）的输入摘要。compute 阶段
 * 只计算；applyCompactResult 在 marker 写盘成功后统一执行。
 */
function buildSuccessSignals(removed: Turn[]): Array<{ summary: string; evidence: string; taskStyle: string }> {
  return removed
    .filter((t) => (t.result as any)?.stopReason === 'completed')
    .map((t) => {
      const brief = (t.userInput || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '（无输入摘要）';
      return { summary: `已验证可行的做法：${brief}`, evidence: brief, taskStyle: 'all' };
    });
}

/**
 * Start a background compaction for `session`. Returns null when:
 * - turns are below the threshold, or
 * - the same session already has a compaction in flight (re-entrancy guard).
 * The result is latched; applyCompactResult() must be called at a task
 * boundary to actually swap session.turns.
 */
export function startBackgroundCompact(
  session: Session,
  client: { complete(prompt: string, opts?: any): Promise<any> } | null
): CompactHandle | null {
  if (session.turns.length <= KEEP_RECENT + 1) return null;
  if (inFlight.has(session.id)) return null;
  inFlight.add(session.id);

  let cancelled = false;
  let ready = false;
  let result: CompactResult | null = null;

  (async () => {
    try {
      if (cancelled) return;
      result = await computeCompactResult(session, client);
    } catch {
      result = buildFallbackCompactResult(session);
    } finally {
      ready = true;
      // remove from inFlight lazily: keep guard until result consumed? The
      // spec says cancel() clears; a second trigger while ready-but-unapplied
      // should be allowed (nothing in flight anymore).
      inFlight.delete(session.id);
    }
  })();

  return {
    isReady: () => ready,
    result: () => (ready ? result : null),
    cancel: () => {
      cancelled = true;
      inFlight.delete(session.id);
    },
  };
}

/**
 * Apply a ready background result onto the session at a task boundary.
 * 接口契约 v3（对抗评审 F5/A5 修复）：
 * - 禁止从活体 turns 重切 kept（旧行为 `slice(-KEEP_RECENT)` 会静默丢弃
 *   快照→apply 之间新增的轮次）；
 * - 以快照 coveredTurnIds 为权威边界做安全合并：被摘要覆盖的轮次移除，
 *   其余全部保留（旧 kept ∪ 快照后新增轮）；
 * - 摘要正文/来源/代际随 CompactResult 携带，并写入 rollout compact 标记。
 */
export function applyCompactResult(session: Session, res: CompactResult, windowTokens?: number): CompactResult {
  if (!res || !res.ok || res.removed === 0) {
    return res ?? { ok: false, removed: 0, kept: session.turns.length, summary: '', beforeTokens: 0, afterTokens: 0, message: '无可用后台压缩结果' };
  }

  const liveIds = new Set(session.turns.map(t => t.id));

  // N1（血统校验，fail-safe）：快照的最后一轮已不在活体（rewind 到 covered 区间等）→
  // 覆盖账本不可信，拒绝本次 apply，绝不触碰 session.turns（对抗评审 D1：防数据全灭）。
  if (res.generation?.lastTurnId && !liveIds.has(res.generation.lastTurnId)) {
    return {
      ...res,
      ok: false,
      message: `✗ 已拒绝应用压缩：快照代际与当前会话血统断开（lastTurnId=${res.generation.lastTurnId} 不存在，可能发生 rewind）。会话未修改。`,
    };
  }

  const covered = new Set(res.coveredTurnIds ?? []);
  const remaining = covered.size > 0
    ? session.turns.filter(t => !covered.has(t.id))
    : session.turns.slice(-KEEP_RECENT); // 无账本的旧结果：退回旧行为（兼容）

  const before = session.turns.length;
  const ledgerDropped = before - remaining.length; // 账本口径的移除数（收缩前定格，B4 收缩不计入代际漂移）
  const synthetic: Turn = res.syntheticTurn ?? {
    id: 'compact-' + Date.now().toString(36),
    timestamp: Date.now(),
    userInput: `[COMPACT] 已压缩 ${res.removed} 轮历史`,
    userInputType: 'command',
    tier: session.tier,
    result: { success: true, summary: res.summary },
  };

  // B4：kept 字节感知收缩——KEEP_RECENT 按条数保留，巨轮（大文件读写结果
  // 落在 result.summary/answerText）可让压缩后仍逼近窗口。提供 windowTokens
  // 时从最旧 kept 继续收缩（下限 2 轮），直到估算 ≤60% 窗口。
  let shrunk = 0;
  if (windowTokens && windowTokens > 0 && remaining.length > 2) {
    const capTokens = windowTokens * 0.6;
    while (remaining.length > 2
      && estimateSessionTokens({ turns: [synthetic, ...remaining] } as Session) > capTokens) {
      remaining.shift();
      shrunk++;
    }
  }

  // C2：与 compactSession 同一纪律 —— marker 先写盘成功再改内存（防双源分歧）。
  // afterTokens 用一次性快照视图估算（不触碰活体 session）。
  const estView = { turns: [synthetic, ...remaining] } as Session;
  const afterTokens = estimateSessionTokens(estView);
  const markerWritten = appendCompactMarker(session.id, synthetic, [...covered], res.beforeTokens, afterTokens);
  if (!markerWritten) {
    return {
      ...res,
      ok: false,
      afterTokens,
      syntheticTurn: undefined,
      message: '✗ 已拒绝应用压缩：rollout 压缩标记写盘失败（resume 权威源不可写）。会话未修改，防双源分歧；请检查磁盘/权限后重试。',
    };
  }

  session.turns = [synthetic, ...remaining];

  // B1：补漏提炼在 marker 写盘成功后统一执行（手动/后台同路径）——
  // 旧行为手动路径先提炼后写盘，写盘失败时卡已落盘、重试 count 虚增；
  // 后台自动路径则完全漏提炼。refineCompactSignals 全同步；memory
  // best-effort，失败不阻断压缩。
  if (res.successSignals && res.successSignals.length > 0) {
    try {
      const store = new RefinedMemoryStore(session.workspace);
      store.refineCompactSignals(res.successSignals.map((s) => ({ ...s, now: Date.now() })));
    } catch {}
  }

  // 代际漂移检测：快照后新增了轮（before > generation.turnCount）或账本口径
  // 实际移除数与快照不符（rewind 等场景）→ 提示已按覆盖账本安全合并
  const staleGen = !!res.generation
    && (before > res.generation.turnCount || ledgerDropped !== res.removed);
  return {
    ...res,
    kept: remaining.length,
    afterTokens,
    message: `✓ 已压缩 ${res.removed} 轮历史（${res.summarySource === 'model' ? '模型摘要' : '确定性摘要兜底'}）；估算上下文 ${res.beforeTokens} → ${afterTokens} tokens`
      + (shrunk > 0 ? `；kept 超预算已再收缩 ${shrunk} 轮（下限 2）` : '')
      + (staleGen ? '；快照后发生变更，已按覆盖账本安全合并' : ''),
  };
}
