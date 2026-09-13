#!/usr/bin/env node
// scripts/eval/longmemeval-claudecode/grade.mjs
// 与 longmemeval-run.mjs 同口径判分（归一化子串，gold ≤2 字符用词边界）。
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const ROOT = resolve(process.cwd());
const DIR = join(ROOT, 'scripts', 'eval', 'longmemeval-claudecode');

const normalize = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const grade = (gold, response) => {
  if (!gold) return null;
  const g = normalize(gold);
  const r = normalize(response);
  if (!g) return null;
  // 多子句 gold（"30 days. 31 days also acceptable."）：在原始 gold 上按句号/分号/数字+空格切，
  // 任一子句 normalize 后 substring 命中即得分
  const clauses = String(gold)
    .split(/(?<=[.!?;])\s+|\s+(?=\d+\s)/)
    .map((c) => normalize(c))
    .filter(Boolean);
  for (const c of clauses) {
    if (c && r.includes(c)) return 1;
  }
  if (g.length <= 2) {
    // 短 gold：词边界 + 响应以 gold 起头（修复 "25 new postcards..." 被 0 分的判分器 bug）
    if (new RegExp(`\b${g}\b`).test(r)) return 1;
    if (r.startsWith(g)) return 1;
    return 0;
  }
  return r.includes(g) ? 1 : 0;
};

const questions = (await readFile(join(DIR, 'questions.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map(JSON.parse);
const answers = (await readFile(join(DIR, 'answers.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map(JSON.parse);

const ansById = new Map(answers.map((a) => [a.question_id, a]));
const rows = [];
for (const q of questions) {
  const a = ansById.get(q.question_id);
  if (!a) { rows.push({ ...q, score: null, status: 'MISSING_ANSWER', answer: null }); continue; }
  const score = grade(q.gold, a.answer);
  rows.push({
    question_id: q.question_id,
    question_type: q.question_type,
    score,
    gold: q.gold,
    answer: a.answer,
  });
}

// 汇总
console.log(`\n=== Claude Code × LME oracle (12 题) ===\n`);
const byType = new Map();
for (const r of rows) {
  if (!byType.has(r.question_type)) byType.set(r.question_type, []);
  byType.get(r.question_type).push(r);
}
let sum = 0, cnt = 0;
for (const [t, list] of [...byType.entries()].sort()) {
  const passed = list.filter((r) => r.score === 1).length;
  const pct = list.length ? (passed / list.length * 100).toFixed(0) : '—';
  console.log(`  ${t.padEnd(28)} ${passed}/${list.length}  (${pct}%)`);
  sum += passed; cnt += list.length;
}
console.log(`  ${'TOTAL'.padEnd(28)} ${sum}/${cnt}  (${cnt ? (sum / cnt * 100).toFixed(0) : '—'}%)`);

console.log(`\n=== 明细 ===`);
for (const r of rows) {
  const ok = r.score === 1 ? '✓' : '✗';
  const g = String(r.gold).slice(0, 50).replace(/\n/g, ' ');
  const a = String(r.answer || '(missing)').slice(0, 100).replace(/\n/g, ' ');
  console.log(`  ${ok} ${r.question_id} [${r.question_type}]`);
  console.log(`     Q: ${questions.find((q) => q.question_id === r.question_id).question.slice(0, 80)}`);
  console.log(`     gold: ${g}`);
  console.log(`     ans:  ${a}`);
}

const outFile = join(DIR, 'results.jsonl');
await writeFile(outFile, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
console.log(`\n[lme-cc] 详细结果: ${outFile}`);
