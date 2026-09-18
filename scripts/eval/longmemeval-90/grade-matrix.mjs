#!/usr/bin/env node
// scripts/eval/longmemeval-90/grade-matrix.mjs
// 90 题矩阵统一判分（2026-09-17，审计 E1 配套）：复用 grade.mjs 判分口径
// （strict 主口径 + lenient 数字回退；gold 以 questions.jsonl 为唯一正源），
// 对一批 answers-*.jsonl 逐格算分，输出矩阵表 + matrix-grades.json（gitignore 覆盖，不入库）。
//
// 对比价值纪律（2026-09-17 补）：
//   --repeat 聚合   同一格 label-r1..rN 的重复臂聚合为均值 + 极差（单次运行方差 ±3，
//                   差距 <5 分不可信——看均值与极差再下结论）。
//   --exclude-type  剔除判分盲区题型（single-session-preference 全格 ≤3/15，
//                   子串判分对其无区分度；剔除后比较其余 5 题型）。
//
// 用法：
//   node scripts/eval/longmemeval-90/grade-matrix.mjs                        # 本目录全部 answers-*.jsonl
//   node scripts/eval/longmemeval-90/grade-matrix.mjs answers-zl-m3-r1.jsonl answers-zl-m3-r2.jsonl --repeat
//   node scripts/eval/longmemeval-90/grade-matrix.mjs answers-*.jsonl --exclude-type single-session-preference
//
// 说明：与 grade.mjs 单格口径一致（strict/lenient 逐题同函数）；本脚本只做多格聚合，
//       不复刻判分逻辑——判分口径变更只改 grade.mjs 一处。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeStrict, gradeLenient, loadAnswers } from './grade.mjs';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const exIdx = argv.indexOf('--exclude-type');
const exVal = exIdx > -1 && exIdx + 1 < argv.length ? argv[exIdx + 1] : '';
const excludeTypes = new Set(exVal.split(',').map((x) => x.trim()).filter(Boolean));
const groupRepeats = argv.includes('--repeat');
// 位置参数 = 非 flag 且不是 --exclude-type 的值（flag 缺省时不过滤任何位置参数）
const requested = argv
  .filter((a, i) => !a.startsWith('--') && !(exIdx > -1 && i === exIdx + 1))
  .map((f) => basename(f.replace(/\\/g, '/')));
const files = requested.length
  ? requested
  : readdirSync(DIR).filter((f) => /^answers-.*\.jsonl$/.test(f)).sort();

const questions = readFileSync(join(DIR, 'questions.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const qInfo = new Map(questions.map((q) => [q.question_id, q]));
const goldByQid = new Map(questions.map((q) => [q.question_id, q.gold]));

const totalIncluded = questions.filter((q) => !excludeTypes.has(q.question_type)).length;

function scoreFile(f) {
  const rs = loadAnswers(f, goldByQid);
  let sp = 0, st = 0, lp = 0, lt = 0, msSum = 0, msN = 0, timeouts = 0;
  for (const [qid, r] of rs) {
    const q = qInfo.get(qid) ?? {};
    if (excludeTypes.has(q.question_type)) continue;
    const s = gradeStrict(r.gold, r.ans, q.question ?? '');
    const l = gradeLenient(r.gold, r.ans);
    if (s != null) { sp += s; st++; }
    if (l != null) { lp += l; lt++; }
    if (r.status === 'timeout') timeouts++;
    if (typeof r.ms === 'number' && r.ms > 0) { msSum += r.ms; msN++; }
  }
  return {
    file: f,
    n: st,
    strict: st ? `${sp}/${st}` : '-',
    strictPct: st ? (sp / st) * 100 : null,
    lenient: lt ? `${lp}/${lt}` : '-',
    avgMs: msN ? Math.round(msSum / msN) : null,
    timeouts,
  };
}

let rows = [];
for (const f of files) {
  if (!existsSync(join(DIR, f))) { console.warn(`[grade-matrix] 缺 ${f}，跳过`); continue; }
  rows.push(scoreFile(f));
}

// 重复臂聚合：label-rN → 按 base label 分组，报均值 ± (max-min)
if (groupRepeats) {
  const groups = new Map();
  for (const r of rows) {
    const base = r.file.replace(/-r\d+\.jsonl$/, '');
    const g = groups.get(base) ?? { base, file: base + '-r*', pcts: [], n: 0, timeouts: 0, avgMs: 0 };
    if (r.strictPct != null) g.pcts.push(r.strictPct);
    g.n = Math.max(g.n, r.n);
    g.timeouts += r.timeouts;
    g.avgMs = Math.max(g.avgMs, r.avgMs ?? 0);
    groups.set(base, g);
  }
  rows = [...groups.values()].map((g) => {
    const mean = g.pcts.length ? g.pcts.reduce((a, b) => a + b, 0) / g.pcts.length : null;
    const spread = g.pcts.length > 1 ? (Math.max(...g.pcts) - Math.min(...g.pcts)).toFixed(1) : null;
    return {
      file: g.file,
      n: g.n,
      strict: mean != null ? `${mean.toFixed(1)}%${spread != null ? ` ±${spread}` : ''}` : '-',
      strictPct: mean,
      lenient: '-',
      avgMs: g.avgMs || null,
      timeouts: g.timeouts,
      repeated: g.pcts.length,
    };
  });
}

console.log(`\n[grade-matrix] 矩阵（strict 主口径${excludeTypes.size ? `，剔除题型：${[...excludeTypes].join('/')}，分母 ${totalIncluded}` : '，分母 90'}${groupRepeats ? '，重复臂聚合均值±极差' : ''}）：`);
console.log('| 格 | n | strict | lenient | 平均ms | timeout |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.file} | ${r.n} | ${r.strict} | ${r.lenient} | ${r.avgMs ?? '-'} | ${r.timeouts}${r.repeated ? ` (${r.repeated}臂)` : ''} |`);
}

const outFile = join(DIR, 'matrix-grades.json');
writeFileSync(outFile, JSON.stringify({ excludedTypes: [...excludeTypes], groupedByRepeat: groupRepeats, rows }, null, 2) + '\n', 'utf8');
console.log(`\n[grade-matrix] → ${outFile}`);
