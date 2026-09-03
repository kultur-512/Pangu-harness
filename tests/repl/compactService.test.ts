// tests/repl/compactService.test.ts
// M2.3 DoD: 50+ turn session compacts — ctx estimate drops significantly and
// key info survives in the summary; auto-compact trigger threshold respected.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { compactSession, estimateSessionTokens, shouldAutoCompact } from '../../src/cli/repl/compactService.js';
import { Session } from '../../src/cli/repl/Session.js';
import type { Turn } from '../../src/cli/repl/types.js';

function mkTurn(i: number): Turn {
  return {
    id: 't' + i,
    timestamp: Date.now() + i,
    userInput: `任务 ${i}: 修复 alpha 模块的 bug-KEYWORD-${i} 并验证`,
    userInputType: 'task',
    tier: 'high',
    durationMs: 1000,
    result: { success: i % 5 !== 0, summary: `score=${90 - i}` },
  };
}

const fakeModelClient = {
  async complete(prompt: string) {
    // Deterministic "model" summary: keeps every KEYWORD visible so the
    // "key info preserved" assertion mirrors what a real summary should do.
    const keywords = (prompt.match(/KEYWORD-\d+/g) || []).join(', ');
    return `[摘要] 历史任务覆盖: ${keywords}`;
  },
};

describe('compactService', () => {
  let session: Session;

  beforeEach(() => {
    session = new Session({ tier: 'high', workspace: '/tmp/ws-compact' });
    for (let i = 1; i <= 56; i++) session.addTurn(mkTurn(i));
  });
  afterEach(() => {});

  it('56-turn session: compacts to 1 summary + 6 kept, estimate drops sharply', async () => {
    const before = estimateSessionTokens(session);
    const r = await compactSession(session, fakeModelClient);

    assert.ok(r.ok, r.message);
    assert.equal(r.removed, 50);
    assert.equal(r.kept, 6);
    assert.equal(session.turns.length, 7); // 1 synthetic + 6 kept
    assert.equal(session.turns[0].userInput, '[COMPACT] 已压缩 50 轮历史');

    // The 4000-char baseline is constant, so assert on the VARIABLE part:
    // compacted history must shed >50% of its non-baseline estimate.
    const baseline = 1000; // 4000 chars / 4
    const varBefore = r.beforeTokens - baseline;
    const varAfter = r.afterTokens - baseline;
    assert.ok(varAfter < varBefore * 0.5, `variable part must drop >50%: ${varBefore} → ${varAfter}`);
  });

  it('key info preserved: every compacted KEYWORD appears in the summary', async () => {
    const r = await compactSession(session, fakeModelClient);
    assert.ok(r.ok);
    for (let i = 1; i <= 50; i++) {
      assert.ok(r.summary.includes(`KEYWORD-${i}`), `KEYWORD-${i} must survive compaction`);
    }
  });

  it('model failure falls back to deterministic brief (no info loss)', async () => {
    const r = await compactSession(session, { async complete() { throw new Error('provider down'); } });
    assert.ok(r.ok);
    assert.ok(r.summary.includes('KEYWORD-1') && r.summary.includes('KEYWORD-50'));
  });

  it('refuses to compact when turns are below the threshold', async () => {
    const small = new Session();
    for (let i = 0; i < 5; i++) small.addTurn(mkTurn(i));
    const r = await compactSession(small, fakeModelClient);
    assert.equal(r.ok, false);
    assert.ok(r.message.includes('无需压缩'));
  });

  it('shouldAutoCompact: ≥85% ratio AND >12 turns', () => {
    assert.equal(shouldAutoCompact(session, 0.86), true);
    assert.equal(shouldAutoCompact(session, 0.5), false);
    const small = new Session();
    for (let i = 0; i < 5; i++) small.addTurn(mkTurn(i));
    assert.equal(shouldAutoCompact(small, 0.9), false);
  });
});

// ==================== P3-3.7: background pre-compaction ====================
import { startBackgroundCompact, applyCompactResult } from '../../src/cli/repl/compactService.js';
import { registerStrategy, getStrategy, listStrategies, turnBrief } from '../../src/cli/repl/compactStrategies.js';

// ==================== P1-T15: pluggable compaction strategies ====================
describe('compact strategies (P1-T15)', () => {
  it('built-ins registered: default + topic', () => {
    const ids = listStrategies();
    assert.ok(ids.includes('default'));
    assert.ok(ids.includes('topic'));
  });

  it('topic strategy produces sectioned output differing from default', () => {
    const turns = [
      { id: 't1', timestamp: 1, userInput: 'fix the login bug', userInputType: 'task' as const, tier: 'high' as const, durationMs: 1, result: { success: true, summary: 'score=90' } },
      { id: 't2', timestamp: 2, userInput: 'fix the login bug again', userInputType: 'task' as const, tier: 'high' as const, durationMs: 1, result: { success: true, summary: 'score=88' } },
      { id: 't3', timestamp: 3, userInput: 'add sql index', userInputType: 'task' as const, tier: 'high' as const, durationMs: 1, result: { success: true, summary: 'score=95' } },
    ] as any;
    const topic = getStrategy('topic').buildPrompt(turns);
    const def = getStrategy('default').buildPrompt(turns);
    assert.ok(topic.includes('## '), 'topic clusters into sections');
    assert.ok(topic.includes('fix') && topic.includes('sql'));
    assert.notEqual(topic, def);
  });

  it('custom strategy registers and resolves; unknown falls back to default', () => {
    registerStrategy({ id: 'custom', buildPrompt: () => 'CUSTOM-SUMMARY-PROMPT' });
    assert.equal(getStrategy('custom').buildPrompt([]), 'CUSTOM-SUMMARY-PROMPT');
    assert.equal(getStrategy('nope').id, 'default');
  });

  it('turnBrief keeps the existing brief format', () => {
    const t = { id: 'x', timestamp: 1, userInput: 'hello world task', userInputType: 'task', tier: 'high', durationMs: 1, result: { success: true, summary: 'score=88' } } as any;
    const b = turnBrief(t);
    assert.ok(b.includes('hello world task'));
    assert.ok(b.includes('score=88'));
  });
});
describe('background compact (P3-3.7)', () => {
  let session: Session;
  beforeEach(() => {
    session = new Session({ tier: 'high', workspace: '/tmp/ws-bg' });
    for (let i = 1; i <= 24; i++) session.addTurn(mkTurn(i));
  });

  it('below-threshold session → null (no background work)', () => {
    const small = new Session();
    for (let i = 0; i < 5; i++) small.addTurn(mkTurn(i));
    const h = startBackgroundCompact(small, fakeModelClient);
    assert.equal(h, null);
  });

  it('re-entrancy: second start for the same session → null', () => {
    const h1 = startBackgroundCompact(session, fakeModelClient);
    assert.ok(h1, 'first start should succeed');
    const h2 = startBackgroundCompact(session, fakeModelClient);
    assert.equal(h2, null, 'second simultaneous start must be rejected');
    h1!.cancel();
  });

  it('background does NOT mutate session.turns; apply() at boundary is atomic', async () => {
    const beforeCount = session.turns.length;
    const h = startBackgroundCompact(session, fakeModelClient)!;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.isReady(), true, 'with a fast fake client, compaction latches within a tick');
    assert.equal(session.turns.length, beforeCount, 'background must not mutate session');
    const res = h.result();
    assert.ok(res && res.ok);
    const applied = applyCompactResult(session, res);
    assert.equal(session.turns.length, 7, '1 synthetic + 6 kept after apply');
    for (let i = 1; i <= 18; i++) assert.ok(applied.summary.includes(`KEYWORD-${i}`), `KEYWORD-${i} preserved`);
  });

  it('client failure → deterministic fallback summary, still ready', async () => {
    const h = startBackgroundCompact(session, { async complete() { throw new Error('down'); } })!;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.isReady(), true);
    const res = h.result();
    assert.ok(res && res.ok, 'fallback still produces a ready result');
    assert.ok(res.summary.includes('KEYWORD-1'), 'first removed turn survives in fallback');
    assert.ok(res.summary.includes('KEYWORD-18'), 'last removed turn (of 18) survives in fallback');
  });

  it('cancel() clears the re-entrancy guard', () => {
    const h1 = startBackgroundCompact(session, fakeModelClient);
    assert.ok(h1);
    h1!.cancel();
    const h2 = startBackgroundCompact(session, fakeModelClient);
    assert.ok(h2, 'after cancel, a new background run is allowed');
    h2!.cancel();
  });

  it('cancel prevents an in-flight result from latching as ready', async () => {
    const slow = { async complete() { await new Promise((r) => setTimeout(r, 200)); return '[摘要] KEYWORD-1'; } };
    const h = startBackgroundCompact(session, slow as any)!;
    h.cancel();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(h.isReady(), false, 'cancelled handle must not latch ready');
  });
});
