#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-models-zl.mjs
// 烛龙产品管线（ZL-product）× 1B/7B/M3 —— 90 题矩阵入口。
// 用法：node --import tsx scripts/eval/longmemeval-90/run-models-zl.mjs [--only 1B,7B,M3] [--limit N] [--force]
// 断点续跑：answers-zl-<model>.jsonl 已有 90 行即跳过；--force 重跑。

import { runPreset } from './run-matrix.mjs';

const args = process.argv.slice(2);
const opt = (f) => {
  const i = args.indexOf(f);
  return i > -1 && i + 1 < args.length ? args[i + 1] : undefined;
};

await runPreset('zl', {
  only: opt('--only')?.split(',').map((x) => x.trim()).filter(Boolean) ?? null,
  limit: opt('--limit') ?? null,
  force: args.includes('--force'),
  repeat: opt('--repeat') ?? 1,
});
