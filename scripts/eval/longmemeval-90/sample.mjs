#!/usr/bin/env node
// scripts/eval/longmemeval-90/sample.mjs
// 确定性抽样 90 题 LME oracle：每题型 15 × 6 题型（48 题版 sample.mjs 的扩容，
// 同一排序规则——题型内 question_id 字典序取前 N，可复现、可增量）。
// 输出：scripts/eval/longmemeval-90/questions.jsonl + haystacks/<qid>.md
//
// 用法：node scripts/eval/longmemeval-90/sample.mjs [--n 15]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(process.cwd());
const OUT_DIR = join(ROOT, 'scripts/eval/longmemeval-90');
const HAY_DIR = join(OUT_DIR, 'haystacks');
const ORACLE = join(ROOT, 'scripts/eval/longmemeval/data/longmemeval_oracle.json');

let N_PER_TYPE = 15;
const argv = process.argv.slice(2);
const nIdx = argv.indexOf('--n');
if (nIdx !== -1) N_PER_TYPE = parseInt(argv[nIdx + 1], 10);

const data = JSON.parse(readFileSync(ORACLE, 'utf8'));

// 题型内按 question_id 字典序确定性抽样（与 48 题版同一规则）。
const byType = new Map();
for (const q of data) {
  if (!byType.has(q.question_type)) byType.set(q.question_type, []);
  byType.get(q.question_type).push(q);
}

const picked = [];
for (const [t, list] of [...byType.entries()].sort()) {
  list.sort((a, b) => a.question_id < b.question_id ? -1 : 1);
  for (const q of list.slice(0, N_PER_TYPE)) picked.push(q);
}

mkdirSync(HAY_DIR, { recursive: true });

const qJsonl = picked.map((q) => ({
  question_id: q.question_id,
  question_type: q.question_type,
  question: q.question,
  gold: q.answer,
  haystack_file: `haystacks/${q.question_id}.md`,
})).map((r) => JSON.stringify(r)).join('\n');
writeFileSync(join(OUT_DIR, 'questions.jsonl'), qJsonl + '\n', 'utf8');

// haystack 落盘为可读 markdown——每轮一行，会话以 Session 头分隔（与 48 题版同构）。
for (const q of picked) {
  const lines = [];
  lines.push(`# Haystack for ${q.question_id} (${q.question_type})`);
  lines.push(`Date: ${q.question_date}`);
  lines.push(`Sessions: ${q.haystack_session_ids?.length || 0}`);
  lines.push('');
  const sessions = q.haystack_sessions || [];
  for (let i = 0; i < sessions.length; i++) {
    const sid = q.haystack_session_ids?.[i] || `s${i}`;
    const sdate = q.haystack_dates?.[i] || '';
    lines.push(`## Session ${i + 1} (${sid}, ${sdate})`);
    lines.push('');
    for (const turn of sessions[i]) {
      const role = turn.role === 'user' ? '**User**' : '**Assistant**';
      lines.push(`${role}: ${turn.content}`);
    }
    lines.push('');
  }
  writeFileSync(join(HAY_DIR, `${q.question_id}.md`), lines.join('\n'), 'utf8');
}

console.log(`Sampled ${picked.length} questions (${N_PER_TYPE}/type × 6 types).`);
const counts = new Map();
for (const q of picked) counts.set(q.question_type, (counts.get(q.question_type) || 0) + 1);
for (const [t, c] of [...counts.entries()].sort()) console.log(`  ${t}: ${c}`);
