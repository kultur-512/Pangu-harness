// scripts/eval/smoke-eval.mjs
// Mock 模式自检：跑通 A/B/C/C4 × T1-T5 stub，验证 schema + writer 不退化。
//
// 路径隔离：smoke 结果落 results/smoke-<date>.json（永不进真实结果表）。
//
// 用法：
//   node scripts/eval/smoke-eval.mjs           # 默认今天
//   node scripts/eval/smoke-eval.mjs --dry     # 只打印，不写盘
//
// 退出码：
//   0  全绿
//   1  schema 校验失败
//   2  writer 失败

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ABLATIONS,
  newResult,
  validateResult,
  hashPrompt,
  stopwatch,
} from './results/schema.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(ROOT, 'scripts', 'eval', 'results');

const DRY = process.argv.includes('--dry');
const TODAY = new Date().toISOString().slice(0, 10);

/**
 * Mock 一个任务族 + ablation 的合成结果。
 * 不调任何模型，纯 schema 填充 + 字段语义演示。
 */
function mockResult({ ablation, taskFamily, taskId, seed }) {
  const r = newResult({
    source: 'mock-smoke',
    ablation,
    taskFamily,
    taskId,
    seed,
    seedSupport: true,
    modelId: 'mock://smoke',
  });

  const sw = stopwatch();
  const prompt = `[mock] ${taskFamily} ${ablation} seed=${seed}`;
  r.prompt = {
    chars: prompt.length,
    estimatedTokens: Math.ceil(prompt.length / 4),
    hash: hashPrompt(prompt),
  };

  // 每档 ablation 的语义演示
  switch (ablation) {
    case 'A':
      // baseline — 必须真溢出；mock 直接标 overflow-skipped（演示，不进长程结论）
      r.verdict = 'no-verification';
      r.stopReason = 'no-verification';
      r.failureTaxonomy = 'overflow-skipped';
      r.tags.push('overflow-skipped', 'mock-no-real-overflow');
      // attemptCount 缺省 → 强制 no-verification（防"一次通过"伪造）
      break;
    case 'B':
      // memory on — 必须有 injectedCardIds >= 1
      r.verdict = 'completed';
      r.stopReason = 'completed';
      r.attemptCount = 1;  // 显式传 1 → 可标 completed
      r.memory.injectedCardIds = [`card-${taskFamily}-001`, `card-${taskFamily}-002`];
      r.memory.verifiedCardIds = [`card-${taskFamily}-001`];  // ∩ provenFiles 非空
      r.verification = { signal: 'PASS', exitCode: 0, commands: [`mock-verify-${taskFamily}`] };
      r.refined = { added: 1, merged: 0, written: 1, capped: 0 };
      break;
    case 'C':
      // B + 注入预算
      r.verdict = 'completed';
      r.stopReason = 'completed';
      r.attemptCount = 1;
      r.memory.injectedCardIds = [`card-${taskFamily}-001`];
      r.memory.verifiedCardIds = [`card-${taskFamily}-001`];
      r.verification = { signal: 'ALL_TESTS_PASSED', exitCode: 0, commands: [`mock-budget-${taskFamily}`] };
      r.refined = { added: 1, merged: 1, written: 2, capped: 0 };
      r.tags.push('budget-active');
      break;
    case 'C4':
      // B + 语义检索
      r.verdict = 'completed';
      r.stopReason = 'completed';
      r.attemptCount = 1;
      r.memory.injectedCardIds = [`card-${taskFamily}-sem-001`];
      r.memory.verifiedCardIds = [`card-${taskFamily}-sem-001`];
      r.verification = { signal: 'PASS', exitCode: 0, commands: [`mock-semantic-${taskFamily}`] };
      r.refined = { added: 1, merged: 0, written: 1, capped: 0 };
      r.tags.push('semantic-retrieval');
      break;
  }

  // T4 (resume) 演示 continueCount
  if (taskFamily === 'T4') {
    r.continueCount = 1;
    r.tags.push('resumed');
  }

  r.durationMs = sw();
  r.finishedAt = new Date().toISOString();
  r.artifacts = { rolloutJsonl: `results/${r.runId}/rollout.jsonl` };
  return r;
}

function main() {
  const families = /** @type {const} */ (['T1', 'T2', 'T3', 'T4', 'T5']);
  const ablations = /** @type {const} */ (['A', 'B', 'C', 'C4']);
  const seed = 42;

  const results = [];
  const errors = [];
  let total = 0;

  for (const ablation of ablations) {
    for (const taskFamily of families) {
      total++;
      const taskId = `${taskFamily}-${ablation.toLowerCase()}-${seed}`;
      const r = mockResult({ ablation, taskFamily, taskId, seed });
      const v = validateResult(r);
      if (!v.ok) {
        errors.push({ runId: r.runId, taskId, errors: v.errors });
        continue;
      }
      results.push(r);
    }
  }

  // 摘要
  const byAblation = {};
  for (const r of results) {
    byAblation[r.ablation] = (byAblation[r.ablation] || 0) + 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    source: 'mock-smoke',
    total,
    passed: results.length,
    failed: errors.length,
    byAblation,
    ablations: ABLATIONS,
    results,
    errors,
  };

  console.log(`[smoke-eval] generated=${total} passed=${results.length} failed=${errors.length}`);
  console.log(`[smoke-eval] byAblation: ${JSON.stringify(byAblation)}`);

  if (errors.length > 0) {
    console.error('[smoke-eval] schema validation errors:');
    for (const e of errors) console.error(' -', e.taskId, e.errors.join('; '));
    process.exit(1);
  }

  if (DRY) {
    console.log('[smoke-eval] DRY mode — not writing');
    return;
  }

  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  } catch (e) {
    console.error(`[smoke-eval] mkdir failed: ${e.message}`);
    process.exit(2);
  }

  const outPath = path.join(RESULTS_DIR, `smoke-${TODAY}.json`);
  try {
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`[smoke-eval] wrote ${outPath}`);
  } catch (e) {
    console.error(`[smoke-eval] write failed: ${e.message}`);
    process.exit(2);
  }
}

main();
