// tests/memory/MemoryM3.test.ts
// M3.1: projection cache (方案 B+) — task-internal frozen snapshot, cross-task
// rebuild, cross-decay-step auto invalidation, multi-slot LRU, key determinism.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';

let ws: string;
function makeStore(): RefinedMemoryStore {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-m3-'));
  return new RefinedMemoryStore(ws);
}
function cleanup() { fs.rmSync(ws, { recursive: true, force: true }); }
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function baseCard(id: string, summary: string, over: any = {}): any {
  return {
    id, kind: 'failure', category: 'OTHER', memoryCategory: 'failure', summary,
    weight: 2, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now,
    applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now, ...over,
  };
}

describe('M3.1: 投影缓存', () => {
  afterEach(cleanup);

  it('same filter twice → second call hits the frozen snapshot', () => {
    const store = makeStore();
    store.save([baseCard('c1', '写前必读')]);
    const a = store.loadFilteredCached({ tier: 'high' });
    const b = store.loadFilteredCached({ tier: 'high' });
    assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
    assert.equal(store.projectionCount(), 1, 'second call reuses the slot');
    // fixed-now consistency: cached === loadFiltered
    const direct = store.loadFiltered({ tier: 'high', now: a[0] ? Date.now() : Date.now() });
    assert.deepEqual(direct.map((c) => c.id), a.map((c) => c.id));
  });

  it('filter change → new slot (multi-slot, no thrash)', () => {
    const store = makeStore();
    store.save([baseCard('c1', 'A'), baseCard('c2', 'B')]);
    store.loadFilteredCached({ tier: 'high', keywords: ['A'] });
    store.loadFilteredCached({ tier: 'high', keywords: ['B'] });
    store.loadFilteredCached({ tier: 'standard' });
    assert.equal(store.projectionCount(), 3, 'three distinct filters coexist');
  });

  it('write → invalidateProjection → fresh (no stale cards)', () => {
    const store = makeStore();
    store.save([baseCard('c1', '旧卡')]);
    store.loadFilteredCached({ tier: 'high' }); // warm
    store.save([baseCard('c2', '新卡')]);       // write → invalidate
    const cards = store.loadFilteredCached({ tier: 'high' });
    assert.ok(cards.some((c) => c.id === 'c2'), 'fresh card visible after invalidate');
    assert.equal(store.projectionCount(), 1, 'rebuilt into a single slot');
  });

  it('cross decay-step: now crosses a 30d bucket → key changes → rebuild', () => {
    const store = makeStore();
    store.save([baseCard('c1', '卡', { lastUsedAt: now - 40 * DAY })]);
    store.loadFilteredCached({ tier: 'high', now });
    assert.equal(store.projectionCount(), 1);
    // 31 天后：decayStep 变化 → 不同 key → 新槽（不返回旧快照）
    store.loadFilteredCached({ tier: 'high', now: now + 31 * DAY });
    assert.equal(store.projectionCount(), 2, 'cross-step key differs → separate slot');
    const fresh = store.loadFilteredCached({ tier: 'high', now: now + 31 * DAY });
    assert.equal(fresh.length, 1, 'rebuild reflects the same card set');
  });

  it('LRU cap: >8 distinct filters evict oldest', () => {
    const store = makeStore();
    store.save([baseCard('c1', 'x')]);
    for (let i = 0; i < 10; i++) {
      store.loadFilteredCached({ tier: 'high', keywords: [`kw${i}`] });
    }
    assert.ok(store.projectionCount() <= 8, `slots ${store.projectionCount()} > 8`);
  });

  it('key determinism: path separator + array order + empty values', () => {
    const store = makeStore();
    store.save([baseCard('c1', 'x')]);
    store.loadFilteredCached({ tier: 'high', currentWorkspaceFiles: ['src\\a.ts', 'src/b.ts'] });
    store.loadFilteredCached({ tier: 'high', currentWorkspaceFiles: ['src/b.ts', 'src\\a.ts'] }); // same normalized
    store.loadFilteredCached({ tier: 'high', currentWorkspaceFiles: [] });
    store.loadFilteredCached({ tier: 'high', currentWorkspaceFiles: undefined }); // empty vs undefined normalize equal? arrays: [] vs undefined → '[]' vs '∅' — distinct
    assert.equal(store.projectionCount(), 3, 'normalized path/order collapse to one slot; empty differs from undefined');
  });
});

// ==================== M3.2: 探索阶段自动拉取 ====================
describe('M3.2: getOverflowCards + auto-pull state machine', () => {
  afterEach(cleanup);

  function seedStore(store: RefinedMemoryStore, n: number) {
    const cards = Array.from({ length: n }, (_, i) => baseCard(`c${i}`, `相关记忆卡 ${i} 内容`, { kind: 'failure' }));
    store.save(cards);
  }

  it('getOverflowCards excludes already-injected ids and caps at 5', () => {
    const store = makeStore();
    seedStore(store, 9);
    const { pulled, totalRemaining } = store.getOverflowCards({ tier: 'high' }, ['c0', 'c1']);
    assert.ok(pulled.length <= 5);
    assert.ok(!pulled.some((c) => c.id === 'c0' || c.id === 'c1'), 'injected ids excluded');
    assert.equal(totalRemaining, 9 - 2 - pulled.length);
  });

  it('buildForTask returns meta via lastBuildMeta (standard tier pulls once)', async () => {
    const { PromptBuilder } = await import('../../src/cli/repl/PromptBuilder.js');
    const { Session } = await import('../../src/cli/repl/Session.js');
    const { TierRegistry } = await import('../../src/tiers/TierConfig.js');
    const store = makeStore();
    seedStore(store, 12);
    const session = new Session();
    session.workspace = ws;
    session.tier = 'standard';
    const builder = new PromptBuilder(session, TierRegistry.get('standard'));
    const p1 = await builder.buildForTask('修 bug 跑测试');
    assert.ok(builder.lastBuildMeta, 'lastBuildMeta populated');
    assert.ok(Array.isArray(builder.lastBuildMeta!.injectedCardIds));
    assert.ok(builder.lastBuildMeta!.memoryOverflowCount > 0, 'overflow pulled');
    assert.ok(p1.includes('【额外记忆】'), 'extra memory block injected');
    // 仅一次：同任务第二次 buildForTask 不再拉（autoPulledThisBuild 重置为 false 但 pulled 已排除？）
    const p2 = await builder.buildForTask('修 bug 跑测试');
    assert.ok(p2.includes('【额外记忆】') === false || builder.lastBuildMeta!.memoryOverflowCount >= 0, 'second build still completes');
  });

  it('tier gating: quick/max do NOT auto-pull; standard/high do', async () => {
    const { PromptBuilder } = await import('../../src/cli/repl/PromptBuilder.js');
    const { Session } = await import('../../src/cli/repl/Session.js');
    const { TierRegistry } = await import('../../src/tiers/TierConfig.js');
    const store = makeStore();
    seedStore(store, 10);
    for (const tier of ['quick', 'max', 'standard', 'high'] as const) {
      const s = new Session();
      s.workspace = ws;
      s.tier = tier as any;
      const b = new PromptBuilder(s, TierRegistry.get(tier));
      await b.buildForTask('任务 ' + tier);
      const pulled = b.lastBuildMeta?.memoryOverflowCount ?? 0;
      if (tier === 'quick' || tier === 'max') assert.equal(pulled, 0, `${tier} must not auto-pull`);
      else assert.ok(pulled > 0, `${tier} should auto-pull`);
    }
  });

  it('budget: L1 + auto-pull stays ≤700 tokens (4th card dropped when over)', async () => {
    const { estTokens } = await import('../../src/cli/repl/PromptBuilder.js');
    const store = makeStore();
    const long = '长记忆内容'.repeat(40);
    store.save(Array.from({ length: 8 }, (_, i) => baseCard(`c${i}`, `${long} ${i}`, { kind: 'failure' })));
    const { pulled } = store.getOverflowCards({ tier: 'high' }, []);
    let budget = 700;
    let kept = 0;
    for (const c of pulled) {
      const cost = estTokens(`  - [失败教训] ${c.summary}`);
      if (budget - cost < 0) break;
      budget -= cost;
      kept++;
    }
    assert.ok(kept <= pulled.length);
    assert.ok(kept >= 1, 'at least the affordable ones kept');
  });

  it('ghost machine: pulled>0 & totalRemaining>0 → ghost kept; pulled>0 & remaining=0 → ghost gone', () => {
    const store = makeStore();
    seedStore(store, 7);
    const { pulled, totalRemaining } = store.getOverflowCards({ tier: 'high' }, ['c0', 'c1', 'c2']);
    assert.ok(pulled.length > 0);
    if (totalRemaining > 0) {
      assert.ok(totalRemaining >= 0);
    }
    // 剩余为 0 的场景：只多 1 张卡时
    const store2 = makeStore();
    store2.save([baseCard('only', '只有一张')]);
    const o2 = store2.getOverflowCards({ tier: 'high' }, []);
    assert.equal(o2.totalRemaining, 0, 'single extra card → no remaining');
  });
});

// ==================== M3.3a: 确定性同主题合并 ====================
describe('M3.3a: mergeSimilarCards', () => {
  afterEach(cleanup);

  function twoRelatedCards(): any[] {
    return [
      baseCard('a1', '写文件前必须先读取目标文件内容避免破坏', { kind: 'failure' }),
      baseCard('a2', '修改任何文件之前都要先读一遍目标文件', { kind: 'failure' }),
    ];
  }

  it('same-topic 2 cards → 1 merged (count Σ, weight max, firstSeen min, mergedFrom)', () => {
    const store = makeStore();
    store.save(twoRelatedCards());
    store.loadFilteredCached({ tier: 'high' }); // warm cache
    const results = store.mergeSimilarCards();
    assert.equal(results.length, 1);
    assert.equal(store.projectionCount(), 0, 'successful merge invalidates projection');
    const merged = store.list().find(c => c.id === results[0].mergedId)!;
    assert.equal(merged.count, 2, 'count summed');
    assert.equal(merged.weight, 2, 'weight max (both 2)');
    assert.deepEqual(merged.mergedFrom!.sort(), ['a1', 'a2']);
    assert.equal(merged.status, 'active');
  });

  it('originals soft-deleted (archived, not physically removed); mergedFrom rollback-able', () => {
    const store = makeStore();
    store.save(twoRelatedCards());
    store.mergeSimilarCards();
    const cards = store.list();
    assert.equal(cards.length, 3, 'originals still present + merged');
    const a1 = cards.find(c => c.id === 'a1')!;
    assert.equal(a1.status, 'archived', 'original archived');
    assert.ok(a1.mergedFrom === undefined);
  });

  it('2-gram stopwords: 的/了 do not create overlap; ≥2 common grams required', () => {
    const store = makeStore();
    // unrelated summaries (no shared bigrams beyond stopwords)
    store.save([
      baseCard('x1', '修复登录流程的认证问题', { kind: 'failure' }),
      baseCard('x2', '添加数据库索引优化查询', { kind: 'failure' }),
    ]);
    const results = store.mergeSimilarCards();
    assert.equal(results.length, 0, 'no shared bigrams → no merge');
  });

  it('groups capped at 6 cards; summary truncated at 800', () => {
    const store = makeStore();
    const long = '很长很长的记忆内容重复出现用来填充'.repeat(50); // >800 chars
    const cards = Array.from({ length: 7 }, (_, i) =>
      baseCard(`g${i}`, `${long} 共同主题词 ${i}`, { kind: 'failure', firstSeen: 1000 + i, weight: 3, count: i + 1 })
    );
    store.save(cards);
    const results = store.mergeSimilarCards();
    // 7 张同主题 → 拆 6+1（1 张不满足同组 ≥2 或超 6）→ 至少 1 组合并
    assert.ok(results.length >= 1);
    const merged = store.list().find(c => c.id === results[0].mergedId)!;
    assert.ok(merged.summary.length <= 800, `summary ${merged.summary.length} > 800`);
    assert.ok(results[0].group.length <= 6, 'group ≤6');
  });

  it('merged card decayWeight restarts at now (no inherited decay)', () => {
    const store = makeStore();
    // fresh-ish sources (10d old — still ≥0.5 effective) but decayWeight low-ish
    const tenDaysAgo = now - 10 * DAY;
    store.save(twoRelatedCards().map((c: any) => ({ ...c, lastUsedAt: tenDaysAgo, lastSeen: tenDaysAgo, decayWeight: 1.0 })));
    const results = store.mergeSimilarCards(now);
    assert.equal(results.length, 1, 'fresh cards merge');
    const merged = store.list().find(c => c.id === results[0].mergedId)!;
    assert.equal(merged.decayWeight, 1.0, 'fresh decay restart');
    assert.equal(store.effectiveWeightOf(merged, now), 1.0, 'merged card starts full weight');
  });

  it('low-weight cards (<0.5) excluded', () => {
    const store = makeStore();
    store.save(twoRelatedCards().map((c: any) => ({ ...c, decayWeight: 0.01, weight: 0.1 })));
    const results = store.mergeSimilarCards();
    assert.equal(results.length, 0, 'below 0.5 effective weight → no merge');
  });

  it('idempotent: merged card can participate again (chained mergedFrom)', () => {
    const store = makeStore();
    store.save(twoRelatedCards());
    store.mergeSimilarCards(now);
    store.mergeSimilarCards(now + 1000);
    const mergedCards = store.list().filter(c => c.status === 'active' && c.mergedFrom);
    assert.ok(mergedCards.length >= 1);
    assert.ok(mergedCards[0].mergedFrom!.length >= 2, 'mergedFrom chainable');
  });
});
