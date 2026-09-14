// tests/repl/tokenEstimate.test.ts
// A1 计量收口：estTokens（CJK-aware）与 resolveWindowTokens（env > provider 真值 > 32768）
// 是压缩触发（0.85 阈值）/ loop 裁剪预算（70% 预算线）/ REPL 计量的共同地基。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { estTokens, resolveWindowTokens } from '../../src/cli/repl/tokenEstimate.js';

describe('A1 tokenEstimate: estTokens（CJK-aware）', () => {
  it('纯 ASCII ≈ 4 字符/token', () => {
    assert.equal(estTokens(''), 0);
    assert.equal(estTokens('abcd'), 1);
    assert.equal(estTokens('a'.repeat(400)), 100);
  });

  it('CJK ≈ 1.5 token/字（旧 chars/4 会低估 6 倍）', () => {
    assert.equal(estTokens('中'.repeat(100)), 150);
    assert.ok(estTokens('中'.repeat(100)) > 100 / 4, '必须显著高于 chars/4 口径');
  });

  it('中英混合按类分别计', () => {
    // 'abc' 3 ascii + '中文' 2 cjk → ceil(0.75 + 3) = 4
    assert.equal(estTokens('abc中文'), 4);
  });

  it('null/undefined 容错', () => {
    assert.equal(estTokens(null as any), 0);
    assert.equal(estTokens(undefined as any), 0);
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
