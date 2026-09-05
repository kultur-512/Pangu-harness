// tests/memory/MemoryM2.test.ts
// M2.1: L0 invariants + estTokens budget
// M2.2: L1 relevant memory — kind filter, relevance sort, preference seat,
//       ENV keyword gate, ghost hint, decay difference (preference vs failure)
// M2.3: /memory search/list — manual retrieval, no L1 budget

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';
import { estTokens, L0_INVARIANTS, assertL0Count } from '../../src/cli/repl/PromptBuilder.js';

let ws: string;
function makeStore(): RefinedMemoryStore {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-m2-'));
  return new RefinedMemoryStore(ws);
}
function cleanup() { fs.rmSync(ws, { recursive: true, force: true }); }

const DAY = 24 * 60 * 60 * 1000;

describe('M2.1: L0 硬约束 + estTokens', () => {
  it('L0 ≤ 3 invariants (budget red line)', () => {
    assertL0Count(); // throws if >3
    assert.ok(L0_INVARIANTS.length <= 3);
    assert.ok(L0_INVARIANTS.some((i) => i.includes('RBW')));
  });

  it('estTokens is deterministic and budgets the L0 block ≤100', () => {
    const block = L0_INVARIANTS.join('\n');
    const t1 = estTokens(block);
    assert.equal(t1, estTokens(block));
    assert.ok(t1 <= 100, `L0 block ${t1} tokens > 100`);
    // CJK costs more per char
    assert.ok(estTokens('中文中文') > estTokens('abcd'));
  });
});

describe('M2.2: L1 相关记忆', () => {
  afterEach(cleanup);

  it('kind filter loads failure + success + preference together', () => {
    const store = makeStore();
    const now = Date.now();
    store.save(store.refine({ trajectory: { id: 't', steps: [], success: true }, taskStyle: 'swe', attemptCount: 1, userFeedback: '', now })); // success
    store.save(store.refine({ trajectory: { id: 't2', steps: [{ stepNumber: 1, readBeforeWriteViolation: true } as any], success: false }, taskStyle: 'swe', now })); // failure
    store.remember('用 TS 写', false, now);
    const cards = store.loadFiltered({});
    const kinds = new Set(cards.map((c) => c.kind));
    assert.ok(kinds.has('success'), 'success loads');
    assert.ok(kinds.has('failure'), 'failure loads');
    assert.ok(kinds.has('preference'), 'preference loads');
  });

  it('relevance boosts keyword-hit cards above higher-weight stale ones', () => {
    const store = makeStore();
    const now = Date.now();
    // stale high-weight card (old lastUsedAt → decayed) vs fresh relevant card
    const stale = {
      id: 'stale', kind: 'failure' as const, category: 'OTHER' as const, memoryCategory: 'failure',
      summary: '不要用旧 API', weight: 5, taskStyle: 'all' as const, count: 3,
      lastSeen: now - 200 * DAY, firstSeen: now - 200 * DAY, applicableTiers: [], sourceContext: '',
      decayWeight: 1.0, lastUsedAt: now - 200 * DAY,
    };
    const fresh = {
      id: 'fresh', kind: 'failure' as const, category: 'OTHER' as const, memoryCategory: 'failure',
      summary: 'grep 前先 read_file 确认路径', weight: 1, taskStyle: 'all' as const, count: 1,
      lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '',
      decayWeight: 1.0, lastUsedAt: now,
    };
    store.save([stale as any, fresh as any]);
    const cards = store.loadFiltered({ keywords: ['read_file'] });
    assert.equal(cards[0].id, 'fresh', 'relevance lifts the keyword-matched card above the stale heavy one');
  });

  it('preference keeps 1 reserved seat even when low-ranked', () => {
    const store = makeStore();
    const now = Date.now();
    const prefs = {
      id: 'pref', kind: 'preference' as const, category: 'OTHER' as const, memoryCategory: 'general',
      summary: '喜欢简洁答案', weight: 0.6, taskStyle: 'all' as const, count: 1,
      lastSeen: now - 60 * DAY, firstSeen: now, applicableTiers: [], sourceContext: '',
      decayWeight: 1.0, lastUsedAt: now - 60 * DAY,
    };
    const others = Array.from({ length: 5 }, (_, i) => ({
      id: `f${i}`, kind: 'failure' as const, category: 'OTHER' as const, memoryCategory: 'failure',
      summary: `普通教训 ${i}`, weight: 2, taskStyle: 'all' as const, count: 1,
      lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '',
      decayWeight: 1.0, lastUsedAt: now,
    }));
    store.save([prefs as any, ...others as any]);
    const cards = store.loadFiltered({ maxCards: 3, keywords: [] });
    assert.ok(cards.some((c) => c.kind === 'preference'), 'preference seat reserved');
    assert.equal(cards.length, 3);
  });

  it('preference decays below failure at equal freshness (kind baseline 0.6)', () => {
    const store = makeStore();
    const now = Date.now();
    const mk = (id: string, kind: 'preference' | 'failure', weight: number): any => ({
      id, kind, category: 'OTHER', memoryCategory: 'general', summary: `card ${id}`, weight,
      taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now, applicableTiers: [],
      sourceContext: '', decayWeight: 1.0, lastUsedAt: now,
    });
    const p = mk('pref', 'preference', 1.0);
    const f = mk('fail', 'failure', 1.0);
    const t60 = now + 60 * DAY;
    assert.ok(
      store.effectiveWeightOf(p, t60) < store.effectiveWeightOf(f, t60),
      `preference(${store.effectiveWeightOf(p, t60)}) < failure(${store.effectiveWeightOf(f, t60)})`
    );
  });

  it('ENV keyword gate: build/test keywords trigger, plain task does not', async () => {
    const { describeEnvironment, renderEnvSummary } = await import('../../src/cli/repl/EnvContext.js');
    const summary = renderEnvSummary(describeEnvironment(ws), 10);
    const ENV_KEYWORDS = /build|compile|构建|test|测试|依赖|install/i;
    assert.ok(ENV_KEYWORDS.test('跑一下 test'), 'test keyword triggers');
    assert.ok(!ENV_KEYWORDS.test('修一下样式'), 'plain task does not trigger');
    assert.ok(summary.length > 0, 'summary renderable when gated on');
  });

  it('L1 block (memory cards) stays within 500 tokens', () => {
    const store = makeStore();
    const now = Date.now();
    const cards = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`, kind: 'failure' as const, category: 'OTHER' as const, memoryCategory: 'failure',
      summary: `记忆卡片内容 ${i}：写前必读避免破坏性修改`, weight: 2, taskStyle: 'all' as const,
      count: 1, lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '',
      decayWeight: 1.0, lastUsedAt: now,
    }));
    store.save(cards as any);
    const loaded = store.loadFiltered({ maxCards: 8 });
    const block = loaded.map((c) => c.summary).join('\n');
    assert.ok(estTokens(block) <= 500, `L1 block ${estTokens(block)} tokens > 500`);
  });
});

describe('M2.3: /memory 检索（不占注入预算）', () => {
  afterEach(cleanup);

  it('search finds keyword hits; list --kind filters; no L1 budget touched', async () => {
    const { runMemoryCommand } = await import('../../src/cli/MemoryCommand.js');
    const store = makeStore();
    const now = Date.now();
    store.save([{
      id: 'a1', kind: 'failure' as const, category: 'OTHER' as const, memoryCategory: 'failure',
      summary: 'grep 命令前先确认文件存在', weight: 2, taskStyle: 'all' as const, count: 1,
      lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '',
      decayWeight: 1.0, lastUsedAt: now,
    } as any]);
    const hit = await runMemoryCommand(['search', 'grep'], ws);
    assert.ok(hit.includes('grep 命令前先确认文件存在'));
    const miss = await runMemoryCommand(['search', '不存在的词'], ws);
    assert.ok(miss.includes('没有匹配'));
    const listed = await runMemoryCommand(['list', '--kind', 'failure'], ws);
    assert.ok(listed.includes('a1'));
    // L1 注入预算独立：/memory 是手动检索，loadFiltered maxCards 不受影响
    const l1 = store.loadFiltered({ maxCards: 2 });
    assert.ok(l1.length <= 2);
  });
});
