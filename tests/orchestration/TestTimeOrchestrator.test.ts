// tests/orchestration/TestTimeOrchestrator.test.ts
// D-parallel: runMultiple parallel mode — concurrency, single-failure
// tolerance, budget aggregation, write-mutex serialization.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestTimeOrchestrator, Trajectory } from '../../src/orchestration/TestTimeOrchestrator.js';
import { withWriteLock } from '../../src/tools/engineAdapter.js';

function fakeTraj(id: string, success: boolean, tokens = 100): Trajectory {
  return {
    id,
    success,
    estimatedUsedTokens: tokens,
    steps: [],
    isStrongTarget: false,
  } as any;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TestTimeOrchestrator parallel mode (D-parallel)', () => {
  it('parallel: N rollouts complete concurrently (wall-clock < serial sum)', async () => {
    const o = new TestTimeOrchestrator();
    const t0 = Date.now();
    const best = await o.runMultiple(
      async (id) => { await delay(120); return fakeTraj(id, true); },
      4,
      {},
      { parallel: true }
    );
    const dt = Date.now() - t0;
    assert.ok(dt < 400, `4×120ms serial would be ≥480ms, parallel took ${dt}ms`);
    assert.ok(best && best.success === true);
  });

  it('single-rollout failure does not drag the batch (Promise.allSettled)', async () => {
    const o = new TestTimeOrchestrator();
    const best = await o.runMultiple(
      async (id) => {
        if (id === 'rollout-1') throw new Error('boom');
        return fakeTraj(id, true);
      },
      4,
      {},
      { parallel: true }
    );
    assert.ok(best, 'batch still returns a result');
    assert.equal(best.success, true);
  });

  it('budget aggregation: total over maxTokens drops worst-scoring surplus', async () => {
    const o = new TestTimeOrchestrator();
    const best = await o.runMultiple(
      async (id) => fakeTraj(id, id !== 'rollout-0', 80),
      3,
      { maxTokens: 100 }, // 3×80=240 > 100 → keep only the top scorer(s)
      { parallel: true }
    );
    assert.equal(best.success, true, 'successful rollout survives budget trimming');
  });

  it('serial mode (default) still early-stops on success', async () => {
    const o = new TestTimeOrchestrator();
    let calls = 0;
    await o.runMultiple(async (id) => { calls++; return fakeTraj(id, true); }, 5);
    assert.equal(calls, 1, 'first rollout succeeded → break');
  });
});

describe('withWriteLock (D-parallel write mutex)', () => {
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
