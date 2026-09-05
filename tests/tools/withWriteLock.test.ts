// tests/tools/withWriteLock.test.ts
// 0.7：写互斥回归（原 tests/orchestration/TestTimeOrchestrator.test.ts 的
// withWriteLock 段——编排器已归档，互斥语义仍在 engineAdapter，用例保留）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withWriteLock } from '../../src/tools/engineAdapter.js';

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('withWriteLock (write mutex)', () => {
  it('serializes write operations; failures do not poison the chain', async () => {
    let active = 0;
    let maxActive = 0;
    const results: number[] = [];
    const writes = [1, 2, 3].map((n) =>
      withWriteLock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active--;
        results.push(n);
        if (n === 2) throw new Error('write failed');
        return n;
      })
    );

    const settled = await Promise.allSettled(writes);
    assert.equal(maxActive, 1, 'writes never overlap');
    assert.equal(settled.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 2);
    // chain still usable after a failure
    const after = await withWriteLock(async () => 99);
    assert.equal(after, 99);
    assert.deepEqual(results.sort(), [1, 2, 3]);
  });
});
