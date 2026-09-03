// tests/repl/useInputBuffer.test.ts
// cc-typeahead (C): debounce-merged undo/redo buffer (prevText model).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InputBuffer } from '../../src/cli/repl/ui/useInputBuffer.js';

describe('InputBuffer', () => {
  it('debounce merges rapid changes into one undoable batch', () => {
    const buf = new InputBuffer(1000); // long window: all merges
    buf.push('', 'a');
    buf.push('a', 'ab');
    buf.push('ab', 'abc');
    // undo of the merged batch restores the state BEFORE the batch began
    assert.equal(buf.undo('abc'), '');
  });

  it('changes outside the window become separate entries', async () => {
    const buf = new InputBuffer(5);
    buf.push('', 'a');
    await new Promise((r) => setTimeout(r, 20));
    buf.push('a', 'ab');
    assert.equal(buf.undo('ab'), 'a');   // separate batch → revert to 'a'
    assert.equal(buf.undo('a'), '');     // previous batch → revert to ''
    assert.equal(buf.undo(''), null);    // nothing left
  });

  it('redo re-applies after undo; new input clears redo', () => {
    const buf = new InputBuffer(1000); // merged: one batch '' → … → 'ab'
    buf.push('', 'a');
    buf.push('a', 'ab');
    assert.equal(buf.undo('ab'), '');      // revert to batch start
    assert.equal(buf.redo(''), 'ab');      // re-apply the batch
    // new input invalidates redo
    assert.equal(buf.undo('ab'), '');
    buf.push('', 'ax');
    assert.equal(buf.redo('ax'), null);
  });

  it('undo/redo on empty stack returns null', () => {
    const buf = new InputBuffer(5);
    assert.equal(buf.undo('x'), null);
    assert.equal(buf.redo('x'), null);
  });

  it('clear resets both stacks', () => {
    const buf = new InputBuffer(1000);
    buf.push('', 'a');
    buf.undo('a');
    buf.clear();
    assert.equal(buf.undo('a'), null);
    assert.equal(buf.redo('a'), null);
  });
});
