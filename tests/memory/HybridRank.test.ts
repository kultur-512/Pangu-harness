// tests/memory/HybridRank.test.ts
// 检索端"混合排序 + confidence 软惩罚"配套（2026-09-13 写路径宽进严排的排序侧）：
//   B1 calculateEffectiveWeight 对带 confidence 字段的卡乘 (0.5 + 0.5×confidence)，
//      无字段老卡不变；
//   B2 对卡 Q 侧关键词命中计数 ×2（cap 3 总帽不变）；
//   B3 混合排序：semantic+queryText+候选关键词≥2 → 两步归一融合
//      score = α*(0.5*effN + 0.5*relN) + (1-α)*cos；异常/关键词不足回退纯词面；
//      投影 key 追加查询文本与 α（防不同查询串槽）；无 queryText 的旧调用方
//      行为不变（旧公式 0.7*eff+0.3*rel）；
//   B4 embed.ts 进程级向量缓存 + embedCards 增量接口（key=cardId，hash=sha1(summary)）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RefinedMemoryStore,
  hybridScore,
  setSemanticEmbedderForTest,
} from '../../src/memory/RefinedMemoryStore.js';
import {
  embedCards,
  embedQuery,
  embedCacheSize,
  resetEmbedCacheForTest,
} from '../../src/memory/embed.js';

let ws = '';
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-hybrid-rank-')); });
afterEach(() => {
  setSemanticEmbedderForTest(null);
  resetEmbedCacheForTest();
  if (ws) { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} ws = ''; }
});

/** 确定性词表向量：命中词 → 对应维度置 1（8 维，测试可控 cos）。 */
const LEX: Record<string, number> = {
  lex: 0, rocket: 1, banana: 2, split: 3, dessert: 4, tart: 5, grafting: 6, scion: 7,
};
const vecOf = (t: string): number[] => {
  const v = new Array(8).fill(0);
  const low = String(t ?? '').toLowerCase();
  for (const [w, i] of Object.entries(LEX)) if (low.includes(w)) v[i] = 1;
  return v;
};

function makeStore(dir: string): RefinedMemoryStore {
  return new RefinedMemoryStore(dir, 'hybrid-mem.json');
}
function mkCard(id: string, summary: string, extra: Record<string, unknown> = {}): any {
  const now = Date.now();
  return {
    id, kind: 'failure', category: 'COMMAND_FAILED', memoryCategory: 'failure',
    summary, weight: 2, taskStyle: 'all', count: 1,
    lastSeen: now, firstSeen: now, applicableTiers: [], sourceContext: '',
    decayWeight: 1.0, lastUsedAt: now, ...extra,
  };
}

// ==================== B3a：hybridScore 归一化公式（纯函数） ====================
describe('B3a：hybridScore 两步归一融合公式', () => {
  it('score = α*(0.5*effN + 0.5*relN) + (1-α)*cos', () => {
    assert.ok(Math.abs(hybridScore(1.0, 1.0, 2, 0.8, 0.5) - 0.9) < 1e-9, '0.5*(0.5+0.5)+0.5*0.8=0.9');
    assert.ok(Math.abs(hybridScore(0.5, 1.0, 0, 0, 1) - 0.25) < 1e-9, 'effN = eff/maxEff 归一');
    assert.ok(Math.abs(hybridScore(0, 0, 0, 0.7, 0) - 0.7) < 1e-9, 'α=0 → 纯语义');
    assert.ok(Math.abs(hybridScore(1, 1, 0, 0, 0) - 0) < 1e-9, 'cos 缺失（_sem=0）→ 语义项 0');
  });

  it('relN = min(1, rel/2)：rel 命中 3（帽）与命中 2 同为 1', () => {
    assert.ok(Math.abs(hybridScore(1, 1, 2, 0, 1) - 1) < 1e-9);
    assert.ok(Math.abs(hybridScore(1, 1, 3, 0, 1) - 1) < 1e-9, 'cap 3 总帽不变，relN 封顶 1');
  });
});

// ==================== B3b：端到端混合排序 ====================
describe('B3b：loadFiltered 混合排序（注入确定性 embedder）', () => {
  const kws = ['lex', 'rocket', 'banana'];
  let store: RefinedMemoryStore;
  beforeEach(() => {
    store = makeStore(ws);
    // A：词面强（rel=2）、语义弱（cos=0）；B：词面弱（rel=1）、语义强（cos=1）
    store.save([mkCard('lex-hi', 'lex rocket unrelated'), mkCard('sem-hi', 'banana split dessert')]);
    setSemanticEmbedderForTest((texts) => texts.map(vecOf));
  });

  it('α 小（语义主导）→ 语义卡第一；α=1（词面主导）→ 词面卡第一', () => {
    const base = { tier: 'high', keywords: kws, queryText: 'banana split dessert', semantic: true as const };
    const semFirst = store.loadFiltered({ ...base, semanticWeight: 0.1 });
    assert.equal(semFirst[0]?.id, 'sem-hi', `cos 主导时语义卡置顶，got ${semFirst[0]?.id}`);
    const lexFirst = store.loadFiltered({ ...base, semanticWeight: 1 });
    assert.equal(lexFirst[0]?.id, 'lex-hi', `α=1 纯归一词面时高 rel 卡置顶，got ${lexFirst[0]?.id}`);
  });

  it('B1：confidence 软惩罚进排序——0.4 置信卡排到无字段同分卡之后；无字段老卡不变', () => {
    const dir = ws + '-b1';
    fs.mkdirSync(dir, { recursive: true });
    const s2 = makeStore(dir);
    try {
      s2.save([
        mkCard('plain-1', '普通教训甲 keywordpen'),
        mkCard('chatty', '闲聊教训乙 keywordpen', { confidence: 0.4 }),
      ]);
      // 两卡词面全同（rel 同）、eff 同源 → confidence 0.4 乘 0.7 → 排后
      const r = s2.loadFiltered({ tier: 'high', keywords: ['keywordpen'] });
      assert.equal(r[0]?.id, 'plain-1', '低置信软惩罚后移（不再硬拒绝）');
      // 基线 eff = decayWeight(1.0) × factor(当日 1.0) × kindBaseline(failure 1.0) = 1.0
      const plain = s2.list().find((c) => c.id === 'plain-1')!;
      const base = 1.0;
      assert.ok(Math.abs(s2.effectiveWeightOf(plain, Date.now()) - base) < 1e-9, '无 confidence 字段的老卡权重不变');
      const chatty = s2.list().find((c) => c.id === 'chatty')!;
      assert.ok(Math.abs(s2.effectiveWeightOf(chatty, Date.now()) - base * 0.7) < 1e-9, '0.4 置信 ×(0.5+0.5×0.4)=0.7');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('B2：对卡 Q 侧关键词命中 ×2（cap 3 不变）', () => {
    const dir = ws + '-b2';
    fs.mkdirSync(dir, { recursive: true });
    const s3 = makeStore(dir);
    try {
      const pair = {
        ...mkCard('pair-1', 'Q: 柏林机房地址\nA: 具体门牌在二楼'),
        source: 'dialogue-pair', confidence: 1.0, kind: 'preference', memoryCategory: 'insight',
      };
      const plain = mkCard('plain-p', '柏林机房地址的备注', { kind: 'preference', memoryCategory: 'insight' });
      s3.save([pair, plain]);
      const r = s3.loadFiltered({ tier: 'high', keywords: ['柏林', '机房'] });
      // 两卡 summary 都含双关键词 → 普通卡 rel=2；对卡整卡 2 + Q 侧 2 = 4 → cap 3
      assert.equal(r[0]?.id, 'pair-1', 'Q 侧命中加倍 → 对卡置顶');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  // ==================== 【8】B2 判别力加强（2026-09-13 迭代包） ====================
  // 旧 B2 用例两卡 rel 差距与置信度/基线混杂，判别力弱。以下两例把 B2 设为
  // 唯一翻转序的变量：两侧 eff 严格相等（同 kind 基线/weight/decay/count）、
  // lastSeen 显式差 60 秒（plain 更新）——无 B2 时旧公式 0.7eff+0.3rel 同分，
  // tie-break（count 相同 → lastSeen 倒序）必判 plain 胜；用例断言对卡胜出，
  // 因此 B2 一旦被删/退化，用例必须转红。
  it('【8】B2 是唯一翻转序变量：eff 全等 + plain 新 60s → 无 B2 时 plain 以 tie-break 胜，有 B2 时对卡翻到第一', () => {
    const dir = ws + '-b2-only-flip';
    fs.mkdirSync(dir, { recursive: true });
    const s = makeStore(dir);
    try {
      const t = Date.now() - 60 * 60 * 1000; // 久远基准，两卡同处衰减第一段（factor 1.0）
      const pair = {
        ...mkCard('pair-q', 'Q: flaky suite failing again\nA: rerun twice before filing', { lastSeen: t }),
        source: 'dialogue-pair',
      };
      const plain = mkCard('plain-new', 'flaky suite mitigation notes', { lastSeen: t + 60_000 });
      s.save([pair, plain]);
      // 前置：两卡 eff 严格相等（confidence 无字段、基线同为 failure 1.0）
      const now = Date.now();
      const pairCard = s.list().find((c) => c.id === 'pair-q')!;
      const plainCard = s.list().find((c) => c.id === 'plain-new')!;
      assert.ok(
        Math.abs(s.effectiveWeightOf(pairCard, now) - s.effectiveWeightOf(plainCard, now)) < 1e-9,
        '前置：eff 必须全等（否则翻转序不能归因 B2）'
      );
      const r = s.loadFiltered({ tier: 'high', keywords: ['flaky', 'suite'] });
      assert.equal(r[0]?.id, 'pair-q', 'Q 侧加倍（rel 3 vs 2）翻越 lastSeen tie-break → 对卡第一');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('【8】keywords 只命中 A 侧 → Q 侧加倍不误伤：rel 同分时新卡（plain）按 lastSeen 胜出', () => {
    const dir = ws + '-b2-a-side-only';
    fs.mkdirSync(dir, { recursive: true });
    const s = makeStore(dir);
    try {
      const t = Date.now() - 60 * 60 * 1000;
      const pair = {
        ...mkCard('pair-a', 'Q: what is the deploy policy\nA: deploy after green ci windows', { lastSeen: t }),
        source: 'dialogue-pair',
      };
      const plain = mkCard('plain-ci', 'ci pipeline notes', { lastSeen: t + 60_000 });
      s.save([pair, plain]);
      // 'ci' 只在对卡 A 行（'ci windows'）与 plain summary 命中；Q 行无 'ci' →
      // qRel=0，rel 1 vs 1 同分。若实现错误地把 A 侧命中也加倍 → 对卡 rel 2 误翻序。
      const r = s.loadFiltered({ tier: 'high', keywords: ['ci'] });
      assert.equal(r[0]?.id, 'plain-ci', 'A 侧命中不加倍 → 同分 tie-break（lastSeen 倒序）plain 第一');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ==================== B3c：降级路径 ====================
describe('B3c：语义降级路径', () => {
  it('候选关键词 <2 → 语义不激活（embedder 零调用，纯词面）', () => {
    const store = makeStore(ws);
    store.save([mkCard('c1', 'solo query card')]);
    let calls = 0;
    setSemanticEmbedderForTest((texts) => { calls++; return texts.map(() => [1, 0]); });
    store.loadFiltered({ tier: 'high', keywords: ['solo'], queryText: 'solo query', semantic: true });
    assert.equal(calls, 0, '关键词不足 2 → 不触语义通道');
    store.loadFiltered({ tier: 'high', keywords: ['solo', 'duo'], queryText: 'solo duo', semantic: true });
    assert.ok(calls > 0, '关键词 ≥2 → 语义激活');
  });

  it('无 queryText / semantic=false → 旧公式 0.7*eff+0.3*rel，结果与不传时逐项一致', () => {
    const store = makeStore(ws);
    store.save([mkCard('lex-hi', 'lex rocket unrelated'), mkCard('sem-hi', 'banana split dessert')]);
    setSemanticEmbedderForTest((texts) => texts.map(vecOf));
    const plain = store.loadFiltered({ tier: 'high', keywords: ['lex', 'rocket', 'banana'] });
    const qNoSem = store.loadFiltered({ tier: 'high', keywords: ['lex', 'rocket', 'banana'], queryText: 'banana split dessert' });
    const semFalse = store.loadFiltered({ tier: 'high', keywords: ['lex', 'rocket', 'banana'], queryText: 'banana split dessert', semantic: false });
    assert.deepEqual(plain.map((c) => c.id), ['lex-hi', 'sem-hi'], '旧公式：高 rel 卡在前');
    assert.deepEqual(qNoSem.map((c) => c.id), plain.map((c) => c.id), '带 queryText 但未开 semantic → 旧公式');
    assert.deepEqual(semFalse.map((c) => c.id), plain.map((c) => c.id), 'semantic=false 显式关闭 → 旧公式');
  });

  it('embed 异常 → try/catch 回退纯词面（不抛错，排序与非语义一致）', () => {
    const store = makeStore(ws);
    store.save([mkCard('lex-hi', 'lex rocket unrelated'), mkCard('sem-hi', 'banana split dessert')]);
    setSemanticEmbedderForTest(() => { throw new Error('embed down'); });
    const fallback = store.loadFiltered({ tier: 'high', keywords: ['lex', 'rocket', 'banana'], queryText: 'banana split dessert', semantic: true });
    const plain = store.loadFiltered({ tier: 'high', keywords: ['lex', 'rocket', 'banana'] });
    assert.deepEqual(fallback.map((c) => c.id), plain.map((c) => c.id), '异常回退 = 纯词面排序');
  });

  it('卡向量缺失（embedder 少回）→ 该卡 _sem=0，不崩', () => {
    const store = makeStore(ws);
    store.save([mkCard('c1', 'alpha beta'), mkCard('c2', 'alpha gamma')]);
    setSemanticEmbedderForTest((texts) => [vecOf(texts[0])]); // 只回查询向量
    const r = store.loadFiltered({ tier: 'high', keywords: ['alpha', 'beta'], queryText: 'alpha beta', semantic: true });
    assert.equal(r.length, 2, '缺向量卡按 _sem=0 参与排序，不抛错');
  });
});

// ==================== B3d：投影 key 隔离（查询文本与 α 进 key） ====================
describe('B3d：投影 key 追加查询文本与 α（防不同查询串槽）', () => {
  it('词面全同的两卡随查询文本语义翻转；不同查询各占一个投影槽', () => {
    const store = makeStore(ws);
    store.save([mkCard('q-x', 'apple pie dessert tart'), mkCard('q-y', 'apple pie grafting scion')]);
    setSemanticEmbedderForTest((texts) => texts.map(vecOf));
    const f = { tier: 'high', keywords: ['apple', 'pie'], semantic: true as const, semanticWeight: 0.1 };
    const r1 = store.loadFilteredCached({ ...f, queryText: 'dessert tart' });
    const r2 = store.loadFilteredCached({ ...f, queryText: 'grafting scion' });
    assert.equal(r1[0]?.id, 'q-x', 'dessert 查询 → 甜点卡置顶');
    assert.equal(r2[0]?.id, 'q-y', 'grafting 查询 → 嫁接卡置顶（不串槽）');
    assert.ok(store.projectionCount() >= 2, '两个查询各占一个投影槽');

    const before = store.projectionCount();
    store.loadFilteredCached({ ...f, queryText: 'dessert tart', semanticWeight: 0.9 });
    assert.equal(store.projectionCount(), before + 1, 'α 进 key：不同 α 不复用同槽');
  });
});

// ==================== B4：embed.ts 进程级向量缓存 + 增量接口 ====================
describe('B4：embedCards 增量接口（key=cardId，hash=sha1(summary)，hash 变才重嵌）', () => {
  it('同 id 同 summary 命中缓存；summary 变化重嵌；embedQuery 走 provider', () => {
    resetEmbedCacheForTest();
    let calls = 0;
    const spy = {
      name: 'spy',
      dim: 8,
      embed: (t: string) => { calls++; return vecOf(t); },
    };
    const v1 = embedCards([{ id: 'card-1', summary: 'banana split' }], spy as any);
    assert.equal(calls, 1, '首次嵌入');
    assert.equal(embedCacheSize(), 1, '进程级缓存入槽');
    const v2 = embedCards([{ id: 'card-1', summary: 'banana split' }], spy as any);
    assert.equal(calls, 1, 'hash 未变 → 命中缓存不重嵌');
    assert.deepEqual([...(v2.get('card-1') as number[])], [...(v1.get('card-1') as number[])]);
    embedCards([{ id: 'card-1', summary: 'banana split dessert' }], spy as any);
    assert.equal(calls, 2, 'summary 变 → sha1 变 → 重嵌');
    embedQuery('banana split', spy as any);
    assert.equal(calls, 3, '查询向量即时嵌入');
    assert.equal(embedQuery('banana split', spy as any).length, 8);
  });

  it('产品路径（不传 provider）默认 LocalNGramHashProvider，多卡批量返回', () => {
    resetEmbedCacheForTest();
    const m = embedCards([
      { id: 'a', summary: '甲卡内容' },
      { id: 'b', summary: '乙卡内容' },
    ]);
    assert.equal(m.size, 2);
    assert.equal(m.get('a')?.length, 4096, '默认 4096 维');
    const again = embedCards([{ id: 'a', summary: '甲卡内容' }, { id: 'c', summary: '丙卡内容' }]);
    assert.equal(again.size, 2, '增量：a 命中缓存，c 新嵌');
  });
});

// ==================== PANSHA_EMBEDDING=remote：同步回退词面 n-gram + 不崩主流程 ====================
// 诚实口径接线验证：PANSHA_EMBEDDING=remote 时 createConfiguredProvider 返回
// RemoteEmbeddingProvider（其同步 embed() 内持 LocalNGramHashProvider 兜底，
// 不再抛错 → 同步路径仍按词面 n-gram 参与混合排序，不再降级纯词面）；
// 缺配置时工厂回退 n-gram。两种情况下主流程都必须不崩溃、照常返回卡。

describe('B3e：PANSHA_EMBEDDING=remote 可插拔 + 降级（不崩主流程）', () => {
  const REMOTE_ENV_KEYS = ['PANSHA_EMBEDDING', 'PANSHA_EMBED_BASE_URL', 'PANSHA_EMBED_API_KEY', 'PANSHA_EMBED_MODEL'];
  const savedEnv: Record<string, string | undefined> = {};
  const saveEnv = () => { for (const k of REMOTE_ENV_KEYS) savedEnv[k] = process.env[k]; };
  const restoreEnv = () => {
    for (const k of REMOTE_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  };

  it('remote + 配置齐全 → 同步路径回退词面 n-gram（语义命中卡置顶，不再降级纯词面）', () => {
    saveEnv();
    try {
      process.env.PANSHA_EMBEDDING = 'remote';
      process.env.PANSHA_EMBED_BASE_URL = 'https://embed.example.com/v1';
      process.env.PANSHA_EMBED_API_KEY = 'sk-test';
      process.env.PANSHA_EMBED_MODEL = 'text-embedding-3-small';
      const store = makeStore(ws);
      store.save([mkCard('lex-hi', 'lex rocket unrelated'), mkCard('sem-hi', 'banana split dessert')]);
      // 不注入 override → 产品路径 createConfiguredProvider → RemoteEmbeddingProvider，
      // 其同步 embed() 内持 n-gram 兜底（不再抛错）→ 语义通道按词面 n-gram 生效
      const r = store.loadFiltered({ tier: 'high', keywords: ['lex', 'rocket', 'banana'], queryText: 'banana split dessert', semantic: true });
      assert.equal(r.length, 2, '候选卡全量返回');
      assert.equal(r[0]?.id, 'sem-hi', '同步路径回退词面 n-gram：语义命中卡置顶（旧抛错降级纯词面时 lex-hi 置顶）');
    } finally { restoreEnv(); }
  });

  it('remote 但缺配置 → 工厂回退 n-gram → 词面 n-gram 通道正常（不崩溃）', () => {
    saveEnv();
    try {
      process.env.PANSHA_EMBEDDING = 'remote';
      delete process.env.PANSHA_EMBED_BASE_URL;
      delete process.env.PANSHA_EMBED_API_KEY;
      delete process.env.PANSHA_EMBED_MODEL;
      const store = makeStore(ws);
      store.save([mkCard('lex-hi', 'lex rocket unrelated'), mkCard('sem-hi', 'banana split dessert')]);
      const r = store.loadFiltered({ tier: 'high', keywords: ['lex', 'rocket', 'banana'], queryText: 'banana split dessert', semantic: true });
      assert.equal(r.length, 2, '缺配置回退 n-gram，主流程不崩溃');
    } finally { restoreEnv(); }
  });
});
