#!/usr/bin/env node
// scripts/eval/longmemeval-48/sample.mjs
// Deterministically sample 48 LME oracle questions: 8 per type × 6 types.
// Output: scripts/eval/longmemeval-48/questions.jsonl + haystacks/<qid>.md

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(process.cwd());
const OUT_DIR = join(ROOT, 'scripts/eval/longmemeval-48');
const HAY_DIR = join(OUT_DIR, 'haystacks');
const ORACLE = join(ROOT, 'scripts/eval/longmemeval/data/longmemeval_oracle.json');
const N_PER_TYPE = 8;

const data = JSON.parse(readFileSync(ORACLE, 'utf8'));

// Sort within type by question_id (lexicographic) for deterministic sampling.
const byType = new Map();
for (const q of data) {
  if (!byType.has(q.question_type)) byType.set(q.question_type, []);
  byType.get(q.question_type).push(q);
}

const picked = [];
for (const [t, list] of [...byType.entries()].sort()) {
  list.sort((a, b) => a.question_id < b.question_id ? -1 : 1);
  const slice = list.slice(0, N_PER_TYPE);
  for (const q of slice) picked.push(q);
}

mkdirSync(HAY_DIR, { recursive: true });

// Write questions.jsonl (CC-test compatible shape)
const qJsonl = picked.map((q) => ({
  question_id: q.question_id,
  question_type: q.question_type,
  question: q.question,
  gold: q.answer,
  haystack_file: `haystacks/${q.question_id}.md`,
})).map((r) => JSON.stringify(r)).join('\n');
writeFileSync(join(OUT_DIR, 'questions.jsonl'), qJsonl + '\n', 'utf8');

// Dump haystacks as readable markdown — one turn per line, sessions separated.
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
console.log(`  questions.jsonl: ${join(OUT_DIR, 'questions.jsonl')}`);
console.log(`  haystacks: ${HAY_DIR}`);
console.log(`Per-type counts:`);
const counts = new Map();
for (const q of picked) counts.set(q.question_type, (counts.get(q.question_type) || 0) + 1);
for (const [t, c] of [...counts.entries()].sort()) console.log(`  ${t}: ${c}`);