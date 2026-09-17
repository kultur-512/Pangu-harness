#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-models-cells.mjs
// ZL-direct / ZL-pipeline / ZL-compact 对照格 × 1B/7B/M3 —— 90 题矩阵入口。
// 用法：node --import tsx scripts/eval/longmemeval-90/run-models-cells.mjs [--only 1B,7B,M3] [--limit N] [--force]
// 说明：CC-90 / Pi-90 见 run-models-cc-pi.mjs；ZL-product 见 run-models-zl.mjs。

import { runPreset } from './run-matrix.mjs';

const args = process.argv.slice(2);
const opt = (f) => {
  const i = args.indexOf(f);
  return i > -1 && i + 1 < args.length ? args[i + 1] : undefined;
};

await runPreset('cells', {
  only: opt('--only')?.split(',').map((x) => x.trim()).filter(Boolean) ?? null,
  limit: opt('--limit') ?? null,
  force: args.includes('--force'),
  repeat: opt('--repeat') ?? 1,
});
