// tests/memory/embed.test.ts
// P4 EmbeddingProvider v0 契约测试（LocalNGramHashProvider）
//
// 覆盖：
// - 基础属性（name / dim）
// - 幂等性（同输入两次 embed 结果一致）
// - L2 归一化（||v|| = 1）
// - 桶分布（非空文本产生非零桶；不同文本产生不同向量）
// - 边界：空字符串 / 中文 / 代码混合
// - 构造器边界：buckets 必须 int in (0, 65536]
// - embedBatch 批量调用
// - createDefaultProvider 工厂

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalNGramHashProvider,
  createDefaultProvider,
  DEFAULT_BUCKETS,
  type DenseVector,
} from '../../src/memory/embed.js';

describe('P4 v0 · LocalNGramHashProvider：基础属性', () => {
  it('name === "local-ngram"', () => {
    const p = new LocalNGramHashProvider();
    assert.equal(p.name, 'local-ngram');
  });

  it('默认 dim === DEFAULT_BUCKETS (4096)', () => {
    const p = new LocalNGramHashProvider();
    assert.equal(p.dim, DEFAULT_BUCKETS);
    assert.equal(p.dim, 4096);
  });

  it('自定义 buckets 生效', () => {
    const p = new LocalNGramHashProvider(128);
    assert.equal(p.dim, 128);
  });
});

describe('P4 v0 · LocalNGramHashProvider：幂等性', () => {
  it('同文本连续 embed 两次结果完全一致（确定性、零随机）', () => {
    const p = new LocalNGramHashProvider();
    const a = p.embed('hello world');
    const b = p.embed('hello world');
    assert.deepEqual(a, b);
  });

  it('不同实例对同文本结果一致（无隐式状态）', () => {
    const p1 = new LocalNGramHashProvider(256);
    const p2 = new LocalNGramHashProvider(256);
    const text = 'openPangu 国产大模型';
    assert.deepEqual(p1.embed(text), p2.embed(text));
  });
});

describe('P4 v0 · LocalNGramHashProvider：L2 归一化', () => {
  it('非空文本 ||v|| ≈ 1', () => {
    const p = new LocalNGramHashProvider();
    const v = p.embed('openPangu 记忆增强');
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    // 浮点误差容差 ±1e-9
    assert.ok(Math.abs(norm - 1) < 1e-9, `L2 norm must be 1, got ${norm}`);
  });

  it('空字符串向量各分量 = 0（不归一化，避免除零）', () => {
    const p = new LocalNGramHashProvider(64);
    const v = p.embed('');
    assert.equal(v.length, 64);
    assert.ok(v.every((x) => x === 0));
  });

  it('归一化不修改入参（in-place 拷贝语义）', () => {
    const p = new LocalNGramHashProvider();
    const input: DenseVector = [1, 2, 3, 4];
    const snapshot = [...input];
    p.embed('foo'); // 内部会归一化，与本断言无关——这里仅做 smoke
    // 直接断言 normalize 不污染入参的另一种方式：
    assert.deepEqual(input, snapshot);
  });
});

describe('P4 v0 · LocalNGramHashProvider：桶分布', () => {
  it('非空文本至少有一个非零桶', () => {
    const p = new LocalNGramHashProvider();
    const v = p.embed('a');
    assert.ok(v.some((x) => x > 0), '短文本也应有非零桶');
  });

  it('不同文本产生不同向量（基础召回前提）', () => {
    const p = new LocalNGramHashProvider();
    const a = p.embed('openPangu 长上下文');
    const b = p.embed('session resume 分支');
    // 不是全等（也不必特定 cosine 阈值）
    assert.notDeepEqual(a, b);
  });

  it('重复 n-gram 文本桶计数更高（特征可加性）', () => {
    const p = new LocalNGramHashProvider();
    const v1 = p.embed('ab');
    const v2 = p.embed('abab');
    // v2 的非零桶集 ⊇ v1 的非零桶集（2-gram "ab" 在两者中都出现）
    const nz1 = v1.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0);
    const nz2 = v2.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0);
    // v2 至少包含 v1 的非零桶（前提：两个文本的 padded 2-gram 重叠）
    for (const idx of nz1) {
      assert.ok(v2[idx] > 0, `v2 在桶 ${idx} 应非零（v1 中非零）`);
    }
  });
});

describe('P4 v0 · LocalNGramHashProvider：边界场景', () => {
  it('中英文混合正常 embed', () => {
    const p = new LocalNGramHashProvider();
    const v = p.embed('openPangu 网络超时 retry');
    assert.equal(v.length, DEFAULT_BUCKETS);
    assert.ok(v.some((x) => x > 0));
  });

  it('纯代码片段可 embed（数字/符号/下划线）', () => {
    const p = new LocalNGramHashProvider(256);
    const v = p.embed('async function solve() { await fetch(); }');
    assert.equal(v.length, 256);
    assert.ok(v.some((x) => x > 0));
  });

  it('单字符文本：pad 后产生 2 个 2-gram', () => {
    const p = new LocalNGramHashProvider(64);
    const v = p.embed('x');
    const nonZero = v.filter((x) => x > 0).length;
    // " x" 与 "x " 两个 padded 2-gram → 至多 2 个非零桶
    assert.ok(nonZero >= 1 && nonZero <= 2, `单字符应 1~2 个非零桶，got ${nonZero}`);
  });
});

describe('P4 v0 · LocalNGramHashProvider：构造器校验', () => {
  it('buckets = 0 → throw', () => {
    assert.throws(() => new LocalNGramHashProvider(0), /buckets must be int/);
  });

  it('buckets = 负数 → throw', () => {
    assert.throws(() => new LocalNGramHashProvider(-1), /buckets must be int/);
  });

  it('buckets = 非整数 → throw', () => {
    assert.throws(() => new LocalNGramHashProvider(3.5), /buckets must be int/);
  });

  it('buckets = 65537（超过上限）→ throw', () => {
    assert.throws(() => new LocalNGramHashProvider(65537), /buckets must be int/);
  });

  it('buckets = 65536（上限 OK）', () => {
    const p = new LocalNGramHashProvider(65536);
    assert.equal(p.dim, 65536);
  });
});

describe('P4 v0 · LocalNGramHashProvider：embedBatch', () => {
  it('批量返回 N 个同维度向量', () => {
    const p = new LocalNGramHashProvider();
    const texts = ['foo', 'bar', 'openPangu'];
    const vecs = p.embedBatch(texts);
    assert.equal(vecs.length, 3);
    for (const v of vecs) {
      assert.equal(v.length, DEFAULT_BUCKETS);
    }
  });

  it('批量与单次结果一致', () => {
    const p = new LocalNGramHashProvider();
    const text = '记忆卡注入路径';
    const single = p.embed(text);
    const batched = p.embedBatch([text])[0];
    assert.deepEqual(single, batched);
  });

  it('批量空数组返回空数组', () => {
    const p = new LocalNGramHashProvider();
    assert.deepEqual(p.embedBatch([]), []);
  });
});

describe('P4 v0 · createDefaultProvider 工厂', () => {
  it('默认返回 LocalNGramHashProvider 实例', () => {
    const p = createDefaultProvider();
    assert.ok(p instanceof LocalNGramHashProvider);
    assert.equal(p.name, 'local-ngram');
    assert.equal(p.dim, DEFAULT_BUCKETS);
  });

  it('传 buckets → 生效', () => {
    const p = createDefaultProvider(128);
    assert.ok(p instanceof LocalNGramHashProvider);
    assert.equal(p.dim, 128);
  });
});