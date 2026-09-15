#!/usr/bin/env node
// scripts/eval/longmemeval-zhulong/run.mjs
// Zhulong (panshalach) + openPangu-1B LME recall runner.
//
// Mirrors longmemeval-pi/run.mjs in structure, but uses Panshalach's headless
// CLI: `npx tsx src/cli.ts --headless --approval full run @<prompt-file>`.
//
// Panshalach's @-token logic (src/cli/repl/types.ts:501) replaces @<path>
// inside the prompt file with the file's content. So we compose:
//   <instruction>\n\n@C:/.../lme-XXX.md\n\n<question>
// into one temp prompt file; the @-token gets inlined, the model receives
// the memory content + question in one user message.
//
// PANSHA_NO_MEMORY=1 disables Panshalach's built-in chatFactMemory injection
// so we test pure inlined-memory recall (apples-to-apples with the Pi test).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO = 'P:/MY_codes/Pangu';
const MEM_DIR = 'C:/Users/19395/.claude/projects/P--MY-codes-Pangu/memory';
const OUT_DIR = resolve(REPO, 'scripts/eval/longmemeval-zhulong');
const MODEL = 'openpangu:openpangu-embedded-1b-i1';

function buildPromptFile(promptFile, memFile, question) {
  // Inlined content: Panshalach's expandAtPaths requires @-tokens to resolve
  // inside the workspace (CWD); our memory files live outside it. Inline
  // the memory content directly in the prompt file instead.
  const mem = readFileSync(memFile, 'utf8');
  const composed = [
    '你有一个长期记忆区，存储了用户的结构化笔记。请仅依据下方【长期记忆】中的事实回答问题。回答简洁，给出最直接的答案。',
    '',
    '【长期记忆】',
    mem,
    '【/长期记忆】',
    '',
    '【问题】',
    question,
    '',
  ].join('\n');
  writeFileSync(promptFile, composed, 'utf8');
}

function runZhulong(memFile, question, wsDir) {
  const promptFile = join(wsDir, 'prompt.txt');
  buildPromptFile(promptFile, memFile, question);

  const env = {
    ...process.env,
    PANSHA_NO_MEMORY: '1',           // skip built-in chatFactMemory injection
    PANSHA_MODEL: MODEL,
    // Keep PANSHA_MEMORY_FILE out of the way so it doesn't accidentally
    // create a memory file in wsDir.
    PANSHA_MEMORY_FILE: '',
  };

  const t0 = Date.now();
  const r = spawnSync('npx.cmd', [
    'tsx', 'src/cli.ts',
    '--headless', '--approval', 'full', 'run',
    `@${promptFile}`,
  ], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    cwd: REPO,
    env,
    shell: true, // npx.cmd on Windows requires shell
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
  const rows = readFileSync(questionsPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);

  const rawPath = join(OUT_DIR, 'answers.jsonl');
  writeFileSync(rawPath, ''); // truncate

  const results = [];
  for (const row of rows) {
    const memFile = resolve(MEM_DIR, `lme-${row.question_id}.md`);
    const wsDir = join(OUT_DIR, 'ws', row.question_id);
    if (!existsSync(wsDir)) mkdirSync(wsDir, { recursive: true });

    process.stdout.write(`[${row.question_id}] (${row.question_type}) ... `);
    const r = runZhulong(memFile, row.question, wsDir);
    const out = {
      question_id: row.question_id,
      question_type: row.question_type,
      question: row.question,
      gold: row.gold,
      mem_file: memFile,
      zl_exit: r.exit,
      zl_ms: r.ms,
      zl_stdout: r.stdout,
      zl_stderr: r.stderr,
      timed_out: r.timedOut,
    };
    results.push(out);
    writeFileSync(rawPath, JSON.stringify(out) + '\n', { flag: 'a' });
    process.stdout.write(`exit=${r.exit} ms=${r.ms} out=${JSON.stringify(r.stdout).slice(0, 100)}\n`);
  }
  console.log(`\nWrote ${results.length} raw answers to ${rawPath}`);
}

main();