// tests/loop/ErrorSemantics.test.ts
// 0.7.4 任务 B（docs/panshalach/PLAN-0.7.4-FOR-CLAUDECODE.md §2）：
// 中断语义修正——模型/网络/解析异常（含 EMPTY_RESPONSE）不再被伪装成用户中断。
//   B2: syntheticFailureTrajectory 按"真中断 vs 模型异常"区分 stopReason
//       （TASK_ABORTED/AbortError → 'aborted'；其余 → 'error'，lastError 带出）
//   B3: TurnStopReason 契约加性新增 'error'（types.ts / REFACTOR-ASSESSMENT §4 申报）

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PanshalachChaser } from '../../src/PanshalachChaser.js';
import { syntheticFailureTrajectory, isAbortLikeError } from '../../src/loop/trajectory.js';

describe('0.7.4 B2 syntheticFailureTrajectory 异常类别区分', () => {
  it('EMPTY_RESPONSE 异常 → stopReason=error（非 aborted），lastError 保留原始错误', () => {
    const t = syntheticFailureTrajectory(
      'EMPTY_RESPONSE: 端点返回 200 但无有效内容。若使用 diffusion/embedding 类模型……'
    );
    assert.equal(t.stopReason, 'error', '模型故障不得被伪装成用户中断');
    assert.equal(t.success, false);
    assert.ok(t.lastError?.startsWith('EMPTY_RESPONSE'), 'lastError 必须带出原始错误');
  });

  it('TASK_ABORTED 异常 → stopReason=aborted（真中断语义不变）', () => {
    const t = syntheticFailureTrajectory('TASK_ABORTED');
    assert.equal(t.stopReason, 'aborted');
  });

  it('AbortError 异常 → stopReason=aborted', () => {
    const t = syntheticFailureTrajectory('AbortError: This operation was aborted');
    assert.equal(t.stopReason, 'aborted');
  });

  it('未知异常（网络 5xx）→ stopReason=error', () => {
    const t = syntheticFailureTrajectory('complete failed: 500 Internal Server Error');
    assert.equal(t.stopReason, 'error');
  });

  it('isAbortLikeError：三类判定与反例', () => {
    assert.equal(isAbortLikeError('TASK_ABORTED'), true);
    assert.equal(isAbortLikeError('AbortError: aborted'), true);
    assert.equal(isAbortLikeError('aborted before dispatch: write_file'), true);
    assert.equal(isAbortLikeError('EMPTY_RESPONSE: ...'), false);
    assert.equal(isAbortLikeError('complete failed: 500'), false);
    assert.equal(isAbortLikeError(undefined), false);
  });
});

describe('0.7.4 B2 chaser 级 error 轨迹（模型客户端抛异常）', () => {
  it('loop 抛 EMPTY_RESPONSE → solveIssue 返回 stopReason=error + lastError 带出', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pangu-error-'));
    const proto = (await import('../../src/loop/VerifyCritiqueLoop.js')).VerifyCritiqueLoop.prototype as any;
    const origRun = proto.run;
    proto.run = async function () {
      throw new Error('EMPTY_RESPONSE: 端点返回 200 但无有效内容');
    };
    try {
      const chaser = new PanshalachChaser(
        { async complete() { return '模拟回复'; } },
        'standard'
      );
      const result = await chaser.solveIssue('修复 src/a.ts 的 bug 并跑测试', ws, { tier: 'standard' });
      assert.equal(result.success, false);
      assert.equal(result.bestTrajectory?.stopReason, 'error', '模型异常必须落 error 而非 aborted');
      assert.ok(result.bestTrajectory?.lastError?.includes('EMPTY_RESPONSE'), 'lastError 保留原始错误');
      assert.ok(
        (result.budgetReport?.notes ?? []).some((n: string) => n.includes('EMPTY_RESPONSE')),
        'budgetNotes 带出失败原因'
      );
    } finally {
      proto.run = origRun;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('loop 抛 TASK_ABORTED → solveIssue 返回 stopReason=aborted（真中断）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pangu-abort-'));
    const proto = (await import('../../src/loop/VerifyCritiqueLoop.js')).VerifyCritiqueLoop.prototype as any;
    const origRun = proto.run;
    proto.run = async function () {
      const err: any = new Error('TASK_ABORTED');
      err.code = 'ABORTED';
      throw err;
    };
    try {
      const chaser = new PanshalachChaser(
        { async complete() { return '模拟回复'; } },
        'standard'
      );
      const result = await chaser.solveIssue('修复 src/a.ts 的 bug 并跑测试', ws, { tier: 'standard' });
      assert.equal(result.bestTrajectory?.stopReason, 'aborted', 'TASK_ABORTED 保持 aborted 语义');
    } finally {
      proto.run = origRun;
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
