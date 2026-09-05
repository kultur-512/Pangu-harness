// tests/memory/RefinedMemoryStore.test.ts
// P1-C (v2): Memory category layering + step decay tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RefinedMemoryStore } from '../../src/memory/RefinedMemoryStore.js';
import { RefinedMemoryCard } from '../../src/memory/RefinedMemoryCard.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTempWorkspace(): string {
  const dir = join(tmpdir(), 'pangu-mem-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function makeCard(overrides: Partial<RefinedMemoryCard> = {}): RefinedMemoryCard {
  const now = Date.now();
  return {
    id: 'card-' + Math.random().toString(36).slice(2),
    category: 'OTHER',
    memoryCategory: 'general',
    summary: 'test',
    weight: 2,
    taskStyle: 'all',
    count: 1,
    lastSeen: now,
    firstSeen: now,
    applicableTiers: [],
    sourceContext: '',
    decayWeight: 1.0,
    lastUsedAt: now,
    ...overrides,
  } as RefinedMemoryCard;
}

describe('P1-C Memory Category + Step Decay (v2)', () => {
  let tmp: string;
  let store: RefinedMemoryStore;

  beforeEach(() => {
    tmp = makeTempWorkspace();
    store = new RefinedMemoryStore(tmp);
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it('quick tier sees ONLY failure cards (implementation/insight blocked; architecture always visible per test below)', () => {
    // M2.5 aligned with implementation semantics (loadFiltered.isVisible):
    // architecture is ALWAYS visible (test 2), quick blocks everything else
    // except failure.
    const arch = makeCard({ memoryCategory: 'architecture', summary: '架构决策' });
    const impl = makeCard({ memoryCategory: 'implementation', summary: '实现细节' });
    const fail = makeCard({ memoryCategory: 'failure', summary: '失败教训' });
    store.save([arch, impl, fail]);

    const quick = store.loadFiltered({ tier: 'quick' });
    const mc = (c: any) => c.memoryCategory || 'general';
    assert.ok(quick.some(c => mc(c) === 'architecture'), 'architecture always visible');
    assert.ok(quick.some(c => mc(c) === 'failure'), 'quick should see failure');
    assert.ok(!quick.some(c => mc(c) === 'implementation'), 'quick must not see implementation');
  });

  it('architecture is ALWAYS visible even for quick', () => {
    const arch = makeCard({ memoryCategory: 'architecture', summary: '核心架构' });
    store.save([arch]);

    // even for quick, architecture must be visible
    const quick = store.loadFiltered({ tier: 'quick' });
    assert.ok(quick.some(c => (c.memoryCategory || 'general') === 'architecture'));
  });

  it('step decay 4 segments are correct (using implementation halfLife=180)', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const HL = 180; // implementation

    // 接口契约 v3：衰减锚 = max(lastSeen, lastUsedAt)（修复 ?? 短路导致复发卡不保鲜）。
    // 分段测试场景 = 卡自该龄期后未被触碰/未再复发 → 两时间戳同置。
    const cardBase = makeCard({
      memoryCategory: 'implementation',
      lastSeen: now,
      lastUsedAt: now,
      decayWeight: 1.0,
      weight: 2,
    });

    // segment 1: age < 0.5 HL → ×1.0
    const c1 = { ...cardBase, lastSeen: now - (HL * 0.4 * day), lastUsedAt: now - (HL * 0.4 * day) };
    // segment 2: 0.5 HL ~ 1.0 HL → ×0.7
    const c2 = { ...cardBase, lastSeen: now - (HL * 0.7 * day), lastUsedAt: now - (HL * 0.7 * day) };
    // segment 3: 1.0 HL ~ 2.0 HL → ×0.4
    const c3 = { ...cardBase, lastSeen: now - (HL * 1.5 * day), lastUsedAt: now - (HL * 1.5 * day) };
    // segment 4: > 2.0 HL → ×0.1
    const c4 = { ...cardBase, lastSeen: now - (HL * 2.1 * day), lastUsedAt: now - (HL * 2.1 * day) };

    // M2.5: decay math is verified through the public effectiveWeightOf —
    // loadFiltered is a pure read (no hit-refresh) and applies a >=0.3
    // injection cutoff, so segment values are asserted directly.
    const e1 = store.effectiveWeightOf(c1, now);
    const e2 = store.effectiveWeightOf(c2, now);
    const e3 = store.effectiveWeightOf(c3, now);
    const e4 = store.effectiveWeightOf(c4, now);

    assert.ok(Math.abs(e1 - 1.0) < 0.05, `segment1 should be ~1.0, got ${e1}`);
    assert.ok(Math.abs(e2 - 0.7) < 0.05, `segment2 should be ~0.7, got ${e2}`);
    assert.ok(Math.abs(e3 - 0.4) < 0.05, `segment3 should be ~0.4, got ${e3}`);
    assert.ok(Math.abs(e4 - 0.1) < 0.05, `segment4 should be ~0.1, got ${e4}`);
  });

  it('implementation cards older than 2*halfLife (360 days) drop to <= 10% effective weight', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const HL_impl = 180;
    const ageDays = HL_impl * 2 + 10; // > 360 days

    const oldImpl = makeCard({
      memoryCategory: 'implementation',
      lastSeen: now - ageDays * day, // v3：衰减锚取 max(lastSeen, lastUsedAt)，两者同置
      lastUsedAt: now - ageDays * day,
      decayWeight: 3.5, // M2.5: effective base is decayWeight → 0.1×3.5=0.35 survives the 0.3 cutoff
      weight: 5,
    });

    store.save([oldImpl]);

    // decayWeight=3.5 → effective 0.35 >= 0.3 cutoff → card SURVIVES injection,
    // but its effective factor is now exactly 10% of base.
    const loaded = store.loadFiltered({ now, tier: 'high' });
    const c = loaded[0] as any;
    assert.ok(c, 'decayWeight=3.5 card must survive the 0.3 cutoff');
    const factor = store.effectiveWeightOf(c, now) / (c.decayWeight ?? 1);
    assert.ok(factor <= 0.11, `effective weight factor must be <= 10% after 2*HL, got ${factor}`);

    // base weight=1 would fall under the cutoff and be dropped entirely
    const low = makeCard({ memoryCategory: 'implementation', lastSeen: now - ageDays * day, lastUsedAt: now - ageDays * day, decayWeight: 1.0, weight: 1 });
    store.save([low]);
    const loaded2 = store.loadFiltered({ now, tier: 'high' });
    assert.ok(!loaded2.some(x => x.id === low.id), 'decayWeight=1 card at >2*HL must be filtered (<0.3)');
  });

  it('old .panshalach-memory.json without memoryCategory still loads (defaults to general)', () => {
    // write a raw old-format file directly
    const oldFile = {
      meta: { version: '0.9', lastUpdated: Date.now(), totalCards: 1 },
      cards: [
        {
          id: 'old1',
          category: 'OTHER',
          // no memoryCategory
          summary: '老卡片',
          weight: 3,
          taskStyle: 'all',
          count: 2,
          lastSeen: Date.now() - 1000,
          firstSeen: Date.now() - 10000,
          applicableTiers: [],
          sourceContext: 'legacy',
        },
      ],
    };

    const path = join(tmp, '.panshalach-memory.json');
    writeFileSync(path, JSON.stringify(oldFile, null, 2), 'utf-8');

    // reload store
    const fresh = new RefinedMemoryStore(tmp);
    const cards = fresh.loadFiltered();

    assert.equal(cards.length, 1);
    // defaulted to general
    assert.equal((cards[0] as any).memoryCategory || 'general', 'general');
  });
});

// ==================== M1.1: Positive Memory（触发收紧：写盘≠成功） ====================
import { POSITIVE_FEEDBACK_RE } from '../../src/memory/RefinedMemoryStore.js';

function fakeTraj(success: boolean): any {
  return { id: 't', steps: [], success };
}

describe('Positive Memory (M1.1)', () => {
  it('write-success-but-retry (attemptCount>1) + positive feedback → NO refine', () => {
    const store = new RefinedMemoryStore(makeTempWorkspace());
    const cards = store.refine({ trajectory: fakeTraj(true), taskStyle: 'swe', attemptCount: 2, userFeedback: '很好' });
    assert.equal(cards.filter(c => c.kind === 'success').length, 0);
  });

  it('attemptCount===1 + positive feedback → success card', () => {
    const store = new RefinedMemoryStore(makeTempWorkspace());
    const cards = store.refine({ trajectory: fakeTraj(false), taskStyle: 'swe', attemptCount: 1, userFeedback: '很不错，一次通过' });
    const success = cards.filter(c => c.kind === 'success');
    assert.equal(success.length, 1);
    assert.equal(success[0].memoryCategory, 'implementation');
    assert.ok(success[0].summary.includes('已验证可行的做法'));
  });

  it('attemptCount===1 + negative feedback → NO refine', () => {
    const store = new RefinedMemoryStore(makeTempWorkspace());
    const cards = store.refine({ trajectory: fakeTraj(false), taskStyle: 'swe', attemptCount: 1, userFeedback: '不行，重做' });
    assert.equal(cards.filter(c => c.kind === 'success').length, 0);
  });

  it('attemptCount===1 + no feedback + 未验证成功 → NO refine', () => {
    const store = new RefinedMemoryStore(makeTempWorkspace());
    const cards = store.refine({ trajectory: fakeTraj(false), taskStyle: 'swe', attemptCount: 1, userFeedback: '' });
    assert.equal(cards.filter(c => c.kind === 'success').length, 0);
  });

  it('attemptCount===1 + no feedback + 真实验证通过（stopReason=completed）→ refine', () => {
    const store = new RefinedMemoryStore(makeTempWorkspace());
    const traj = { ...fakeTraj(true), stopReason: 'completed' as const };
    const cards = store.refine({ trajectory: traj, taskStyle: 'swe', attemptCount: 1, userFeedback: '' });
    assert.equal(cards.filter(c => c.kind === 'success').length, 1);
  });

  it('0.7：answered（纯问答自然停）不产生 success 卡——success=true 也不行，必须 completed', () => {
    const store = new RefinedMemoryStore(makeTempWorkspace());
    const traj = { ...fakeTraj(true), stopReason: 'answered' as const };
    const cards = store.refine({ trajectory: traj, taskStyle: 'swe', attemptCount: 1, userFeedback: '' });
    assert.equal(cards.filter(c => c.kind === 'success').length, 0, '闲聊/纯问答不喂成功卡');
  });

  it('POSITIVE_FEEDBACK_RE matches the listed words', () => {
    for (const w of ['完美', '可以', '很好', '不错', 'OK', '好的', '没问题']) {
      assert.ok(POSITIVE_FEEDBACK_RE.test(`结果${w}`), `${w} should match`);
    }
  });

  // POSITIVE_SCORE_THRESHOLD 用例已随 score 移除（2026-09-05）：
  // 正向信号 = 用户正向反馈 OR trajectory.success（见上方用例）
});

// ==================== M1.2: /remember + /forget ====================
describe('remember / forget (M1.2)', () => {
  it('remember → kind preference, weight 0.6 (default)', () => {
    const ws = makeTempWorkspace();
    const store = new RefinedMemoryStore(ws);
    const r = store.remember('优先用异步实现', false);
    assert.ok(r.ok);
    assert.equal(r.card!.kind, 'preference');
    assert.equal(r.card!.weight, 0.6);
    assert.equal(r.card!.taskStyle, 'all');
  });

  it('remember --pin → weight 1.0 + pinned (decay frozen)', () => {
    const ws = makeTempWorkspace();
    const store = new RefinedMemoryStore(ws);
    const r = store.remember('永远先跑测试', true);
    assert.equal(r.card!.weight, 1.0);
    assert.equal(r.card!.pinned, true);
    // 60 天后 pin 卡 effectiveWeight 仍 1.0（冻结）
    const farFuture = Date.now() + 60 * 24 * 60 * 60 * 1000;
    assert.equal(store.effectiveWeightOf(r.card!, farFuture), 1.0);
  });

  it('forget removes by id; unknown id → not removed', () => {
    const ws = makeTempWorkspace();
    const store = new RefinedMemoryStore(ws);
    const r = store.remember('偏好A', false);
    assert.equal(store.forget(r.card!.id).removed, true);
    assert.equal(store.forget('nope').removed, false);
    assert.equal(store.list().length, 0);
  });

  it('runMemoryCommand remember/forget flows', async () => {
    const { runMemoryCommand } = await import('../../src/cli/MemoryCommand.js');
    const ws = makeTempWorkspace();
    const out = await runMemoryCommand(['remember', '--pin', '偏好B'], ws);
    assert.ok(out.includes('已记住偏好'));
    assert.ok(out.includes('已 pin'));
    const list = await runMemoryCommand(['list', '--kind', 'preference'], ws);
    assert.ok(list.includes('偏好B'));
    // extract id and forget
    const m = list.match(/\[([a-f0-9]{12})\]/);
    assert.ok(m, 'id shown in list');
    const gone = await runMemoryCommand(['forget', m[1]], ws);
    assert.ok(gone.includes('已删除'));
  });
});

// ==================== M1.3: compact 补漏提炼（防双重计数） ====================
describe('refineCompactSignals (M1.3)', () => {
  it('compact creates a success card with content-derived hash', () => {
    const ws = makeTempWorkspace();
    const store = new RefinedMemoryStore(ws);
    const now = Date.now();
    const cards = store.refineCompactSignals([
      { summary: '已验证可行的做法：score=88', evidence: 'score=88', taskStyle: 'swe', now },
    ]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'success');
    assert.equal(cards[0].id, store.hashOfSuccessSummary('已验证可行的做法：score=88'), 'id = content hash');
  });

  it('same hash second time → count+1, no duplicate card', () => {
    const ws = makeTempWorkspace();
    const store = new RefinedMemoryStore(ws);
    const now = Date.now();
    store.refineCompactSignals([{ summary: '已验证可行的做法：score=90', evidence: 'score=90', taskStyle: 'swe', now }]);
    store.refineCompactSignals([{ summary: '已验证可行的做法：score=90', evidence: 'score=90', taskStyle: 'swe', now }]);
    const cards = store.list().filter(c => c.kind === 'success');
    assert.equal(cards.length, 1, 'no duplicate');
    assert.equal(cards[0].count, 2, 'count incremented');
  });
});
