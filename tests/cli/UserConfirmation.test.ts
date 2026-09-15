// tests/cli/UserConfirmation.test.ts
// P2: waitForUserConfirmation 无 TTY 保护 —— process.stdin.isTTY 为假时必须
// 立即按否决 resolve（不 resume、不挂起、不吞管道输入）。

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { waitForUserConfirmation } from '../../src/cli/UserConfirmation.js';

function setStdinTty(v: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true, writable: true });
}

describe('waitForUserConfirmation non-TTY guard', () => {
  afterEach(() => {
    setStdinTty(undefined);
    try { process.stdin.pause(); } catch {}
  });

  it('resolves immediately as declined when stdin is not a TTY (no resume, no hang)', async () => {
    setStdinTty(undefined); // 强制非交互（管道/CI 场景）
    const t0 = Date.now();
    const result = await Promise.race([
      waitForUserConfirmation('确认继续？[yes/no]: '),
      new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), 3000)),
    ]);
    assert.notEqual(result, 'HUNG', 'must not hang waiting on stdin in a non-TTY environment');
    assert.equal((result as any).confirmed, false, 'non-TTY must resolve as declined');
    assert.match((result as any).reason, /non-interactive|非交互/i, `expected explicit non-interactive reason, got: ${(result as any).reason}`);
    assert.ok(Date.now() - t0 < 2500, `must resolve immediately, took ${Date.now() - t0}ms`);
    assert.notEqual((process.stdin as any).readableFlowing, true, 'must not resume stdin');
  });

  it('still declines (not resolves-yes) when isTTY is explicitly false', async () => {
    setStdinTty(false);
    const result = await Promise.race([
      waitForUserConfirmation(),
      new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), 3000)),
    ]);
    assert.notEqual(result, 'HUNG');
    assert.equal((result as any).confirmed, false);
  });
});
