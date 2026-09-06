// tests/memory/cosine.test.ts
// P4 v0 · cosineSimilarity 边界测试
//
// 覆盖：
// - 同向量 → 1
// - 正交向量 → 0
// - 零向量 → 0（避免除零/NaN）
// - 维度不一致 → throw
// - undefined / NaN 视作 0
// - v0 真实向量互测（与 LocalNGramHashProvider 端到端）

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity } from '../../src/memory/embed.js';
import { LocalNGramHashProvider } from '../../src/memory/embed.js';

describe('cosineSimilarity：基本边界', () => {
  it('同向量 → 1（自相似恒为 1）', () => {
    const v = [1, 2, 3, 4, 5];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
  });

  it('同向量缩放 → 1（方向一致即相似度 1）', () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6]; // b = 2*a
    assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-9);
  });

  it('正交向量 → 0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it('反向向量 → -1（理论极限）', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    assert.ok(Math.abs(cosineSimilarity(a, b) - -1) < 1e-9);
  });
});

describe('cosineSimilarity：零向量处理（关键边界）', () => {
  it('任一向量为零向量 → 返回 0（不返回 NaN，不抛错）', () => {
    const zero = [0, 0, 0, 0];
    const v = [1, 2, 3, 4];
    assert.equal(cosineSimilarity(zero, v), 0);
    assert.equal(cosineSimilarity(v, zero), 0);
  });

  it('两向量均为零 → 0', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it('零向量内不抛除零异常', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    let threw = false;
    try {
      cosineSimilarity(a, b);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, '零向量对零向量不能抛错');
  });
});

describe('cosineSimilarity：维度不一致', () => {
  it('维度不同 → throw', () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    assert.throws(() => cosineSimilarity(a, b), /dimension mismatch/);
  });

  it('throw 信息含具体维度（开发期可读）', () => {
    const a = [1, 2];
    const b = [1, 2, 3, 4];
    try {
      cosineSimilarity(a, b);
      assert.fail('应抛错');
    } catch (e) {
      assert.match((e as Error).message, /a=2.*b=4/);
    }
  });

  it('空数组 vs 非空 → throw', () => {
    assert.throws(() => cosineSimilarity([], [1, 2, 3]), /dimension mismatch/);
  });
});

describe('cosineSimilarity：undefined / NaN 视作 0', () => {
  it('稀疏数组（undefined 视作 0）→ 仍计算', () => {
    const a = [1, undefined as unknown as number, 3];
    const b = [1, 0, 3];
    // 视作 0 后行为应等价于 b=[1,0,3]（浮点误差 ±1e-9）
    assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-9);
  });

  it('含 NaN → 不抛错，结果有限值', () => {
    const a = [1, NaN, 3];
    const b = [1, 2, 3];
    const result = cosineSimilarity(a, b);
    assert.ok(Number.isFinite(result), `结果必须有限，got ${result}`);
  });

  it('两向量全 NaN → 返回 0（norm=0 路径）', () => {
    const a = [NaN, NaN, NaN];
    const b = [NaN, NaN, NaN];
    // NaN 视作 0 → 等价两零向量
    assert.equal(cosineSimilarity(a, b), 0);
  });
});

describe('cosineSimilarity：值域', () => {
  it('v0 非负向量（LocalNGramHashProvider 输出）互测 → ∈ [0, 1]', () => {
    const p = new LocalNGramHashProvider();
    const v1 = p.embed('openPangu 记忆卡注入路径');
    const v2 = p.embed('openPangu 记忆增强');
    const v3 = p.embed('session resume 分支续接');

    const s12 = cosineSimilarity(v1, v2);
    const s13 = cosineSimilarity(v1, v3);
    const s23 = cosineSimilarity(v2, v3);

    assert.ok(s12 >= 0 && s12 <= 1, `s12 应 ∈ [0,1]，got ${s12}`);
    assert.ok(s13 >= 0 && s13 <= 1, `s13 应 ∈ [0,1]，got ${s13}`);
    assert.ok(s23 >= 0 && s23 <= 1, `s23 应 ∈ [0,1]，got ${s23}`);
  });

  it('完全相同文本 cosine = 1（端到端验证 L2 归一化 + cosine 路径）', () => {
    const p = new LocalNGramHashProvider();
    const v = p.embed('烛龙 Zhulong 内部代号 Panshalach');
    const cos = cosineSimilarity(v, v);
    assert.ok(Math.abs(cos - 1) < 1e-9, `同文本 cosine 必须为 1，got ${cos}`);
  });

  it('同文本子集 cosine > 0（相似召回）', () => {
    const p = new LocalNGramHashProvider();
    const v1 = p.embed('openPangu 网络超时');
    const v2 = p.embed('openPangu 网络抖动 retry');
    const cos = cosineSimilarity(v1, v2);
    // 共享 "openPangu" + "网络" 等 2-gram → cosine 应显著 > 0
    assert.ok(cos > 0.1, `共享子串应显著相关，got ${cos}`);
  });
});