// tests/repl/usageService.test.ts
// M2.4 DoD: /usage numbers stay in the same magnitude as the engine's budget
// report; prices (when configured) drive a local cost estimate; no secrets.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { collectUsage } from '../../src/cli/repl/usageService.js';
import { Session } from '../../src/cli/repl/Session.js';
import type { Turn, BudgetReport } from '../../src/cli/repl/types.js';

function mkTurn(i: number, estimatedUsedTokens: number): Turn {
  const budgetReport: BudgetReport = {
    budgetTokens: 120000,
    estimatedUsedTokens,
    usageRatio: Math.min(1, estimatedUsedTokens / 120000),
    triggeredSoftLimit: false,
    triggeredDegradation: false,
    rolloutsExecuted: 1,
    stepsExecuted: 3,
    notes: [],
  } as any;
  return {
    id: 't' + i,
    timestamp: Date.now() + i,
    userInput: `task ${i} with some reasonably long description text for token estimation purposes`,
    userInputType: 'task',
    tier: 'high',
    durationMs: 1500,
    result: { success: true, summary: `score=${90 - i}`, budgetReport },
  };
}

describe('usageService', () => {
  let session: Session;
  beforeEach(() => {
    session = new Session({ tier: 'high', workspace: '/tmp/ws-usage' });
    // 8 turns with budget reports around 1200-2400 tokens each
    for (let i = 1; i <= 8; i++) session.addTurn(mkTurn(i, 1200 + i * 150));
  });

  it('session tokens accumulate from budget reports', () => {
    const r = collectUsage(session);
    const expected = [1, 2, 3, 4, 5, 6, 7, 8].reduce((s, i) => s + 1200 + i * 150, 0);
    assert.equal(r.sessionTokens, expected);
    assert.equal(r.turns, 8);
  });

  it('last-turn magnitude matches the engine budget report (same order)', () => {
    const r = collectUsage(session);
    // last turn estimated 1200+8*150 = 2400 → same magnitude as context estimate
    assert.equal(r.lastTurnEstimatedTokens, 2400);
    const ratio = r.contextTokens / r.lastTurnEstimatedTokens;
    assert.ok(ratio > 0.2 && ratio < 20, `context ${r.contextTokens} vs lastTurn ${r.lastTurnEstimatedTokens} — magnitudes must be comparable (ratio=${ratio.toFixed(2)})`);
  });

  it('cost estimate: 0 + hint without prices; positive with prices', () => {
    const noPrice = collectUsage(session);
    assert.equal(noPrice.priceConfigured, false);
    assert.equal(noPrice.costUsd, 0);
    assert.ok(noPrice.lines.some((l) => l.includes('usagePrices')));

    const priced = collectUsage(session, { inputPerMTokens: 1, outputPerMTokens: 4, currency: 'USD' });
    assert.equal(priced.priceConfigured, true);
    assert.ok(priced.costUsd > 0);
    // sanity: mirror the 70/30 estimator over the accumulated total (15000 tokens)
    const total = priced.sessionTokens;
    const expected = (total * 0.7 / 1e6) * 1 + (total * 0.3 / 1e6) * 4;
    assert.ok(Math.abs(priced.costUsd - expected) < 1e-9);
  });

  it('usage lines are human-readable and include the budget report line', () => {
    const r = collectUsage(session, { inputPerMTokens: 1, outputPerMTokens: 4 });
    assert.ok(r.lines.some((l) => l.includes('最近一轮')));
    assert.ok(r.lines.some((l) => l.includes('usageRatio=2%')));
  });
});
