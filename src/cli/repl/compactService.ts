// src/cli/repl/compactService.ts
// M2.3: context compaction — summarize old turns with the model, keep the
// most recent ones verbatim, and report the token-estimate drop.
//
// Claude-Code-style context accounting (heuristic chars/4):
//   estimateTokens(session) = 4k + Σ turns(userInput + summary)
//
// The summarizer receives the removed turns and MUST preserve key signals:
// task essence, outcome, score, budget notes. A fake client can be injected
// for tests / offline runs.

import type { Session } from './Session.js';
import type { Turn } from './types.js';
import { getStrategy, turnBrief } from './compactStrategies.js';
import fs from 'node:fs';
import path from 'node:path';

const KEEP_RECENT = 6;
const EST_CHARS_PER_TOKEN = 4;

// P1-T15: configured strategy id, cached per workspace (read once per process).
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

export interface CompactResult {
  ok: boolean;
  removed: number;
  kept: number;
  summary: string;
  beforeTokens: number;
  afterTokens: number;
  message: string;
}

export function estimateSessionTokens(session: Session): number {
  let chars = 4000; // system + tier contract baseline
  for (const t of session.turns) {
    chars += (t.userInput?.length || 0);
    chars += (t.result?.summary?.length || 0);
    chars += 40;
  }
  return Math.ceil(chars / EST_CHARS_PER_TOKEN);
}

function buildSummaryPrompt(removed: Turn[]): string {
  // P1-T15: now delegates to the configured strategy (kept as a compat shim).
  return getStrategy('default').buildPrompt(removed);
}

function fallbackSummary(removed: Turn[]): string {
  // Deterministic offline summary (also used when the model call fails):
  // preserves every removed turn's brief so "关键信息保留" stays verifiable.
  return `[COMPACT 历史摘要 · ${removed.length} 轮]\n` + removed.map((t) => `- ${turnBrief(t)}`).join('\n');
}

/**
 * Compact session.turns: summarize all but the last KEEP_RECENT turns into a
 * single synthetic turn. Model failure falls back to the deterministic brief
 * list (compaction must never lose information or block the user).
 */
export async function compactSession(
  session: Session,
  client: { complete(prompt: string, opts?: any): Promise<any> } | null | undefined
): Promise<CompactResult> {
  const beforeTokens = estimateSessionTokens(session);

  if (session.turns.length <= KEEP_RECENT + 1) {
    return {
      ok: false,
      removed: 0,
      kept: session.turns.length,
      summary: '',
      beforeTokens,
      afterTokens: beforeTokens,
      message: `轮次不足（${session.turns.length} ≤ ${KEEP_RECENT + 1}），无需压缩`,
    };
  }

  const removed = session.turns.slice(0, session.turns.length - KEEP_RECENT);
  const kept = session.turns.slice(-KEEP_RECENT);

  // M1.3: compact 补漏提炼 — 被移除轮次若有成功信号（result.summary 含 score≥85）
  // 且同内容 hash 尚未存在（回合结束已提炼则跳过 → 防双重计数）。turn 级无
  // attemptCount 信息（申报：compact 补漏以 score≥85 为唯一信号）。
  try {
    const { RefinedMemoryStore, POSITIVE_SCORE_THRESHOLD } = await import('../../memory/RefinedMemoryStore.js');
    const store = new RefinedMemoryStore(session.workspace);
    const signals = removed
      .map((t) => {
        const m = /score=(\d+)/.exec(t.result?.summary || '');
        const score = m ? parseInt(m[1], 10) : NaN;
        return { score, turn: t };
      })
      .filter((x) => x.score >= POSITIVE_SCORE_THRESHOLD)
      .map((x) => ({ summary: `已验证可行的做法：score=${x.score}`, evidence: `score=${x.score}`, taskStyle: 'all', now: Date.now() }));
    if (signals.length > 0) store.refineCompactSignals(signals);
  } catch {
    // memory is best-effort during compaction
  }

  let summary = '';
  if (client && typeof client.complete === 'function') {
    try {
      const out = await client.complete(getStrategy(resolveStrategyId(session)).buildPrompt(removed, { instruction: undefined }));
      summary = typeof out === 'string' ? out.trim() : String(out?.content ?? '').trim();
    } catch {}
  }
  if (!summary) summary = fallbackSummary(removed);

  const synthetic: Turn = {
    id: 'compact-' + Date.now().toString(36),
    timestamp: Date.now(),
    userInput: `[COMPACT] 已压缩 ${removed.length} 轮历史`,
    userInputType: 'command',
    tier: session.tier,
    result: { success: true, summary },
  };

  session.turns = [synthetic, ...kept];
  const afterTokens = estimateSessionTokens(session);

  return {
    ok: true,
    removed: removed.length,
    kept: kept.length,
    summary,
    beforeTokens,
    afterTokens,
    message: `已压缩 ${removed.length} 轮 → 保留 ${kept.length} 轮 + 摘要；估算上下文 ${beforeTokens} → ${afterTokens} tokens`,
  };
}

/** Auto-compact trigger (CC-style): called before starting a new task. */
export function shouldAutoCompact(session: Session, ctxRatio: number): boolean {
  return ctxRatio >= 0.85 && session.turns.length > 12;
}

// ==================== P3-3.7: background pre-compaction ====================
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

  // SNAPSHOT the removed turns — later mutations (new tasks) must not race us
  const removed = session.turns.slice(0, session.turns.length - KEEP_RECENT).map((t) => ({ ...t }));
  const kept = session.turns.slice(-KEEP_RECENT).map((t) => ({ ...t }));

  let summary = '';
  if (client && typeof client.complete === 'function') {
    try {
      const out = await client.complete(getStrategy(resolveStrategyId(session)).buildPrompt(removed, { instruction: undefined }));
      summary = typeof out === 'string' ? out.trim() : String(out?.content ?? '').trim();
    } catch {}
  }
  if (!summary) summary = fallbackSummary(removed);

  // Estimates: apply into a THROWAWAY view of the snapshot so we never mutate
  const estView = { turns: [{
    id: 'compact-x', timestamp: Date.now(), userInput: `[COMPACT] 已压缩 ${removed.length} 轮历史`,
    userInputType: 'command' as const, tier: session.tier,
    result: { success: true, summary },
  } as Turn, ...kept] } as Session;
  const afterTokens = estimateSessionTokens(estView);

  return {
    ok: true,
    removed: removed.length,
    kept: kept.length,
    summary,
    beforeTokens,
    afterTokens,
    message: `后台压缩就绪：${removed.length} 轮 → 摘要；估算 ${beforeTokens} → ${afterTokens} tokens`,
  };
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
      result = {
        ok: true, removed: Math.max(0, session.turns.length - KEEP_RECENT),
        kept: Math.min(KEEP_RECENT, session.turns.length), summary: fallbackSummary(session.turns.slice(0, -KEEP_RECENT)),
        beforeTokens: estimateSessionTokens(session), afterTokens: estimateSessionTokens(session),
        message: '后台压缩（模型失败，确定性摘要）',
      };
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
 * Apply a ready background result onto the session at a task boundary
 * (synchronous, atomic replacement — same shape as compactSession).
 */
export function applyCompactResult(session: Session, res: CompactResult): CompactResult {
  if (!res || !res.ok || res.removed === 0) {
    return res ?? { ok: false, removed: 0, kept: session.turns.length, summary: '', beforeTokens: 0, afterTokens: 0, message: '无可用后台压缩结果' };
  }
  const kept = session.turns.slice(-KEEP_RECENT);
  const synthetic: Turn = {
    id: 'compact-' + Date.now().toString(36),
    timestamp: Date.now(),
    userInput: `[COMPACT] 已压缩 ${res.removed} 轮历史`,
    userInputType: 'command',
    tier: session.tier,
    result: { success: true, summary: res.summary },
  };
  session.turns = [synthetic, ...kept];
  const afterTokens = estimateSessionTokens(session);
  return { ...res, kept: kept.length, afterTokens, message: `✓ 已自动压缩 ${res.removed} 轮历史（后台）` };
}
