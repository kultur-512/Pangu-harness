// tests/repl/KeyHandlerB6.test.ts
// B6 (review defect): Esc arming must not STICK — the old code left
// multilineMode=true until the next Enter, so ANY later Enter submitted the
// multiline buffer. Now: Esc toggles; any non-Esc/non-Enter keypress disarms.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { KeyHandler } from '../../src/cli/repl/KeyHandler.js';
import type { InputReader } from '../../src/cli/repl/types.js';

function makeInput(): InputReader & EventEmitter {
  const em = new EventEmitter();
  return em as unknown as InputReader & EventEmitter;
}

describe('B6 KeyHandler Esc arming (no sticky multiline)', () => {
  it('Esc arms; a non-Enter keypress disarms before Enter', () => {
    const input = makeInput();
    const kh = new KeyHandler(input);
    let submitted = 0;
    kh.setMultilineHandlers(() => {}, () => { submitted++; });

    input.emit('keypress', { name: 'escape' });
    input.emit('keypress', { name: 'x' });        // any other key disarms
    input.emit('keypress', { name: 'return' });   // must NOT submit
    assert.equal(submitted, 0, 'Enter after disarm must not submit multiline');
  });

  it('Esc then Enter still submits (Esc+Enter semantics preserved)', () => {
    const input = makeInput();
    const kh = new KeyHandler(input);
    let submitted = 0;
    kh.setMultilineHandlers(() => {}, () => { submitted++; });

    input.emit('keypress', { name: 'escape' });
    input.emit('keypress', { name: 'return' });
    assert.equal(submitted, 1, 'Esc+Enter must submit multiline');
  });

  it('a second Esc disarms (toggle)', () => {
    const input = makeInput();
    const kh = new KeyHandler(input);
    let submitted = 0;
    kh.setMultilineHandlers(() => {}, () => { submitted++; });

    input.emit('keypress', { name: 'escape' });
    input.emit('keypress', { name: 'escape' });   // second Esc disarms
    input.emit('keypress', { name: 'return' });
    assert.equal(submitted, 0, 'double-Esc must disarm before Enter');
  });
});
