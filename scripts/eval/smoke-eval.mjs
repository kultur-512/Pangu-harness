#!/usr/bin/env node
// scripts/eval/smoke-eval.mjs
// R6 冒烟测试：mock 模式一键跑通所有 T1-T5，验证 runner 骨架可执行。
//
// 与 run-eval.mjs --mock 的区别：
//   smoke-eval.mjs 是独立的冒烟脚本，硬编码 mock 数据，不依赖任何外部服务。
//   用于 CI gate 快速验证 eval 基建完整性。
//
// 用法：
//   node scripts/eval/smoke-eval.mjs
//
// 退出码：0 = 骨架跑通，非零 = 框架错误

import { resolve, relative } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

const ROOT = resolve(process.cwd());
const MOCK_RESULTS_DIR = resolve(ROOT, 'scripts', 'eval', 'results', 'mock');

// ── Mock 任务 fixture（硬编码，不依赖文件读取） ──

const MOCK_TASKS = [
  { id: 'T1', tier: 'C', title: '约束任务', prompt: '修改 GerundSpinner.ts 帧率' },
  { id: 'T2', tier: 'C', title: '跨文件任务', prompt: '重命名 getConfig → getConfigValue' },
  { id: 'T3', tier: 'C', title: '长文档任务', prompt: '在 sseInteractive.ts 添加日志' },
  { id: 'T4', tier: 'C', title: 'Resume 任务', prompt: '继续之前未完成的任务' },
  { id: 'T5', tier: 'C', title: 'Compact 任务', prompt: '创建 tests/example.test.ts' },
];

// ── Mock 结果生成 ──

function mockResult(task) {
  const runId = randomUUID();
  return {
    runId,
    source: 'mock-smoke',
    tier: task.tier,
    taskId: task.id,
    model: 'mock-7B',
    seedSupport: false,
    timestamp: new Date().toISOString(),
    durationMs: Math.floor(Math.random() * 500) + 50,
    verdict: 'pass',
    verification: {
      signal: 'EXIT_CODE:0',
      exitCode: 0,
      commands: ['npx tsc --noEmit (mock)'],
    },
    memory: {
      injectedCardIds: [`mock-card-${task.id}`],
      verifiedCardIds: [`mock-verified-${task.id}`],
    },
    prompt: {
      chars: task.prompt.length,
      estimatedTokens: Math.ceil(task.prompt.length / 4),
      hash: createHash('sha256').update(task.prompt).digest('hex').slice(0, 8),
    },
    artifacts: {
      trajectory: `mock/trajectories/${task.id}.jsonl`,
      log: `mock/logs/${task.id}.log`,
    },
  };
}

// ── 校验 ──

/**
 * 校验结果是否符合 R6 合同必含字段。
 * @param {object} result
 * @returns {{ valid: boolean, missing: string[] }}
 */
function validateResult(result) {
  const required = [
    'runId', 'source', 'seedSupport', 'verdict',
  ];
  const nested = {
    verification: ['signal', 'exitCode', 'commands'],
    memory: ['injectedCardIds', 'verifiedCardIds'],
    prompt: ['chars', 'estimatedTokens', 'hash'],
  };

  const missing = [];

  for (const key of required) {
    if (result[key] === undefined || result[key] === null) {
      missing.push(key);
    }
  }

  for (const [group, keys] of Object.entries(nested)) {
    if (!result[group]) { missing.push(group); continue; }
    for (const key of keys) {
      if (result[group][key] === undefined || result[group][key] === null) {
        missing.push(`${group}.${key}`);
      }
    }
  }

  // 检查 artifacts（至少有一个产物路径）
  if (!result.artifacts || Object.keys(result.artifacts).length === 0) {
    missing.push('artifacts');
  }

  return { valid: missing.length === 0, missing };
}

// ── 主入口 ──

async function main() {
  console.log('[smoke-eval] R6 冒烟测试启动');
  console.log(`[smoke-eval] 任务数: ${MOCK_TASKS.length}`);

  const results = [];
  let allValid = true;

  for (const task of MOCK_TASKS) {
    console.log(`[smoke-eval] 运行 ${task.id} [${task.tier}] ${task.title}...`);
    const result = mockResult(task);

    // 校验 schema
    const { valid, missing } = validateResult(result);
    if (!valid) {
      console.error(`[smoke-eval] ${task.id} schema 校验失败! 缺少: ${missing.join(', ')}`);
      allValid = false;
    } else {
      console.log(`[smoke-eval] ${task.id} schema 校验通过 (verdict=${result.verdict})`);
    }

    results.push(result);
  }

  // 汇总
  const passed = results.filter(r => r.verdict === 'pass').length;
  const failed = results.filter(r => r.verdict === 'fail').length;
  console.log(`\n[smoke-eval] 汇总: ${results.length} runs | ${passed} pass | ${failed} fail`);

  // 落盘
  await mkdir(MOCK_RESULTS_DIR, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outPath = resolve(MOCK_RESULTS_DIR, `${dateStr}-mock-smoke.json`);

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      source: 'mock-smoke',
      model: 'mock-7B',
      runnerVersion: '0.1.0',
    },
    summary: {
      summaryId: randomUUID(),
      generatedAt: new Date().toISOString(),
      source: 'mock-smoke',
      totalRuns: results.length,
      validSamples: results.length,
      passed,
      failed,
      byTier: {
        C: { total: results.length, passed, failed, invalid: 0, notApplicable: 0 },
      },
      byFailure: {},
      runIds: results.map(r => r.runId),
    },
    results,
  };

  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[smoke-eval] 结果已写入: ${relative(ROOT, outPath)}`);

  if (!allValid) {
    console.error('[smoke-eval] FAILED: schema 校验不通过');
    process.exit(1);
  }

  console.log('[smoke-eval] ALL PASSED');
  process.exit(0);
}

main().catch(e => {
  console.error('[smoke-eval] 致命错误:', e);
  process.exit(2);
});