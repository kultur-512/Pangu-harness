#!/usr/bin/env node
// scripts/eval/longmemeval-90/smoke-90.mjs
// 每题型 1 题（共 6 题）前置冒烟：跑通完整链路后才值得启动 90 题全量
// （7B 单题 ~100s，全量 2.5h/格——冒烟是上全量前的廉价闸门）。
//
// 用法：
//   node --import tsx smoke-90.mjs --kind product [--model M3|1B|7B]        # 产品管线 6 题型各 1 题
//   node --import tsx smoke-90.mjs --kind cell --cell ZL-direct-90 [--model M3]  # 对照格（CC/Pi 亦可，见前置条件）
//   node --import tsx smoke-90.mjs --kind all                                  # 全部格子各 1 模型（M3）
//
// 输出：answers-smoke-<suffix>.jsonl（gitignore 覆盖）；完成后自动跑 grade-matrix 判这 6 题。

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ALIASES, modelEnv } from './run-matrix.mjs';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(DIR, '../../..');

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i > -1 && i + 1 < args.length ? args[i + 1] : undefined; };
const kind = opt('--kind') ?? 'product';
const model = opt('--model') ?? 'M3';
const cell = opt('--cell');

const SMOKE_Q = 'ws/smoke-questions.jsonl';

// 每题型取第 1 题（题目顺序即 sample.mjs 的确定性抽样顺序）
const questions = readFileSync(join(DIR, 'questions.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const byType = new Map();
for (const q of questions) if (!byType.has(q.question_type)) byType.set(q.question_type, q);
const subset = [...byType.values()];
mkdirSync(join(DIR, 'ws'), { recursive: true });
writeFileSync(join(DIR, SMOKE_Q), subset.map(JSON.stringify).join('\n') + '\n', 'utf8');
console.log(`[smoke] 子集 ${subset.length} 题（${[...byType.keys()].join('/')}）→ ${SMOKE_Q}`);

function runOne({ kind2, cellName, label, extraEnv }) {
  const args2 = kind2 === 'product'
    ? ['--import', 'tsx', 'scripts/eval/longmemeval-90/run-product.mjs',
       '--label', label, '--model', MODEL_ALIASES[model] ?? model,
       '--questions', 'scripts/eval/longmemeval-90/' + SMOKE_Q, '--limit', String(subset.length)]
    : ['--import', 'tsx', 'scripts/eval/longmemeval-90/run-cells.mjs',
       '--cell', cellName, '--label', label, '--model', model,
       '--questions', 'scripts/eval/longmemeval-90/' + SMOKE_Q, '--limit', String(subset.length)];
  const t0 = Date.now();
  console.log(`[smoke] run ${label} ...`);
  const r = spawnSync(process.execPath, args2, {
    cwd: REPO, env: { ...modelEnv(model), ...(extraEnv ?? {}) }, stdio: 'inherit', windowsHide: true,
  });
  console.log(`[smoke] ${label} exit=${r.status} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return r.status;
}

const labels = [];
if (kind === 'all') {
  labels.push({ file: `answers-smoke-zl-${model.toLowerCase()}.jsonl` });
  runOne({ kind2: 'product', label: `smoke-zl-${model.toLowerCase()}` });
} else if (kind === 'cell') {
  if (!cell) { console.error('--kind cell 需要 --cell <ID>'); process.exit(2); }
  labels.push({ file: `answers-smoke-${cell}-${model.toLowerCase()}.jsonl` });
  runOne({ kind2: 'cells', cellName: cell, label: `smoke-${cell}-${model.toLowerCase()}` });
} else {
  labels.push({ file: `answers-smoke-zl-${model.toLowerCase()}.jsonl` });
  runOne({ kind2: 'product', label: `smoke-zl-${model.toLowerCase()}` });
}

// 冒烟判分（grade-matrix 复用 grade.mjs 口径）
const files = labels.map((l) => l.file).filter((f) => { try { readFileSync(join(DIR, f)); return true; } catch { return false; } });
if (files.length) {
  const g = spawnSync(process.execPath, ['scripts/eval/longmemeval-90/grade-matrix.mjs', ...files], {
    cwd: REPO, stdio: 'inherit', windowsHide: true,
  });
  if (g.status !== 0) process.exitCode = g.status ?? 1;
} else {
  console.error('[smoke] 无答案文件产出，冒烟失败');
  process.exit(1);
}
