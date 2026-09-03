// tests/repl/OutputRenderer.test.ts
// P2-B: OutputRenderer progressBar tests (per v2 blueprint acceptance)
// Cases required:
// - progressBar(0,1,'test') returns handle; update(0.5) produces output containing █ and %
// - done('完成') produces output containing "完成"
// - non-TTY env: all handle methods are no-op (no writes)

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OutputRendererImpl } from '../../src/cli/repl/OutputRenderer.js';
import type { ProgressBarHandle } from '../../src/cli/repl/OutputRenderer.js';

function withTTY<T>(isTTY: boolean, fn: () => T): T {
  // M2.5: capability detection requires BOTH stdout AND stdin TTY plus a
  // color-capable environment (progress = tty && (color || !win) on Windows).
  // Stub the descriptors and FORCE_COLOR, and restore exactly what was there.
  const outDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const inDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const prevForceColor = process.env.FORCE_COLOR;
  // pwsh exports PSModulePath → the detector classifies the host as PowerShell
  // ISE and degrades everything; tests stub a normal-terminal environment.
  const prevPsmp = process.env.PSModulePath;
  const prevTerm = process.env.TERM;
  const prevNoColor = process.env.NO_COLOR;
  (process.stdout as any).isTTY = isTTY;
  (process.stdin as any).isTTY = isTTY;
  if (isTTY) process.env.FORCE_COLOR = '1';
  if (isTTY) delete process.env.PSModulePath;
  if (isTTY) process.env.TERM = 'xterm-256color'; // modern-terminal signal (else isOldWindowsCmd=true)
  if (isTTY) delete process.env.NO_COLOR; // NO_COLOR overrides FORCE_COLOR in utils/ansi
  try {
    return fn();
  } finally {
    if (outDesc) Object.defineProperty(process.stdout, 'isTTY', outDesc);
    else delete (process.stdout as any).isTTY;
    if (inDesc) Object.defineProperty(process.stdin, 'isTTY', inDesc);
    else delete (process.stdin as any).isTTY;
    if (prevForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = prevForceColor;
    if (prevPsmp === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = prevPsmp;
    if (prevTerm === undefined) delete process.env.TERM;
    else process.env.TERM = prevTerm;
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  }
}

function captureWrites(fn: () => void): string[] {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // @ts-ignore - replace temporarily
  process.stdout.write = (data: any, ...args: any[]) => {
    chunks.push(String(data));
    // Do not actually write during tests to keep output clean
    return true as any;
  };
  try {
    fn();
  } finally {
    // @ts-ignore - restore
    process.stdout.write = origWrite;
  }
  return chunks;
}

describe('P2-B OutputRenderer progressBar (v2)', () => {
  let renderer: OutputRendererImpl;

  beforeEach(() => {
    renderer = new OutputRendererImpl();
  });

  afterEach(() => {
    // nothing
  });

  it('progressBar returns handle; update(0.5) emits bar with █ and percentage', () => {
    const outputs = withTTY(true, () =>
      captureWrites(() => {
        const handle: ProgressBarHandle = renderer.progressBar(0, 1, 'budget');
        handle.update(0.5);
        handle.done();
      })
    );

    const joined = outputs.join('');
    // Must contain a bar character and a percentage
    assert.ok(joined.includes('█'), 'should contain filled block █ at 50%');
    assert.ok(joined.includes('%'), 'should contain percentage');
    // Optional label passthrough
    // We do not assert exact label here because done() may have cleared; the update line had it
  });

  it('done(message) clears bar and prints final message containing the text', () => {
    const outputs = withTTY(true, () =>
      captureWrites(() => {
        const handle = renderer.progressBar(0, 10, 'test');
        handle.update(0.2);
        handle.done('完成');
      })
    );
    const joined = outputs.join('');
    assert.ok(joined.includes('完成'), 'done should output the completion message');
  });

  it('non-TTY environment returns stub handle whose methods are no-op', () => {
    const outputs = withTTY(false, () =>
      captureWrites(() => {
        const handle = renderer.progressBar(0, 1, 'no-tty');
        handle.update(0.7);
        handle.done('should-not-appear');
        handle.fail('also-not');
      })
    );
    const joined = outputs.join('');
    // In non-TTY we expect no progress rendering and no final message from the handle
    assert.ok(!joined.includes('█'), 'non-TTY must not render bar characters');
    assert.ok(!joined.includes('should-not-appear'), 'non-TTY stub done must not print');
    assert.ok(!joined.includes('also-not'), 'non-TTY stub fail must not print');
  });

  it('single active bar: starting a new one clears the previous', () => {
    const outputs = withTTY(true, () =>
      captureWrites(() => {
        const h1 = renderer.progressBar(0, 1, 'first');
        h1.update(0.1);
        const h2 = renderer.progressBar(0, 1, 'second'); // should clear h1
        h2.update(0.9);
        h2.done('second-done');
      })
    );
    const joined = outputs.join('');
    // We mainly care that we didn't leave garbage and second bar worked
    assert.ok(joined.includes('second-done'), 'second bar should reach done');
  });
});
