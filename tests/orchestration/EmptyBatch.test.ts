// tests/orchestration/EmptyBatch.test.ts
// 改动包 B（对抗清单 #1）：全部 rollout 失败 → 合成失败轨迹（不再返回 undefined），
// lastError 保留，chaser 不再 TypeError。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestTimeOrchestrator } from '../../src/orchestration/TestTimeOrchestrator.js';

describe('orchestrator 空批保护（改动包 B）', () => {
  it('全部 rollout 抛错 → 合成失败轨迹 + lastError', async () => {
    const o = new TestTimeOrchestrator();
    const best = await o.runMultiple(
      async () => { throw new Error('boom: network glitch'); },
      2
    );
    assert.ok(best, '绝不返回 undefined');
    assert.equal(best.success, false);
    assert.equal(best.id, 'rollout-all-failed');
    assert.ok(best.lastError?.includes('boom'), `lastError 保留，got ${best.lastError}`);
  });

  it('部分失败仍返回成功轨迹（原有语义不变）', async () => {
    const o = new TestTimeOrchestrator();
    const best = await o.runMultiple(
      async (id) => {
        if (id === 'rollout-0') throw new Error('first fails');
        return { id, steps: [], success: true } as any;
      },
      2
    );
    assert.ok(best);
    assert.equal(best.success, true);
  });
});
