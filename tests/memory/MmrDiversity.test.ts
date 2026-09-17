// tests/memory/MmrDiversity.test.ts
// B8 MMR 近重复惩罚（ROADMAP B8）单测：
//   - 工具层：summaryTrigramSet（与 mergeSimilarCards 的 tokenize 风格对齐的
//     字符 3-gram）与 trigramOverlapRatio（|A∩B|/min(|A|,|B|)）；
//   - loadFiltered 排序后、maxCards 切片前：贪心选择，近重复（重叠 ≥0.6）卡
//     score ×0.6 放回队列重比（每卡至多惩罚一次，保证终止且名额不丢弃）；
//   - 开关：仅 semanticActive（与语义同门）执行——纯词面路径近重复照旧双占席。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RefinedMemoryStore,
  setSemanticEmbedderForTest,
  summaryTrigramSet,
  trigramOverlapRatio,
} from '../../src/memory/RefinedMemoryStore.js';

let ws = '';
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-mmr-')); });
afterEach(() => {
  setSemanticEmbedderForTest(null);
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
});

const mkCard = (id: string, summary: string, extra: Record<string, unknown> = {}): any => {
  const now = Date.now();
  return {
    id, kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure', summary,
    weight: 2, taskStyle: 'all', count: 1, lastSeen: now, firstSeen: now,
    applicableTiers: [], sourceContext: '', decayWeight: 1.0, lastUsedAt: now, ...extra,
  };
};

// ==================== 工具层 ====================
describe('B8a：3-gram 工具', () => {
  it('summaryTrigramSet：小写/去标点/词内字符 3-gram/跨词去重', () => {
    const g = summaryTrigramSet('Hello, World! hello');
    for (const gram of ['hel', 'ell', 'llo', 'wor', 'orl', 'rld']) {
      assert.ok(g.has(gram), `缺 ${gram}`);
    }
    assert.equal(g.size, 6, '重复词不重复计数');
  });

  it('trigramOverlapRatio = |A∩B|/min(|A|,|B|)；空集恒 0；全等 = 1', () => {
    const a = new Set(['x1', 'x2', 'x3', 'x4']);
    const b = new Set(['x1', 'x2', 'x3', 'y1']);
    assert.ok(Math.abs(trigramOverlapRatio(a, b) - 3 / 4) < 1e-9);
    assert.equal(trigramOverlapRatio(a, new Set()), 0, '空集无重叠语义 → 0（不惩罚）');
    assert.equal(trigramOverlapRatio(new Set(['a']), new Set(['a'])), 1);
    assert.equal(trigramOverlapRatio(a, b), trigramOverlapRatio(b, a), '对称');
  });
});

// ==================== loadFiltered 集成 ====================
describe('B8b：loadFiltered MMR 近重复惩罚（排序后、maxCards 切片前）', () => {
  // it3 实测回退申报：MMR 对弱模型 KU 题是净损失（近重复重述=强化信号），
  // 默认关闭、PANSHA_MMR=1 选择性启用——本 describe 沙箱 env 验证实现本体。
  const KWS = ['banana', 'split', 'grafting'];
  const withMmr = async (fn: () => void): Promise<void> => {
    process.env.PANSHA_MMR = '1';
    try { await fn(); } finally { delete process.env.PANSHA_MMR; }
  };

  /** dupA/dupB 近重复（重叠≈1），divC 主题不同但词面命中 grafting。
   *  α=1 时 score = 0.5*effN + 0.5*relN：dupA=dupB rel2 → 1.0；divC rel1 → 0.75。
   *  MMR 后 dupB ×0.6=0.6 < 0.75 → 序变 [dupA, divC, dupB]。 */
  const makeStore = (): RefinedMemoryStore => {
    const store = new RefinedMemoryStore(ws, 'mem.json');
    // review 去 flake：loadFiltered 同分回退是 lastSeen desc，显式错开消除
    // Date.now() 同毫秒假设（全量并发负载下曾致 B8b 偶发翻转）
    const t0 = Date.now();
    store.save([
      mkCard('dup-a', 'banana split dessert recipe with cream topping', { lastSeen: t0 + 3000 }),
      mkCard('dup-b', 'banana split dessert recipe with cream topping plus nuts', { lastSeen: t0 + 2000 }),
      mkCard('div-c', 'grafting scion technique for orchard trees', { lastSeen: t0 + 1000 }),
    ]);
    setSemanticEmbedderForTest((texts) => texts.map(() => [1, 0])); // 语义等权：只看词面 rel
    return store;
  };

  // 前置事实（既有行为，非 B8 改动项）：无 preference 卡时 maxCards=N 返回 N-1
  // 张（reservePreferenceSeat 恒预留给 preference 1 席）——用例按此口径断言。
  it('近重复卡 ×0.6 放回重比 → 多样性卡反超，不再重复占席（maxCards=3 → 2 张）', async () => {
    await withMmr(() => {
      const r = makeStore().loadFiltered({
        tier: 'high', semantic: true, semanticWeight: 1,
        queryText: 'banana split dessert grafting', keywords: KWS, maxCards: 3,
      });
      assert.deepEqual(r.map((c) => c.id), ['dup-a', 'div-c'], `got [${r.map((c) => c.id)}]`);
    });
  });

  it('选满不丢席位：maxCards=4 时被罚卡仍回填末位（×0.6 重比而非跳过）', async () => {
    await withMmr(() => {
      const r = makeStore().loadFiltered({
        tier: 'high', semantic: true, semanticWeight: 1,
        queryText: 'banana split dessert grafting', keywords: KWS, maxCards: 4,
      });
      assert.deepEqual(r.map((c) => c.id), ['dup-a', 'div-c', 'dup-b'], '近重复卡降权后仍在选集');
    });
  });

  it('semantic 未激活 → 纯词面路径不变（近重复对照旧双占前二）', () => {
    const store = makeStore();
    const off = store.loadFiltered({
      tier: 'high', semantic: false, queryText: 'banana split dessert grafting',
      keywords: KWS, maxCards: 3,
    });
    assert.deepEqual(off.map((c) => c.id), ['dup-a', 'dup-b'], '无 MMR → rel 高的近重复对照旧占前二');
    const plain = store.loadFiltered({ tier: 'high', keywords: KWS, maxCards: 3 });
    assert.deepEqual(plain.map((c) => c.id), ['dup-a', 'dup-b'], '不传 queryText 行为同样不变');
  });

  it('多样性卡互不惩罚：无近重复时序与纯排序一致', () => {
    const store = new RefinedMemoryStore(ws, 'mem3.json');
    store.save([
      mkCard('t1', 'banana split dessert bar'),
      mkCard('t2', 'grafting scion orchard bench'),
      mkCard('t3', 'rocket launch telemetry feed'),
    ]);
    setSemanticEmbedderForTest((texts) => texts.map(() => [1, 0]));
    const f = {
      tier: 'high', semantic: true, semanticWeight: 1,
      queryText: 'banana grafting rocket telemetry',
      keywords: ['banana', 'grafting', 'rocket', 'telemetry'],
    };
    const on = store.loadFiltered(f);
    const off = store.loadFiltered({ ...f, semantic: false });
    // rel：t3 命中 rocket+telemetry=2，t1/t2 各 1 → [t3, t1, t2]；MMR 不得改变该序
    assert.deepEqual(on.map((c) => c.id), ['t3', 't1', 't2'], `got [${on.map((c) => c.id)}]`);
    assert.deepEqual(on.map((c) => c.id), off.map((c) => c.id), '无近重复 → MMR 与纯排序同序');
  });

  it('200 卡（200 卡全对近重复（最坏情况：跨对重叠 0.963、对内 1.000）、20 kind 分桶避开容量帽）规模：全数返回、无崩溃（设计目标 <5ms，断言放宽到 1s 防 CI 抖动）', () => {
    const store = new RefinedMemoryStore(ws, 'mem4.json');
    const cards: any[] = [];
    for (let i = 0; i < 100; i++) {
      const base = `topic${i} shared dessert recipe with cream topping and fruit`;
      // failure 桶有 per-category 10 / kind 40 帽（既有容量治理）——200 卡需
      // 摊到 ≥20 个 kind 桶（未知 kind 回退 MAX_PER_CATEGORY=10/桶）才能全数落盘
      const kind = `k${i % 20}`;
      cards.push(mkCard(`p${i}-a`, base, { kind }));
      cards.push(mkCard(`p${i}-b`, base + ' plus extra syrup notes', { kind }));
    }
    store.save(cards);
    assert.equal(store.list().length, 200, '前置：200 卡全部落盘');
    setSemanticEmbedderForTest((texts) => texts.map(() => [1, 0]));
    const t0 = performance.now();
    const r = store.loadFiltered({
      tier: 'high', semantic: true, semanticWeight: 1,
      queryText: 'dessert recipe topping', keywords: ['dessert', 'recipe'],
    });
    const ms = performance.now() - t0;
    assert.equal(r.length, 200, 'MMR 重排不丢卡');
    assert.ok(ms < 1000, `200 卡 MMR 开销 ${ms.toFixed(1)}ms 超预期`);
  });
});
