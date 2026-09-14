#!/usr/bin/env node
// Pi+openPangu-1B LME recall runner.
// Phase-1 facts already exist in C:/Users/19395/.claude/.../memory/lme-*.md
// (produced by the CC test). This runner only tests Phase-2 recall:
//  feed memory file -> ask question -> capture model answer -> grade.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = 'P:/MY_codes/Pangu';
const MEM_DIR = 'C:/Users/19395/.claude/projects/P--MY-codes-Pangu/memory';
const OUT_DIR = resolve(REPO, 'scripts/eval/longmemeval-pi');

const SYSTEM_PROMPT =
  "You are an assistant with long-term memory stored in notes. " +
  "Answer the user's question using only the facts in the provided memory files. " +
  "Reply concisely with just the answer, no preamble.";

const PI_FLAGS = [
  '-p', '--no-session',
  '--provider', 'openpangu',
  '--model', 'openpangu-embedded-1b-i1',
  '--no-tools', '--no-skills', '--no-extensions',
  '--no-context-files', '--no-prompt-templates',
  '--system-prompt', SYSTEM_PROMPT,
];

function runPi(memFile, question) {
  const args = [
    ...PI_FLAGS,
    `@${memFile}`,
    question,
  ];
  const t0 = Date.now();
  // Bypass pi.cmd (Windows .cmd shim) to avoid Node spawnSync EINVAL.
  // The .cmd simply invokes `node cli.js %*` so we replicate that directly.
  const nodeBin = process.execPath; // current node binary
  const cliJs = 'C:/Users/19395/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  const r = spawnSync(nodeBin, [cliJs, ...args], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, PI_BYPASS_SHIM: '1' },
  });
  const ms = Date.now() - t0;
  return {
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    exit: r.status,
    timedOut: r.signal === 'SIGTERM',
    ms,
  };
}

function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const questionsPath = resolve(REPO, 'scripts/eval/longmemeval-claudecode/questions.jsonl');
  const lines = readFileSync(questionsPath, 'utf8').trim().split(/\r?\n/);
  const rows = lines.map((l) => JSON.parse(l));

  const rawPath = resolve(OUT_DIR, 'answers.jsonl');
  const rawFh = writeFileSync(rawPath, ''); // truncate
  const results = [];
  for (const row of rows) {
    const memFile = resolve(MEM_DIR, `lme-${row.question_id}.md`);
    process.stdout.write(`[${row.question_id}] (${row.question_type}) ... `);
    const r = runPi(memFile, row.question);
    const out = {
      question_id: row.question_id,
      question_type: row.question_type,
      question: row.question,
      gold: row.gold,
      mem_file: memFile,
      pi_exit: r.exit,
      pi_ms: r.ms,
      pi_stdout: r.stdout,
      pi_stderr: r.stderr,
      timed_out: r.timedOut,
    };
    results.push(out);
    writeFileSync(rawPath, JSON.stringify(results[results.length - 1]) + '\n', { flag: 'a' });
    process.stdout.write(`exit=${r.exit} ms=${r.ms} out=${JSON.stringify(r.stdout).slice(0, 80)}\n`);
  }

  console.log(`\nWrote ${results.length} raw answers to ${rawPath}`);
}

main();
