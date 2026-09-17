#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-models-cc-pi.mjs
// 竞品参照格 —— 90 题矩阵入口：
//   CC-90  Claude Code × MiniMax-M3（前置：claude CLI 已配置指向 M3 端点；run-cells 内部
//          以 `claude.cmd --print --model MiniMax-M3` 调用）
//   Pi-90  Pi × 本地 1B（前置：pi CLI 已安装，本地 openpangu 端点在线）
// 用法：node --import tsx scripts/eval/longmemeval-90/run-models-cc-pi.mjs [--only CC-90,Pi-90] [--limit N] [--force]

import { runPreset } from './run-matrix.mjs';

const args = process.argv.slice(2);
const opt = (f) => {
  const i = args.indexOf(f);
  return i > -1 && i + 1 < args.length ? args[i + 1] : undefined;
};

await runPreset('ccpi', {
  only: opt('--only')?.split(',').map((x) => x.trim()).filter(Boolean) ?? null,
  limit: opt('--limit') ?? null,
  force: args.includes('--force'),
  repeat: opt('--repeat') ?? 1,
});
