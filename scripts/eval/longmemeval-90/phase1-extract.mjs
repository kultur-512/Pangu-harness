#!/usr/bin/env node
// scripts/eval/longmemeval-90/phase1-extract.mjs
// 90 题版 phase-1 记忆卡蒸馏（48 题版 phase1-extract.mjs 的扩容）：
// 读本目录 questions.jsonl，对缺失的 lme-<qid>.md 用 claude --print 从
// haystack 蒸馏结构化事实卡。48 题集是本题集的前 8/型子集，既有 48 张
// 卡天然复用（EXISTS 跳过），实际只需蒸馏新增的 42 张。
// 输出：C:/Users/19395/.claude/projects/P--MY-codes-Pangu/memory/lme-<qid>.md

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(fileURLToPath(import.meta.url), '..');
const REPO = resolve(DIR, '../../..');
const Q_PATH = join(DIR, 'questions.jsonl');
const HAY_DIR = join(DIR, 'haystacks');
const MEM_DIR = 'C:/Users/19395/.claude/projects/P--MY-codes-Pangu/memory';

const rows = readFileSync(Q_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const claudeBin = process.platform === 'win32' ? 'claude.cmd' : 'claude';

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
  const r = spawnSync(claudeBin, [
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
    input: prompt,
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

const log = join(DIR, 'phase1.log.jsonl');
writeFileSync(log, '');
const results = [];
for (const row of rows) {
  process.stdout.write(`[phase1-90] ${row.question_id} (${row.question_type}) ... `);
  const r = extractOne(row.question_id);
  results.push(r);
  writeFileSync(log, JSON.stringify(r) + '\n', { flag: 'a' });
  process.stdout.write(`${r.status} ${r.ms}ms\n`);
}
const ok = results.filter((r) => r.status === 'OK' || r.status === 'EXISTS').length;
console.log(`\n[phase1-90] Done: ${ok}/${results.length} memory files in ${MEM_DIR}`);
