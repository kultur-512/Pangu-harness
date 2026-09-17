#!/usr/bin/env node
// scripts/eval/longmemeval-90/matrix-status.mjs
// 无执行进度报告：列出本目录 answers-*.jsonl 的完成度/耗时/预计剩余，
// 用于长跑（7B 单题 ~100s、全量 2.5h/格）期间快速查看各格进度与 ETA。
//
// 用法：node scripts/eval/longmemeval-90/matrix-status.mjs [answers-*.jsonl ...]  # 缺省全部

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const requested = process.argv.slice(2).map((f) => basename(f.replace(/\\/g, '/')));
const files = requested.length
  ? requested
  : readdirSync(DIR).filter((f) => /^answers-.*\.jsonl$/.test(f)).sort();

console.log('\n[matrix-status] 进度（目标 90 题）：');
console.log('| 格 | done | % | 平均ms | 最后ms | 预计剩余 |');
console.log('|---|---|---|---|---|---|');
for (const f of files) {
  const p = join(DIR, f);
  if (!existsSync(p)) continue;
  const rows = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const msList = rows.map((r) => r.ms).filter((m) => typeof m === 'number' && m > 0);
  const avg = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : null;
  const last = msList.length ? msList[msList.length - 1] : null;
  const etaMin = avg && rows.length < 90 ? Math.round(((90 - rows.length) * avg) / 60000) : null;
  console.log(`| ${f} | ${rows.length} | ${((rows.length / 90) * 100).toFixed(0)}% | ${avg ?? '-'} | ${last ?? '-'} | ${etaMin != null ? etaMin + 'min' : '—'} |`);
}
