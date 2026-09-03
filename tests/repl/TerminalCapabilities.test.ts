// tests/repl/TerminalCapabilities.test.ts
// P2-E: TerminalCapabilities pure detection tests (v2 blueprint)
// Cases:
// - non-TTY: color=false, keypress=false, multiline=false, progress=false, ansiCursor=false
// - old Windows cmd (win32, no WT/COLORTERM/modern TERM, TTY): conservative disable of advanced features
// - Windows Terminal (WT_SESSION): full capabilities when TTY
// - PowerShell ISE: keypress=false, multiline=false, progress=false, ansiCursor=false
// - Unix TTY: full capabilities
// - Performance: detect <1ms per call

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTerminalCapabilities,
  resetTerminalCapabilitiesCache,
} from '../../src/cli/repl/TerminalCapabilities.js';
import type { TerminalEnv } from '../../src/utils/ansi.js';

function env(partial: Partial<TerminalEnv>): TerminalEnv {
  return {
    platform: partial.platform ?? 'win32',
    env: partial.env ?? {},
    isTTY: partial.isTTY ?? true,
  };
}

describe('P2-E TerminalCapabilities (pure detection)', () => {
  it('non-TTY environment disables all interactive features', () => {
    resetTerminalCapabilitiesCache();
    const e: TerminalEnv = { platform: 'linux', env: {}, isTTY: false };
    const c = detectTerminalCapabilities(e);
    assert.equal(c.color, false);
    assert.equal(c.keypress, false);
    assert.equal(c.multiline, false);
    assert.equal(c.progress, false);
    assert.equal(c.ansiCursor, false);
  });

  it('old Windows cmd (no WT, no COLORTERM, plain TERM) disables advanced features', () => {
    resetTerminalCapabilitiesCache();
    const e = env({
      platform: 'win32',
      env: { TERM: 'xterm' }, // not enough alone without WT/COLORTERM signals on win32 per our conservative rule
      isTTY: true,
    });
    // Our rule: on win32 without WT or COLORTERM or modern TERM hints that pass, disable
    // But TERM=xterm alone is treated insufficient in isOldWindowsCmd path → color false
    const c = detectTerminalCapabilities(e);
    // Conservative: color may be false; keypress/multiline/progress/ansiCursor must be false for old cmd
    assert.equal(c.keypress, false);
    assert.equal(c.multiline, false);
    assert.equal(c.progress, false);
    assert.equal(c.ansiCursor, false);
  });

  it('Windows Terminal (WT_SESSION) enables full capabilities on TTY', () => {
    resetTerminalCapabilitiesCache();
    const e = env({
      platform: 'win32',
      env: { WT_SESSION: '1', TERM: 'xterm-256color' },
      isTTY: true,
    });
    const c = detectTerminalCapabilities(e);
    assert.equal(c.color, true);
    assert.equal(c.keypress, true);
    assert.equal(c.multiline, true);
    assert.equal(c.progress, true);
    assert.equal(c.ansiCursor, true);
  });

  it('PowerShell ISE disables keypress/multiline/progress/cursor', () => {
    resetTerminalCapabilitiesCache();
    const e = env({
      platform: 'win32',
      env: { PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules', TERM: 'xterm' },
      isTTY: true,
    });
    const c = detectTerminalCapabilities(e);
    assert.equal(c.keypress, false);
    assert.equal(c.multiline, false);
    assert.equal(c.progress, false);
    assert.equal(c.ansiCursor, false);
  });

  it('Unix TTY enables full capabilities', () => {
    resetTerminalCapabilitiesCache();
    const e = env({
      platform: 'linux',
      env: { TERM: 'xterm-256color' },
      isTTY: true,
    });
    const c = detectTerminalCapabilities(e);
    assert.equal(c.color, true);
    assert.equal(c.keypress, true);
    assert.equal(c.multiline, true);
    assert.equal(c.progress, true);
    assert.equal(c.ansiCursor, true);
  });

  it('detection is fast (<1ms per call on average over many iterations)', () => {
    resetTerminalCapabilitiesCache();
    const e: TerminalEnv = { platform: 'linux', env: { TERM: 'xterm-256color' }, isTTY: true };
    const iterations = 2000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      detectTerminalCapabilities(e);
    }
    const t1 = process.hrtime.bigint();
    const avgMs = Number(t1 - t0) / iterations / 1e6;
    assert.ok(avgMs < 1, `expected <1ms per detect, got ${avgMs.toFixed(4)}ms`);
  });
});
