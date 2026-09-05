// scripts/eval/results/schema.mjs
// 评测结果契约单一源（scripts/eval/* 与下游消费方共读）。
//
// 字段来源：
//   1. ROADMAP-NEXT §3.1 R6 合同（runId/source/seedSupport/verdict/verification/memory/prompt/failureTaxonomy/artifacts）
//   2. v0.6.4 接口契约 v3.1 双层终止语义（TurnStopReason 6 态 + continueCount + lastError）
//
// 约束：
//   - TurnStopReason 6 态从此处导出；与 src/cli/repl/types.ts 同步，改动需双向更新。
//   - failureTaxonomy 运行前冻结（运行时不允许新增分类）。
//   - A 档必须真溢出（不溢出的样本标"不适用"，不进长程结论）。
//   - B 档零注入 = 防线失败，不计为有效样本。
//   - mock 永不入真实结果表（路径隔离：results/smoke-*.json vs results/<date>.json）。
//
// 用法：
//   import { TURN_STOP_REASONS, RESULT_SCHEMA, validateResult } from './schema.mjs';

import { createHash, randomUUID } from 'node:crypto';

/** 双层终止语义 6 态（与 src/cli/repl/types.ts TurnStopReason 同步） */
export const TURN_STOP_REASONS = Object.freeze([
  'completed',                    // end_turn 且轨迹含验证 PASS
  'verification-failed-continue', // 判官拦截续跑（本轮结束但任务未完）
  'max-steps',                    // 步数耗尽
  'consecutive-failures',         // 连续工具失败保护
  'aborted',                      // 用户/信号中止
  'no-verification',             // end_turn 但从未产生 PASS（信息型）
]);

/** 评测源（隔离 mock 与真模型） */
export const EVAL_SOURCES = Object.freeze(['real-openpangu', 'mock-smoke']);

/** 消融档（A/B/C/C4 来自 ROADMAP-NEXT §3.1 R6 合同） */
export const ABLATIONS = Object.freeze({
  A:  'baseline (no memory, no refine) — must overflow',
  B:  'memory on (refine + markVerified) — zero-injection is line-defense failure',
  C:  'B + injection budget (L0/L1 contracts)',
  C4: 'B + semantic retrieval (n-gram, R7)',
});

/** 失败分类枚举（运行前冻结；运行时新增需改本文件 + ROADMAP-NEXT §3.1） */
export const FAILURE_TAXONOMY = Object.freeze([
  'none',                    // 无失败（success=true）
  'verification-failed',     // 验证未通过
  'tool-error',              // 工具执行错误
  'parse-failed',            // 输出解析失败
  'budget-exhausted',        // 步数/token 耗尽
  'aborted',                 // 用户/信号中止
  'overflow-skipped',        // A 档未溢出，标"不适用"（不进长程结论）
  'line-defense-failed',     // B 档零注入，防线失败（不计为有效样本）
  'unknown',                 // 未分类（需 lastError 透出）
]);

/** 已知验证信号（沿用 verify-critique-loop 已有语义） */
export const VERIFICATION_SIGNALS = Object.freeze([
  'PASS',
  'FAIL',
  'ALL_TESTS_PASSED',
  'TESTS_FAILED',
  'NO_VERIFICATION',
  'UNKNOWN',
]);

/** 一条评测结果的最小契约（每条任务实例 = 一个统计单位） */
export const RESULT_SCHEMA = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'panshalach.eval.result.v1',
  title: 'Panshalach Eval Result',
  type: 'object',
  required: ['runId', 'source', 'ablation', 'taskId', 'taskFamily', 'seed', 'verdict'],
  additionalProperties: false,
  properties: {
    runId:           { type: 'string', description: 'UUID v4' },
    source:          { enum: [...EVAL_SOURCES] },
    ablation:        { enum: Object.keys(ABLATIONS) },
    taskId:          { type: 'string', description: '任务实例 ID（T1/T2/T3/T4/T5 族内唯一）' },
    taskFamily:      { enum: ['T1', 'T2', 'T3', 'T4', 'T5'] },
    seed:            { type: 'integer', description: '随机种子（seedSupport 用）' },
    seedSupport:     { type: 'boolean', description: '是否同 seed 跨 ablation 对齐' },
    modelId:         { type: 'string', description: '实际跑的模型标识（含 provider 前缀）' },
    startedAt:       { type: 'string', format: 'date-time' },
    finishedAt:      { type: 'string', format: 'date-time' },
    durationMs:      { type: 'integer', minimum: 0 },
    verdict:         { enum: [...TURN_STOP_REASONS] },
    verification: {
      type: 'object',
      additionalProperties: false,
      properties: {
        signal:   { enum: [...VERIFICATION_SIGNALS] },
        exitCode: { type: 'integer' },
        commands: { type: 'array', items: { type: 'string' } },
      },
    },
    memory: {
      type: 'object',
      additionalProperties: false,
      properties: {
        injectedCardIds:  { type: 'array', items: { type: 'string' } },
        verifiedCardIds:  { type: 'array', items: { type: 'string' } },
      },
    },
    prompt: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chars:           { type: 'integer', minimum: 0 },
        estimatedTokens: { type: 'integer', minimum: 0 },
        hash:            { type: 'string', description: 'SHA-256 of normalized prompt' },
      },
    },
    stopReason:      { enum: [...TURN_STOP_REASONS] },
    continueCount:   { type: 'integer', minimum: 0, description: '判官拦截续跑次数（0 = 未续跑）' },
    lastError:       { type: 'string', description: '单 rollout 失败保留的最后错误' },
    failureTaxonomy: { enum: [...FAILURE_TAXONOMY] },
    artifacts: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rolloutJsonl: { type: 'string', description: '相对路径（指向 results/<runId>/rollout.jsonl）' },
        traceJson:    { type: 'string' },
        stdoutTail:   { type: 'string' },
      },
    },
    tags: { type: 'array', items: { type: 'string' }, description: '自由标签（如 overflow-skipped / line-defense-failed）' },
  },
});

/**
 * 轻量 runtime 校验（无 ajv 依赖）。仅检查 required + 类型 + enum。
 * 严格 JSON Schema 校验留给 U6 接入 ajv 后再做。
 *
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateResult(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['result must be a non-null object'] };
  }
  const r = /** @type {any} */ (obj);
  for (const k of RESULT_SCHEMA.required) {
    if (r[k] === undefined) errors.push(`missing required field: ${k}`);
  }
  if (r.source !== undefined && !EVAL_SOURCES.includes(r.source)) {
    errors.push(`invalid source: ${r.source} (expected one of ${EVAL_SOURCES.join('|')})`);
  }
  if (r.verdict !== undefined && !TURN_STOP_REASONS.includes(r.verdict)) {
    errors.push(`invalid verdict: ${r.verdict}`);
  }
  if (r.ablation !== undefined && !(r.ablation in ABLATIONS)) {
    errors.push(`invalid ablation: ${r.ablation}`);
  }
  if (r.taskFamily !== undefined && !['T1', 'T2', 'T3', 'T4', 'T5'].includes(r.taskFamily)) {
    errors.push(`invalid taskFamily: ${r.taskFamily}`);
  }
  if (r.failureTaxonomy !== undefined && !FAILURE_TAXONOMY.includes(r.failureTaxonomy)) {
    errors.push(`invalid failureTaxonomy: ${r.failureTaxonomy}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 工厂：生成一条空的 result 骨架（调用方填充字段）。
 * @param {{ source: 'real-openpangu' | 'mock-smoke', ablation: keyof typeof ABLATIONS, taskFamily: 'T1'|'T2'|'T3'|'T4'|'T5', taskId: string, seed: number, seedSupport?: boolean, modelId?: string }} init
 */
export function newResult(init) {
  const startedAt = new Date().toISOString();
  return {
    runId: randomUUID(),
    source: init.source,
    ablation: init.ablation,
    taskId: init.taskId,
    taskFamily: init.taskFamily,
    seed: init.seed,
    seedSupport: init.seedSupport ?? true,
    modelId: init.modelId ?? 'unknown',
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    verdict: 'no-verification',
    verification: { signal: 'NO_VERIFICATION', exitCode: 0, commands: [] },
    memory: { injectedCardIds: [], verifiedCardIds: [] },
    prompt: { chars: 0, estimatedTokens: 0, hash: '' },
    continueCount: 0,
    failureTaxonomy: 'none',
    artifacts: {},
    tags: [],
  };
}

/** SHA-256 哈希（用于 prompt.hash） */
export function hashPrompt(s) {
  return createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
}

/** 简易时间窗采样（用于 durationMs） */
export function stopwatch() {
  const t0 = Date.now();
  return () => Date.now() - t0;
}
