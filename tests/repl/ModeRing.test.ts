// tests/repl/ModeRing.test.ts
// P4-4.7: cycle order, set(), onChange notification, approval mapping.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ModeRing, uiModeToApprovalMode, UI_MODE_ORDER } from '../../src/cli/repl/ModeRing.js';

describe('ModeRing', () => {
  it('cycles plan → default → auto-accept → full → plan', () => {
    const ring = new ModeRing('plan');
    assert.equal(ring.current, 'plan');
    assert.equal(ring.cycle(), 'default');
    assert.equal(ring.cycle(), 'auto-accept');
    assert.equal(ring.cycle(), 'full');
    assert.equal(ring.cycle(), 'plan');
  });

  it('set() jumps directly and dedupes no-op sets', () => {
    const seen: string[] = [];
    const ring = new ModeRing('default', (m) => seen.push(m));
    ring.set('full');
    assert.equal(ring.current, 'full');
    ring.set('full'); // no-op → no second notification
    assert.deepEqual(seen, ['full']);
  });

  it('nextAfter is a pure helper', () => {
    assert.equal(ModeRing.nextAfter('plan'), 'default');
    assert.equal(ModeRing.nextAfter('full'), 'plan');
  });

  it('UI mode order is exactly the four documented modes', () => {
    assert.deepEqual(UI_MODE_ORDER, ['plan', 'default', 'auto-accept', 'full']);
  });

  it('approval mapping: plan→readonly floor, auto-accept/full→full', () => {
    assert.equal(uiModeToApprovalMode('plan'), 'readonly');
    assert.equal(uiModeToApprovalMode('default'), 'default');
    assert.equal(uiModeToApprovalMode('auto-accept'), 'full');
    assert.equal(uiModeToApprovalMode('full'), 'full');
  });
});
