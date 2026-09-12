// tests/eval/run-eval-verdict.test.ts
// R6 follow-up #1: 评测 verdict 传播契约测试。
// 覆盖:
//   1) verdictToEvalVerdict 透传 EVAL_VERDICTS(invalid / not_applicable / pass / fail)
//   2) defaultSeedMemory 结构合法(meta + cards[],对齐 RefinedMemoryCard v3)
//   3) verdict='invalid' 经 validateResult 不被拒(EVAL_VERDICTS 双向兼容)
//   4) failureTaxonomy='memory-not-cited' 经 validateResult 不被拒(FAILURE_PRIMARY 枚举)
//
// R6 评测口径(翟苑皓 9/9 follow-up):B/C/C4 档 0 注入 → verdict='invalid' 直接落源,
// 不再依赖 tags 二次映射 → 下游消费方按 verdict 直接分类。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  verdictToEvalVerdict,
  defaultSeedMemory,
} from '../../scripts/eval/run-eval.mjs';
import { validateResult } from '../../scripts/eval/results/schema.mjs';

describe('verdictToEvalVerdict (R6 合同)', () => {
  it('verdict=invalid 透传 → invalid', () => {
    const r = { verdict: 'invalid', tags: ['line-defense-failed'] };
    assert.equal(verdictToEvalVerdict(r), 'invalid');
  });

  it('verdict=not_applicable 透传 → not_applicable', () => {
    const r = { verdict: 'not_applicable', tags: ['overflow-skipped'] };
    assert.equal(verdictToEvalVerdict(r), 'not_applicable');
  });

  it('verdict=completed → pass', () => {
    const r = { verdict: 'completed', tags: [] };
    assert.equal(verdictToEvalVerdict(r), 'pass');
  });

  it('verdict=no-verification → fail', () => {
    const r = { verdict: 'no-verification', tags: [] };
    assert.equal(verdictToEvalVerdict(r), 'fail');
  });

  it('verdict=aborted → fail', () => {
    const r = { verdict: 'aborted', tags: [] };
    assert.equal(verdictToEvalVerdict(r), 'fail');
  });

  it('verdict=answered → fail(answered不计入pass防线)', () => {
    const r = { verdict: 'answered', tags: [] };
    assert.equal(verdictToEvalVerdict(r), 'fail');
  });

  it('verdict=undefined → fail(防御)', () => {
    const r = { tags: [] };
    assert.equal(verdictToEvalVerdict(r), 'fail');
  });
});

describe('defaultSeedMemory (R6 follow-up #1)', () => {
  it('结构合法:meta + cards[] 含 2 张合成卡', () => {
    const seed = defaultSeedMemory(1700000000000);
    assert.ok(seed.meta, '有 meta');
    assert.equal(seed.meta.totalCards, 2);
    assert.equal(seed.cards.length, 2);
  });

  it('卡字段对齐 RefinedMemoryCard v3 记忆卡 schema', () => {
    const seed = defaultSeedMemory(1700000000000);
    for (const c of seed.cards) {
      assert.ok(typeof c.id === 'string' && c.id.length > 0, 'id 非空');
      assert.ok(['success', 'lesson', 'constraint'].includes(c.kind), `kind 合法: ${c.kind}`);
      assert.ok(typeof c.summary === 'string' && c.summary.length > 0, 'summary 非空');
      assert.equal(typeof c.weight, 'number');
      assert.equal(typeof c.decayWeight, 'number');
      assert.equal(typeof c.lastSeen, 'number');
      assert.equal(typeof c.firstSeen, 'number');
      assert.equal(typeof c.lastUsedAt, 'number');
      assert.ok(Array.isArray(c.applicableTiers), 'applicableTiers 数组');
      assert.equal(c.taskStyle, 'all');
    }
  });

  it('种子卡 ID 稳定,便于快照比对', () => {
    const s1 = defaultSeedMemory(1700000000000);
    const s2 = defaultSeedMemory(1700000000001);  // 不同 now
    assert.equal(s1.cards[0].id, s2.cards[0].id, 'id 跨调用稳定');
    assert.equal(s1.cards[1].id, s2.cards[1].id);
    assert.equal(s1.cards[0].id, 'seed-success-001');
    assert.equal(s1.cards[1].id, 'seed-lesson-001');
  });

  it('种子卡 summary 含【seed】前缀,提醒用户传 --seed-memory 覆盖', () => {
    const seed = defaultSeedMemory(1700000000000);
    for (const c of seed.cards) {
      assert.ok(c.summary.startsWith('【seed】'), `summary 含 seed 标记: ${c.summary}`);
    }
  });
});

describe('validateResult 兼容 verdict=EVAL_VERDICTS (R6 合同)', () => {
  it('verdict=invalid 接受(双方言兼容)', () => {
    const r = {
      runId: 'test-001',
      source: 'real-openpangu',
      ablation: 'B',
      taskId: 'T1-b-42',
      taskFamily: 'T1',
      seed: 42,
      verdict: 'invalid',
      tags: ['line-defense-failed'],
      memory: { injectedCardIds: [], verifiedCardIds: [] },
      verification: { signal: 'NO_VERIFICATION', exitCode: 0, commands: [] },
      prompt: { chars: 100, estimatedTokens: 25, hash: 'h' },
      failureTaxonomy: { primary: 'memory-not-cited' },
      refined: { added: 0, merged: 0, written: 0, capped: 0 },
      artifacts: {},
      attemptCount: 1,
      stopReason: 'no-verification',
      panshalachVersion: '0.7.4',
      modelId: 'openPangu-7B',
      startedAt: '2026-09-09T00:00:00.000Z',
      finishedAt: '2026-09-09T00:01:00.000Z',
      durationMs: 60000,
    };
    const v = validateResult(r);
    assert.equal(v.ok, true, `errors: ${v.errors.join('; ')}`);
  });

  it('verdict=not_applicable 接受', () => {
    const r = {
      runId: 'test-002',
      source: 'real-openpangu',
      ablation: 'A',
      taskId: 'T1-a-42',
      taskFamily: 'T1',
      seed: 42,
      verdict: 'not_applicable',
      tags: ['overflow-skipped'],
      memory: { injectedCardIds: [], verifiedCardIds: [] },
      verification: { signal: 'NO_VERIFICATION', exitCode: 0, commands: [] },
      prompt: { chars: 100, estimatedTokens: 25, hash: 'h' },
      failureTaxonomy: { primary: 'no-verification', secondary: 'prompt-too-short' },
      refined: { added: 0, merged: 0, written: 0, capped: 0 },
      artifacts: {},
      attemptCount: 1,
      stopReason: 'no-verification',
      panshalachVersion: '0.7.4',
      modelId: 'openPangu-7B',
      startedAt: '2026-09-09T00:00:00.000Z',
      finishedAt: '2026-09-09T00:01:00.000Z',
      durationMs: 60000,
    };
    const v = validateResult(r);
    assert.equal(v.ok, true, `errors: ${v.errors.join('; ')}`);
  });

  it('failureTaxonomy=memory-not-cited 接受(FAILURE_PRIMARY 枚举)', () => {
    const r = {
      runId: 'test-003',
      source: 'real-openpangu',
      ablation: 'B',
      taskId: 'T1-b-43',
      taskFamily: 'T1',
      seed: 42,
      verdict: 'invalid',
      tags: ['line-defense-failed'],
      memory: { injectedCardIds: [], verifiedCardIds: [] },
      verification: { signal: 'NO_VERIFICATION', exitCode: 0, commands: [] },
      prompt: { chars: 100, estimatedTokens: 25, hash: 'h' },
      failureTaxonomy: { primary: 'memory-not-cited' },
      refined: { added: 0, merged: 0, written: 0, capped: 0 },
      artifacts: {},
      attemptCount: 1,
      stopReason: 'no-verification',
      panshalachVersion: '0.7.4',
      modelId: 'openPangu-7B',
      startedAt: '2026-09-09T00:00:00.000Z',
      finishedAt: '2026-09-09T00:01:00.000Z',
      durationMs: 60000,
    };
    const v = validateResult(r);
    assert.equal(v.ok, true, `errors: ${v.errors.join('; ')}`);
  });
});