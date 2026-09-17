// tests/repl/tokenEstimate.test.ts
// A1 计量收口：estTokens（CJK-aware）与 resolveWindowTokens（env > provider 真值 > 32768）
// 是压缩触发（0.85 阈值）/ loop 裁剪预算（70% 预算线）/ REPL 计量的共同地基。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { estTokens, resolveWindowTokens, safeSlice, setCjkTokensPerCharForTest } from '../../src/cli/repl/tokenEstimate.js';

describe('A1 tokenEstimate: estTokens（CJK-aware）', () => {
  it('纯 ASCII ≈ 4 字符/token', () => {
    assert.equal(estTokens(''), 0);
    assert.equal(estTokens('abcd'), 1);
    assert.equal(estTokens('a'.repeat(400)), 100);
  });

  it('CJK ≈ 1.0 token/字（旧 chars/4 会低估 4 倍）', () => {
    assert.equal(estTokens('中'.repeat(100)), 100);
    assert.ok(estTokens('中'.repeat(100)) > 100 / 4, '必须显著高于 chars/4 口径');
  });

  it('中英混合按类分别计', () => {
    // 'abc' 3 ascii + '中文' 2 cjk → ceil(0.75 + 2) = 3
    assert.equal(estTokens('abc中文'), 3);
  });

  it('null/undefined 容错', () => {
    assert.equal(estTokens(null as any), 0);
    assert.equal(estTokens(undefined as any), 0);
  });

  it('CJK 系数默认 1.0；setCjkTokensPerCharForTest 可临时覆盖（改后复位）', () => {
    assert.equal(estTokens('中'.repeat(100)), 100);
    setCjkTokensPerCharForTest(1.5);
    try {
      assert.equal(estTokens('中'.repeat(100)), 150);
    } finally {
      setCjkTokensPerCharForTest(1.0);
    }
    assert.equal(estTokens('中'.repeat(100)), 100);
  });
});

// ==================== 包B：CJK 判定范围扩展（旧实现只认 0x4e00-0x9fff） ====================
describe('包B estTokens CJK 范围扩展', () => {
  it('扩展A / 假名 / 谚文 / 兼容表意 / 中文标点 / 全角 均按 1.0（默认）token/字符', () => {
    assert.equal(estTokens('\u3400'.repeat(100)), 100, '扩展A 0x3400-0x4DBF');
    assert.equal(estTokens('\u3042'.repeat(100)), 100, '假名 0x3040-0x30FF');
    assert.equal(estTokens('\uAC00'.repeat(100)), 100, '谚文 0xAC00-0xD7AF');
    assert.equal(estTokens('\uF900'.repeat(100)), 100, '兼容表意 0xF900-0xFAFF');
    assert.equal(estTokens('\u3002'.repeat(100)), 100, '中文标点 0x3000-0x303F');
    assert.equal(estTokens('\uFF0C'.repeat(100)), 100, '全角标点 0xFF00-0xFFEF');
    assert.equal(estTokens('\uFF6A'.repeat(100)), 100, '半角片假名 0xFF66-0xFF9F');
  });

  it('锚点回归：纯 CJK 100 字 = 100 tokens、ascii 400 = 100 tokens 不变', () => {
    assert.equal(estTokens('中'.repeat(100)), 100);
    assert.equal(estTokens('a'.repeat(400)), 100);
    assert.equal(estTokens('abc中文'), 3);
  });

  it('emoji（星外平面码点）按非 CJK 计（1 码点 ≈ 0.25）', () => {
    assert.equal(estTokens('👍'), 1);
  });
});

// ==================== 包B：safeSlice 码点对齐截断（不产孤立代理项） ====================
describe('safeSlice：码点对齐截断', () => {
  const text = 'a👍b🇨🇳c中d𝕏e'; // BMP + 代理对混合
  const hasOrphanSurrogate = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      if (u >= 0xd800 && u <= 0xdbff) {
        const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      } else if (u >= 0xdc00 && u <= 0xdfff) {
        const p = i > 0 ? s.charCodeAt(i - 1) : 0;
        if (!(p >= 0xd800 && p <= 0xdbff)) return true;
      }
    }
    return false;
  };

  it('任意 start/end 组合截断均无孤立代理项；与 String.slice 在合法边界上逐字节一致', () => {
    for (let start = 0; start <= text.length; start++) {
      for (let end = start; end <= text.length; end++) {
        const s = safeSlice(text, start, end);
        assert.equal(hasOrphanSurrogate(s), false, `safeSlice(${start},${end}) 产生孤立代理项`);
        if (!hasOrphanSurrogate(text.slice(start, end))) {
          assert.equal(s, text.slice(start, end), `safeSlice(${start},${end}) 偏离 slice 语义`);
        }
      }
    }
  });

  it('边界落在代理对中间：成对回退，不切一半', () => {
    const t = 'x👍y';
    assert.equal(safeSlice(t, 0, 2), 'x', 'end 切在代理对中间 → 回退一位，不含孤立高位代理项');
    assert.equal(safeSlice(t, 2), 'y', 'start 切在代理对中间 → 跳过孤立低位代理项');
    assert.equal(safeSlice(t, 1, 3), '👍', '完整代理对保留');
  });

  it('负索引/越界/退化容错（对齐 String.slice 语义）', () => {
    assert.equal(safeSlice('hello', -3), 'llo');
    assert.equal(safeSlice('hello', 1, -1), 'ell');
    assert.equal(safeSlice('hello', 3, 2), '');
    assert.equal(safeSlice('hello', 99, 100), '');
    assert.equal(safeSlice('hello', 0), 'hello');
    assert.equal(safeSlice(null as any, 0, 2), '');
    assert.equal(safeSlice(undefined as any, -2), '');
  });

  it('码点前缀性质：head 截断恰为前 k 个完整码点（k 最大且码元长度 ≤ end）', () => {
    const cps = [...text];
    const prefixLen = (k: number) => cps.slice(0, k).reduce((n, c) => n + c.length, 0);
    for (let end = 0; end <= text.length; end++) {
      let k = 0;
      while (k < cps.length && prefixLen(k + 1) <= end) k++;
      assert.equal(safeSlice(text, 0, end), cps.slice(0, k).join(''), `end=${end}`);
    }
  });
});

describe('A1 tokenEstimate: resolveWindowTokens', () => {
  const ORIG = process.env.PANSHA_CTX_WINDOW;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.PANSHA_CTX_WINDOW;
    else process.env.PANSHA_CTX_WINDOW = ORIG;
  });

  it('PANSHA_CTX_WINDOW env 覆盖优先（UI 计量与 loop 预算必须同源）', () => {
    process.env.PANSHA_CTX_WINDOW = '8192';
    assert.equal(resolveWindowTokens({ getModelContextLength: () => 131072 } as any, 'm'), 8192);
  });

  it('provider 真值直取；≤0 / 256000 哨兵 / 抛错 / 无 provider → 32768 保守值', () => {
    delete process.env.PANSHA_CTX_WINDOW;
    assert.equal(resolveWindowTokens({ getModelContextLength: () => 131072 } as any, 'm'), 131072);
    assert.equal(resolveWindowTokens({ getModelContextLength: () => 0 } as any, 'm'), 32768);
    assert.equal(resolveWindowTokens({ getModelContextLength: () => 256000 } as any, 'm'), 32768, '遗留 256000 哨兵视为 unknown');
    assert.equal(resolveWindowTokens({ getModelContextLength: () => { throw new Error('x'); } } as any, 'm'), 32768);
    assert.equal(resolveWindowTokens(undefined, 'm'), 32768);
  });
});
