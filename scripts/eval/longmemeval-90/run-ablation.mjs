#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-ablation.mjs
// 记忆消融（审计 E3 落地）：同模型同题两臂，隔离「记忆注入」的净贡献——
//   A 臂 零注入：PANSHA_NO_MEMORY=1（PromptBuilder forceEmptyInjected，播种照旧）
//   B 臂 产品注入：正常管线（recordChatFact 在线播种 + 检索注入）
// 完成后自动 diff-cells 出两臂逐题差异 + grade 对臂口径。
//
// 用法：
//   node --import tsx scripts/eval/longmemeval-90/run-ablation.mjs --model M3 [--limit N] [--force]
//
// 输出：answers-<base>-nomem.jsonl（A）与 answers-<base>.jsonl（B），base = zl-<model 小写>
// 断点续跑：run-product 按 question_id 跳过已完成题。

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ALIASES, modelEnv } from './run-matrix.mjs';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(DIR, '../../..');

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i > -1 && i + 1 < args.length ? args[i + 1] : undefined; };
const model = opt('--model') ?? 'M3';
const limit = opt('--limit') ?? null;
const force = args.includes('--force');
const base = `zl-${String(model).toLowerCase()}`;

function spawnArm(label, extraEnv) {
  const argv2 = ['--import', 'tsx', 'scripts/eval/longmemeval-90/run-product.mjs',
    '--label', label, '--model', MODEL_ALIASES[model] ?? model];
  if (limit) argv2.push('--limit', String(limit));
  const t0 = Date.now();
  console.log(`[ablation] ${label}（${extraEnv ? 'A 零注入' : 'B 产品注入'}）...`);
  const r = spawnSync(process.execPath, argv2, {
    cwd: REPO, env: { ...modelEnv(model), ...(extraEnv ?? {}) }, stdio: 'inherit', windowsHide: true,
  });
  console.log(`[ablation] ${label} exit=${r.status} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return r.status;
}

if (!MODEL_ALIASES[model] && !String(model).includes(':')) {
  console.error('--model 需为 1B/7B/M3 别名或 provider:model 全名');
  process.exit(2);
}

if (force) {
  // --force：清空两臂答案文件重跑（不删 ws，runner 自身按 question_id 续跑）
  const { existsSync, rmSync } = await import('node:fs');
  for (const f of [`answers-${base}-nomem.jsonl`, `answers-${base}.jsonl`]) {
    if (existsSync(`${DIR}/${f}`)) { rmSync(`${DIR}/${f}`); console.log(`[ablation] 删除旧答案 ${f}`); }
  }
}

const ra = spawnArm(`${base}-nomem`, { PANSHA_NO_MEMORY: '1' });
const rb = spawnArm(base);

// 两臂逐题差异 + 判分口径（diff-cells 复用 grade.mjs 判分）
const { existsSync } = await import('node:fs');
const aFile = `answers-${base}-nomem.jsonl`;
const bFile = `answers-${base}.jsonl`;
if (existsSync(`${DIR}/${aFile}`) && existsSync(`${DIR}/${bFile}`)) {
  const d = spawnSync(process.execPath, ['scripts/eval/longmemeval-90/diff-cells.mjs', aFile, bFile,
    '--out', `diff-${base}-ablation.md`], { cwd: REPO, stdio: 'inherit', windowsHide: true });
  console.log(`\n[ablation] 完成。A(零注入) exit=${ra} · B(注入) exit=${rb} · diff exit=${d.status}`);
} else {
  console.log('\n[ablation] 答案文件不齐，跳过 diff（请先解决 runner 报错）');
}
