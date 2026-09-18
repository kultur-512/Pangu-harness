#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-matrix.mjs
// 90 题 harness × 模型矩阵驱动（2026-09-17，审计 E1/E3 配套基建）：
//   逐格 spawn 对应 runner，断点续跑（各 runner 自行跳过已完成题），
//   结束后写 matrix-summary-<preset>.json（gitignore 覆盖，不入库）并打印矩阵。
//
// 预设：
//   zl    烛龙产品管线（run-product.mjs）× 1B/7B/M3
//   cells ZL-direct / ZL-pipeline / ZL-compact（run-cells.mjs）× 1B/7B/M3
//   ccpi  CC-90（Claude Code × M3，需 claude CLI 指向 M3 端点）+ Pi-90（Pi × 1B）
//   all   以上全部
//
// 用法：
//   node --import tsx scripts/eval/longmemeval-90/run-matrix.mjs --preset zl [--only 1B,M3] [--limit 3] [--force]
//   node --import tsx scripts/eval/longmemeval-90/run-models-zl.mjs   # 同 preset zl（入口别名）
//
// 环境：
//   1B/7B → 本地 LM Studio openpangu 端点（localhost:1234，ModelProvider 配置同 .panshalach.json）
//   M3   → MINIMAX_API_KEY（或 PANSHA_MINIMAX_API_KEY 三件套）
//   所有子进程注入 PANSHA_EVAL=1（评测豁免：不向任何工作区落记忆卡）

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_MAIN = (() => {
  try { return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; }
})();

const DIR = resolve(dirname(fileURLToPath(import.meta.url)));
// run-product.mjs 以 process.cwd() 推导仓库根（ROOT/DIR），必须从仓库根启动、
// 传仓库相对路径；run-cells.mjs 用 import.meta.url 推导，cwd 无关，但同样从根启动保持同源。
const REPO = resolve(DIR, '../../..');

export const MODEL_ALIASES = {
  '1B': 'openpangu:openpangu-embedded-1b-i1',
  '7B': 'openpangu:openpangu7b-with-medusa',
  'M3': 'minimax:MiniMax-M3',
};

// 格子定义：kind=product → run-product.mjs（产品管线）；kind=cells → run-cells.mjs（对照格）
const PRESETS = {
  zl: ['1B', '7B', 'M3'].map((m) => ({
    kind: 'product', harness: 'ZL-product', label: `zl-${m.toLowerCase()}`, model: m,
  })),
  cells: ['ZL-direct-90', 'ZL-pipeline-90', 'ZL-compact-90'].flatMap((cell) =>
    ['1B', '7B', 'M3'].map((m) => ({
      kind: 'cells', harness: cell, label: `${cell}-${m.toLowerCase()}`, cell, model: m,
    }))),
  ccpi: [
    { kind: 'cells', harness: 'CC-90', label: 'CC-90', cell: 'CC-90', model: 'M3' },
    { kind: 'cells', harness: 'Pi-90', label: 'Pi-90', cell: 'Pi-90', model: '1B' },
  ],
};

function parseArgs() {
  const a = process.argv.slice(2);
  const opt = (flag) => {
    const i = a.indexOf(flag);
    return i > -1 && i + 1 < a.length ? a[i + 1] : undefined;
  };
  return {
    preset: opt('--preset') ?? 'zl',
    only: opt('--only')?.split(',').map((x) => x.trim()).filter(Boolean) ?? null,
    limit: opt('--limit') ?? null,
    force: a.includes('--force'),
    repeat: Math.max(1, Number(opt('--repeat') ?? 1)),
  };
}

/** M3 网关三件套：优先 PANSHA_ 系，回落 MINIMAX_ 系（env-only provider 发现依赖 PANSHA_<U>_API_KEY） */
export function modelEnv(model) {
  const str = MODEL_ALIASES[model] ?? model;
  const env = {
    ...process.env,
    PANSHA_MODEL: str,
    PANSHA_EVAL: '1',
    // 对比价值纪律：统一单题超时预算——run-product 缺省 180s 而 run-cells 600s，
    // 7B 单题 ~100s，端点拥塞时产品管线会被不公平击杀。矩阵运行统一到 600s。
    PANSHA_LME_TIMEOUT_MS: process.env.PANSHA_LME_TIMEOUT_MS || '600000',
  };
  if (String(str).startsWith('minimax:')) {
    env.PANSHA_MINIMAX_API_KEY = process.env.PANSHA_MINIMAX_API_KEY || process.env.MINIMAX_API_KEY || '';
    env.PANSHA_MINIMAX_BASE_URL = process.env.PANSHA_MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1';
    env.PANSHA_MINIMAX_MODEL = process.env.PANSHA_MINIMAX_MODEL || 'MiniMax-M3';
  }
  return env;
}

function countDone(label) {
  const f = join(DIR, `answers-${label}.jsonl`);
  if (!existsSync(f)) return 0;
  try {
    return readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).length;
  } catch { return 0; }
}

function runCell(cell, opts) {
  const done = countDone(cell.label);
  const target = opts.limit ? Math.min(90, Number(opts.limit)) : 90;
  if (!opts.force && done >= target) {
    console.log(`[matrix] skip ${cell.label} (${done} done ≥ ${target})`);
    return { label: cell.label, harness: cell.harness, model: cell.model, done, skipped: true };
  }
  const args = cell.kind === 'product'
    ? ['--import', 'tsx', 'scripts/eval/longmemeval-90/run-product.mjs', '--label', cell.label, '--model', MODEL_ALIASES[cell.model] ?? cell.model]
    : ['--import', 'tsx', 'scripts/eval/longmemeval-90/run-cells.mjs', '--cell', cell.cell, '--label', cell.label, '--model', cell.model];
  if (opts.limit) args.push('--limit', String(opts.limit));
  const t0 = Date.now();
  console.log(`[matrix] run ${cell.label} (harness=${cell.harness} model=${cell.model}) ...`);
  const r = spawnSync(process.execPath, args, {
    cwd: REPO, env: modelEnv(cell.model), stdio: 'inherit', windowsHide: true,
  });
  const ms = Date.now() - t0;
  const after = countDone(cell.label);
  console.log(`[matrix] ${cell.label} exit=${r.status} +${after - done} 行 (${(ms / 1000).toFixed(0)}s)`);
  return { label: cell.label, harness: cell.harness, model: cell.model, done: after, ms, exit: r.status };
}

export async function runPreset(presetName, opts = {}) {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`unknown preset: ${presetName}（可用：${Object.keys(PRESETS).join('/')}）`);
  // 重复臂（对比价值纪律：单次运行方差 ±3，差距 <5 分不可信）——
  // --repeat N 把每格展开为 label-r1..label-rN 独立臂，供 grade-matrix 聚合均值/极差。
  const repeats = Math.max(1, Number(opts.repeat ?? 1));
  let cells = preset.flatMap((c) =>
    repeats > 1
      ? Array.from({ length: repeats }, (_, i) => ({ ...c, label: `${c.label}-r${i + 1}`, baseLabel: c.label }))
      : [{ ...c, baseLabel: c.label }]);
  cells = opts.only
    ? cells.filter((c) => (opts.only ?? []).includes(c.model) || (opts.only ?? []).includes(c.label) || (opts.only ?? []).includes(c.cell ?? ''))
    : cells;
  if (!cells.length) throw new Error('--only 过滤后无格子');
  const summary = [];
  for (const cell of cells) summary.push(runCell(cell, opts));
  const sumFile = join(DIR, `matrix-summary-${presetName}.json`);
  writeFileSync(sumFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`\n[matrix] 汇总（${presetName}${repeats > 1 ? `，${repeats} 次重复` : ''}）:`);
  for (const s of summary) {
    console.log(`  ${String(s.label).padEnd(28)} done=${s.done}${s.exit != null ? ` exit=${s.exit}` : ''}${s.skipped ? ' (skipped)' : ''}`);
  }
  console.log(`[matrix] summary → ${sumFile}`);
  return summary;
}

if (IS_MAIN) {
  const opts = parseArgs();
  if (!PRESETS[opts.preset]) {
    console.error('用法: run-matrix.mjs --preset zl|cells|ccpi|all [--only 1B,M3] [--limit N] [--force]');
    process.exit(2);
  }
  const names = opts.preset === 'all' ? Object.keys(PRESETS) : [opts.preset];
  for (const n of names) await runPreset(n, opts);
}
