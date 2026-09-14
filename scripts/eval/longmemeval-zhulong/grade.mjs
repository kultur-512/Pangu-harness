#!/usr/bin/env node
// scripts/eval/longmemeval-zhulong/grade.mjs
// Same grading rubric as longmemeval-pi/grade.mjs and CC grader. Reads
// zhulong answers.jsonl (fields zl_stdout / zl_exit / zl_ms).
//
// Zhulong outputs in Chinese (because prompt is Chinese). Cross-language
// normalization is NOT done here — grader is a pure substring match on
// normalized text. We report scores as-is and flag language-mismatch as
// a real grader limitation in the comparison report.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(process.cwd());
const DIR = join(ROOT, 'scripts/eval/longmemeval-zhulong');
const CC_DIR = join(ROOT, 'scripts/eval/longmemeval-claudecode');

const normalize = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const grade = (gold, response) => {
  if (!gold) return null;
  const g = normalize(gold);
  const r = normalize(response);
  if (!g) return null;
  const clauses = String(gold)
    .split(/(?<=[.!?;])\s+|\s+(?=\d+\s)/)
    .map((c) => normalize(c))
    .filter(Boolean);
  for (const c of clauses) {
    if (c && r.includes(c)) return 1;
  }
  if (g.length <= 2) {
    if (new RegExp(`\b${g}\b`).test(r)) return 1;
    if (r.startsWith(g)) return 1;
    return 0;
  }
  return r.includes(g) ? 1 : 0;
};

const questions = readFileSync(join(CC_DIR, 'questions.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const answers = readFileSync(join(DIR, 'answers.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);

const ansById = new Map(answers.map((a) => [a.question_id, a]));
const rows = [];
for (const q of questions) {
  const a = ansById.get(q.question_id);
  if (!a) { rows.push({ ...q, score: null, status: 'MISSING', answer: null }); continue; }
  // Strip the echo header that Panshalach prints ("@path 已展开..." / "开始执行:")
  // — only grade the actual model output after the "✓ 完成" marker.
  let modelOut = a.zl_stdout;
  const tail = modelOut.split('\n');
  let lastSummary = -1;
  for (let i = 0; i < tail.length; i++) {
    if (/完成\s*\(\d+ms\)/.test(tail[i])) lastSummary = i;
  }
  if (lastSummary >= 0) {
    modelOut = tail.slice(lastSummary + 1)
      .filter((l) => !/^\[memory\]/.test(l) && !/^NO_TOOL_CALLS/.test(l))
      .join('\n').trim();
  }
  rows.push({
    question_id: q.question_id,
    question_type: q.question_type,
    score: grade(q.gold, modelOut),
    gold: q.gold,
    answer: modelOut,
    zl_ms: a.zl_ms,
    zl_exit: a.zl_exit,
  });
}

console.log(`\n=== Zhulong (openPangu-1B) × LME oracle (12 题) ===\n`);
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
  console.log(`  ${ok} ${r.question_id} [${r.question_type}]  ${r.zl_ms}ms`);
  console.log(`     Q: ${questions.find((q) => q.question_id === r.question_id).question.slice(0, 80)}`);
  console.log(`     gold: ${g}`);
  console.log(`     ans:  ${a}`);
}

const outFile = join(DIR, 'results.jsonl');
writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
console.log(`\n[lme-zhulong] 详细结果: ${outFile}`);