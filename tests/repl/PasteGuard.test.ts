// tests/repl/PasteGuard.test.ts
// P4-4.4: threshold boundaries (3/4 lines, 2000/2001 chars), folding, preview.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPaste, foldPaste, pastePreview } from '../../src/cli/repl/PasteGuard.js';

describe('detectPaste', () => {
  it('3 lines is NOT a paste; 4 lines is', () => {
    assert.equal(detectPaste('a\nb\nc').isPaste, false);
    assert.equal(detectPaste('a\nb\nc\nd').isPaste, true);
  });

  it('2000 chars is NOT a paste; 2001 is', () => {
    assert.equal(detectPaste('x'.repeat(2000)).isPaste, false);
    assert.equal(detectPaste('x'.repeat(2001)).isPaste, true);
  });

  it('CRLF lines counted correctly', () => {
    assert.equal(detectPaste('a\r\nb\r\nc').lines, 3);
    assert.equal(detectPaste('a\r\nb\r\nc\r\nd').isPaste, true);
  });

  it('empty string is not a paste', () => {
    const r = detectPaste('');
    assert.equal(r.isPaste, false);
    assert.equal(r.lines, 0);
  });

  it('foldPaste produces the placeholder with line count', () => {
    const f = foldPaste('a\nb\nc\nd\ne');
    assert.ok(f.includes('[粘贴 5 行'), f);
  });

  it('pastePreview caps at 20 lines with omission marker', () => {
    const text = Array.from({ length: 35 }, (_, i) => `L${i}`).join('\n');
    const p = pastePreview(text);
    assert.ok(p.includes('L19'));
    assert.ok(!p.includes('L20'));
    assert.ok(p.includes('共 35 行'));
    const small = pastePreview('a\nb');
    assert.equal(small, 'a\nb');
  });
});
