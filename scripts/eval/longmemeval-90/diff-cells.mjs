#!/usr/bin/env node
// scripts/eval/longmemeval-90/diff-cells.mjs
// 两格逐题对比（根因分析用，审计"逐题尸检"工具化）：
//   同题双方答案 + 各自 strict 对错 + 按题型聚合（A胜/B胜/双对/双错/双空），
//   可选 --out 落 Markdown 明细表。
// 判分复用 grade.mjs（loadAnswers/gradeStrict），口径永不与主判分器分叉。
//
// 用法：
//   node scripts/eval/longmemeval-90/diff-cells.mjs answers-a.jsonl answers-b.jsonl
//   node scripts/eval/longmemeval-90/diff-cells.mjs answers-a.jsonl answers-b.jsonl --out diff-a-vs-b.md

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeStrict, loadAnswers } from './grade.mjs';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outFile = outIdx > -1 ? argv[outIdx + 1] : null;
const files = argv.filter((a, i) => a !== '--out' && i !== outIdx + 1);

if (files.length !== 2) {
  console.error('用法: diff-cells.mjs <answers-a.jsonl> <answers-b.jsonl> [--out <file.md>]');
  process.exit(2);
}
for (const f of files) {
  if (!existsSync(join(DIR, f))) { console.error(`缺 ${f}`); process.exit(2); }
}

const questions = readFileSync(join(DIR, 'questions.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const qInfo = new Map(questions.map((q) => [q.question_id, q]));
const goldByQid = new Map(questions.map((q) => [q.question_id, q.gold]));

const A = loadAnswers(files[0], goldByQid);
const B = loadAnswers(files[1], goldByQid);
const nameA = basename(files[0], '.jsonl').replace(/^answers-/, '');
const nameB = basename(files[1], '.jsonl').replace(/^answers-/, '');

const ids = [...new Set([...A.keys(), ...B.keys()])];
const agg = new Map(); // type → {aWin,bWin,both,neither,onlyA,onlyB}
const lines = [];

for (const qid of ids) {
  const q = qInfo.get(qid) ?? {};
  const type = q.question_type ?? 'unknown';
  const ra = A.get(qid);
  const rb = B.get(qid);
  const sa = ra ? gradeStrict(ra.gold, ra.ans, q.question ?? '') : null;
  const sb = rb ? gradeStrict(rb.gold, rb.ans, q.question ?? '') : null;
  const g = agg.get(type) ?? { aWin: 0, bWin: 0, both: 0, neither: 0, onlyA: 0, onlyB: 0 };
  if (sa === null && sb === null) { /* 双空 */ }
  else if (sa === null) g.onlyB++;
  else if (sb === null) g.onlyA++;
  else if (sa && sb) g.both++;
  else if (sa) g.aWin++;
  else if (sb) g.bWin++;
  else g.neither++;
  agg.set(type, g);
  if (sa !== sb) {
    lines.push({ qid, type, q: q.question ?? '', gold: ra?.gold ?? rb?.gold, a: ra?.ans, b: rb?.ans, sa, sb });
  }
}

console.log(`\n[diff] ${nameA} vs ${nameB}（strict，仅列结果相异题 ${lines.length}/${ids.length}）：`);
console.log('| 题型 | A胜 | B胜 | 双对 | 双错 | A独占 | B独占 |');
console.log('|---|---|---|---|---|---|---|');
for (const [type, g] of agg) {
  console.log(`| ${type} | ${g.aWin} | ${g.bWin} | ${g.both} | ${g.neither} | ${g.onlyA} | ${g.onlyB} |`);
}

if (outFile) {
  const md = [`# ${nameA} vs ${nameB} 逐题差异（strict）`, '',
    '| 题 | 题型 | gold | ' + nameA + ' | ' + nameB + ' | 对错 |', '|---|---|---|---|---|---|',
    ...lines.map((l) => `| ${l.qid} | ${l.type} | ${String(l.gold).slice(0, 40)} | ${String(l.a ?? '∅').slice(0, 60).replace(/\|/g, '\\|')} | ${String(l.b ?? '∅').slice(0, 60).replace(/\|/g, '\\|')} | ${l.sa ?? '-'}/${l.sb ?? '-'} |`),
    '',
  ].join('\n');
  writeFileSync(join(DIR, outFile), md, 'utf8');
  console.log(`\n[diff] → ${outFile}`);
}
