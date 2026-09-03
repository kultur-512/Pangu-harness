// tests/tools/diff.test.ts
// M1-2.3: computeLineDiff — add/delete/modify/empty/CRLF/context folding.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeLineDiff } from '../../src/tools/diff.js';

describe('computeLineDiff', () => {
  it('new file → all add', () => {
    const d = computeLineDiff('', 'a\nb\nc');
    assert.equal(d.length, 3);
    assert.ok(d.every((h) => h.type === 'add'));
    assert.deepEqual(d.map((h) => h.text), ['a', 'b', 'c']);
  });

  it('deleted file → all del', () => {
    const d = computeLineDiff('a\nb', '');
    assert.equal(d.length, 2);
    assert.ok(d.every((h) => h.type === 'del'));
  });

  it('both empty → no hunks', () => {
    assert.deepEqual(computeLineDiff('', ''), []);
  });

  it('modification → del+add pair with ctx around', () => {
    const oldText = 'one\ntwo\nthree\nfour\nfive\nsix\nseven';
    const newText = 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven';
    const d = computeLineDiff(oldText, newText);
    const types = d.map((h) => h.type);
    assert.ok(types.includes('del'));
    assert.ok(types.includes('add'));
    assert.equal(d.find((h) => h.type === 'del')?.text, 'three');
    assert.equal(d.find((h) => h.type === 'add')?.text, 'THREE');
    // context lines present (3 before/after)
    assert.ok(d.some((h) => h.type === 'ctx' && h.text === 'two'));
    assert.ok(d.some((h) => h.type === 'ctx' && h.text === 'four'));
    // distant lines folded away
    assert.ok(!d.some((h) => h.type === 'ctx' && h.text === 'seven'));
  });

  it('CRLF input is normalized (\\r never appears in hunk text)', () => {
    const d = computeLineDiff('a\r\nb\r\nc', 'a\r\nB\r\nc');
    for (const h of d) assert.ok(!h.text.includes('\r'));
    assert.equal(d.find((h) => h.type === 'add')?.text, 'B');
  });

  it('folds long context with marker lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
    const oldText = lines.join('\n');
    const newText = lines.slice(0, 50).concat('CHANGED', lines.slice(51)).join('\n');
    const d = computeLineDiff(oldText, newText, 3);
    const foldMarkers = d.filter((h) => h.type === 'ctx' && /行省略/.test(h.text));
    assert.ok(foldMarkers.length >= 1, 'should have fold markers');
    const adds = d.filter((h) => h.type === 'add');
    assert.equal(adds.length, 1);
    assert.equal(adds[0].text, 'CHANGED');
  });

  it('larger-than-budget middle falls back to coarse replace (no crash)', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `old ${i}`);
    const b = Array.from({ length: 3000 }, (_, i) => `new ${i}`);
    const d = computeLineDiff(a.join('\n'), b.join('\n'));
    const dels = d.filter((h) => h.type === 'del').length;
    const adds = d.filter((h) => h.type === 'add').length;
    assert.equal(dels, 3000);
    assert.equal(adds, 3000);
  });

  it('pure insertion and pure deletion mid-file', () => {
    const ins = computeLineDiff('a\nb\nc', 'a\nb\nX\nc');
    assert.equal(ins.filter((h) => h.type === 'add').length, 1);
    assert.equal(ins.filter((h) => h.type === 'del').length, 0);

    const del = computeLineDiff('a\nb\nc', 'a\nc');
    assert.equal(del.filter((h) => h.type === 'del').length, 1);
    assert.equal(del.filter((h) => h.type === 'add').length, 0);
    assert.equal(del.find((h) => h.type === 'del')?.text, 'b');
  });

  it('contextLines=0 → only add/del hunks, zero ctx (incl. fold markers) (dogfood-T1)', () => {
    const oldText = 'one\ntwo\nthree\nfour\nfive\nsix\nseven';
    const newText = 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven';
    const d = computeLineDiff(oldText, newText, 0);
    assert.ok(d.length > 0, 'change must be present');
    assert.equal(d.filter((h) => h.type === 'del').length, 1);
    assert.equal(d.filter((h) => h.type === 'add').length, 1);
    assert.equal(d.filter((h) => h.type === 'ctx').length, 0,
      'contextLines=0 must not emit ANY ctx hunks — not even fold markers');
  });

  it('maxHunks collapses the middle, keeps head+tail (dogfood-T7)', () => {
    // 10 separated single-line changes (default ctx=3) → far more than 5 change hunks
    const oldL = Array.from({ length: 40 }, (_, i) => `L${i}`);
    const newL = oldL.slice();
    for (let i = 0; i < 10; i++) newL[i * 4] = `CHG${i}`;
    const d = computeLineDiff(oldL.join('\n'), newL.join('\n'), 3, 5);
    assert.ok(d.length <= 5 + 8, 'cap must remove most hunks'); // head+tail ctx may remain
    const marker = d.find((h) => h.type === 'ctx' && /hunks omitted/.test(h.text));
    assert.ok(marker, 'collapse marker must be present');
    // head + tail changes preserved
    assert.ok(d.some((h) => h.type === 'add' && h.text === 'CHG0'), 'head change preserved');
    assert.ok(d.some((h) => h.type === 'add' && h.text === 'CHG9'), 'tail change preserved');
    // middle changes collapsed away
    assert.ok(!d.some((h) => h.type === 'add' && h.text === 'CHG4'), 'middle change collapsed');
    // default maxHunks=5 applies when omitted
    const d2 = computeLineDiff(oldL.join('\n'), newL.join('\n'));
    assert.ok(d2.length <= 5 + 8, 'default maxHunks=5 must apply');
  });
});
