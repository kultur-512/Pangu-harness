#!/usr/bin/env node
// scripts/eval/longmemeval-48/phase1-extract.mjs
// Phase 1: extract lme-<qid>.md memory cards from haystack markdown via CC.
// For each missing question, run `claude --print` with a prompt that asks
// CC to read the haystack and write structured facts to memory.
//
// Output: C:/Users/19395/.claude/projects/P--MY-codes-Pangu/memory/lme-<qid>.md
// (Same convention as the existing 12 cards from the previous session.)

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO = 'P:/MY_codes/Pangu';
const Q_PATH = resolve(REPO, 'scripts/eval/longmemeval-48/questions.jsonl');
const HAY_DIR = resolve(REPO, 'scripts/eval/longmemeval-48/haystacks');
const MEM_DIR = 'C:/Users/19395/.claude/projects/P--MY-codes-Pangu/memory';

const rows = readFileSync(Q_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);

function extractOne(qid) {
  const memFile = `${MEM_DIR}/lme-${qid}.md`;
  if (existsSync(memFile) && readFileSync(memFile, 'utf8').length > 200) {
    return { qid, status: 'EXISTS', ms: 0 };
  }
  const hayFile = `${HAY_DIR}/${qid}.md`;
  const prompt = [
    `Read the file at "${hayFile}".`,
    `Extract the user's key personal facts (numbers, names, dates, preferences, events, supersedes).`,
    `Write the extracted facts to "${memFile}" as structured markdown with these sections:`,
    `- A 1-2 line summary at top`,
    `- Per-topic subheadings (## ...) with bullet lists of facts`,
    `- For any topic that CHANGES across sessions, note the OLD vs NEW values and the LATEST`,
    `Use the Write tool. Do not respond with anything else — just write the file.`,
  ].join(' ');

  const t0 = Date.now();
  const r = spawnSync('claude.cmd', [
    '--print',
    '--dangerously-skip-permissions',
    '--add-dir', MEM_DIR,
    '--add-dir', HAY_DIR,
    '--',
    prompt,
  ], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    cwd: REPO,
    windowsHide: true,
    shell: true,
    input: prompt, // belt-and-suspenders: also pipe via stdin
  });
  const ms = Date.now() - t0;
  const wrote = existsSync(memFile) && readFileSync(memFile, 'utf8').length > 200;
  return {
    qid,
    status: wrote ? 'OK' : 'MISSING',
    exit: r.status,
    ms,
    stdout_tail: (r.stdout || '').slice(-300),
    stderr_tail: (r.stderr || '').slice(-300),
  };
}

const log = resolve(REPO, 'scripts/eval/longmemeval-48/phase1.log.jsonl');
writeFileSync(log, '');
const results = [];
for (const row of rows) {
  process.stdout.write(`[phase1] ${row.question_id} (${row.question_type}) ... `);
  const r = extractOne(row.question_id);
  results.push(r);
  writeFileSync(log, JSON.stringify(r) + '\n', { flag: 'a' });
  process.stdout.write(`${r.status} ${r.ms}ms\n`);
}
const ok = results.filter((r) => r.status === 'OK' || r.status === 'EXISTS').length;
console.log(`\n[phase1] Done: ${ok}/${results.length} memory files written to ${MEM_DIR}`);
console.log(`[phase1] Log: ${log}`);