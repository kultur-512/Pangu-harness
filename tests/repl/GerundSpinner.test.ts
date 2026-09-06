// tests/repl/GerundSpinner.test.ts
// P4-4.9: gerund vocabulary size, no immediate repeats, label formatting.
// Plus P4-4.5: stringWidth (CJK=2, ASCII=1, emoji=2, mixed sum, zero-width).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextGerund, gerundCount, formatRunningLabel } from '../../src/cli/repl/GerundSpinner.js';
import { stringWidth } from '../../src/cli/repl/stringWidth.js';

describe('GerundSpinner', () => {
  it('vocabulary has at least 10 entries (P3-2 批次 B：纯中文词表)', () => {
    assert.ok(gerundCount() >= 10);
  });

  it('vocabulary is Chinese-only (P3-2 批次 B：删英文词条)', () => {
    for (let i = 0; i < 50; i++) {
      const g = nextGerund();
      assert.ok(!/[a-zA-Z]/.test(g), `non-Chinese gerund leaked: ${g}`);
      assert.ok(/[\u4e00-\u9fff]/.test(g), `gerund without CJK: ${g}`);
    }
  });

  it('never repeats the immediate previous gerund (100 draws)', () => {
    let prev = nextGerund();
    for (let i = 0; i < 100; i++) {
      const g = nextGerund();
      assert.notEqual(g, prev, `immediate repeat at draw ${i}: ${g}`);
      prev = g;
    }
  });

  it('formatRunningLabel embeds gerund + elapsed seconds', () => {
    const label = formatRunningLabel(42000);
    assert.ok(label.includes('⏱ 42s'), label);
    assert.ok(label.includes('…'), label);
    const fixed = formatRunningLabel(1000, '煨煮中');
    assert.equal(fixed, '煨煮中… ⏱ 1s');
  });
});

describe('stringWidth', () => {
  it('ASCII = 1 column each', () => {
    assert.equal(stringWidth('abc'), 3);
    assert.equal(stringWidth(''), 0);
  });

  it('CJK = 2 columns each', () => {
    assert.equal(stringWidth('中文'), 4);
    assert.equal(stringWidth('かな'), 4);
  });

  it('full-width forms = 2 columns', () => {
    assert.equal(stringWidth('ＡＢ'), 4);
    assert.equal(stringWidth('：'), 2);
  });

  it('emoji = 2 columns (surrogate pair handled)', () => {
    assert.equal(stringWidth('🚀'), 2);
    assert.equal(stringWidth('a🚀b'), 4);
  });

  it('mixed string sums correctly', () => {
    // 2 CJK chars (4) + 1 space (1) + 3 ascii (3) = 8
    assert.equal(stringWidth('中文 abc'), 8);
  });

  it('zero-width chars (ZWJ / variation selector) add nothing', () => {
    // '👍' + ZWJ + '👍' (family-emoji sequence): ZWJ contributes 0 → total 4
    const w = stringWidth('👍\u200d👍');
    assert.equal(w, 4, `width should be exactly 4, got ${w}`);
  });

  it('zero-width space / non-joiner / combining-mark-only strings → width 0 (dogfood-T3)', () => {
    assert.equal(stringWidth('\u200b'), 0, 'ZWSP U+200B must be 0-width');
    assert.equal(stringWidth('\u200c'), 0, 'ZWNJ U+200C must be 0-width');
    assert.equal(stringWidth('\u0301'), 0, 'combining mark alone must be 0-width');
    assert.equal(stringWidth('\ufe0f'), 0, 'variation selector alone must be 0-width');
    assert.equal(stringWidth('a\u200bb'), 2, 'ZWSP between ASCII adds nothing');
  });
});
