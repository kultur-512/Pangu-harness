#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-pi-full.mjs
// Pi 全产品管线 90 题 runner（Pi-full-90 格）。
//
// 与 run-cells.mjs 的 Pi-90（recall 格）对照：
//   Pi-90       --no-session --no-tools --no-skills --no-extensions --no-context-files
//               --no-prompt-templates + --system-prompt（替换默认提示）+ 记忆卡内联
//   Pi-full-90  全默认：session 落盘、built-in 工具可用、skills/extensions 发现开、
//               默认编码系统提示保留（--append-system-prompt 只追加答题塑形指令，
//               不替换默认提示）、历史经 Pi 原生 @file 注入、工作区带 AGENTS.md
//
// 口径声明（2026-09-16）：
//   - 本地 1B（openpangu-embedded-1b-i1）经原始 API 实测无法产出 function call
//     （tools 下发后 tool_calls 恒为空），故 agent 无法自走工具读文件——历史内容
//     用 Pi 官方 @file 注入（print 模式的 documented 用法），工具链照常全开。
//   - AGENTS.md 在 print 模式未被注入上下文（ZZZMARK 实测不出现），保留在工作区
//     内为产品形态完整，不改变模型所见。
//   - 答题塑形指令与 Pi-90 recall 格完全同文，分数差仅归因管线差异。
//
// 用法：node --import tsx scripts/eval/longmemeval-90/run-pi-full.mjs [--limit N]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(DIR, '../../..');
const Q_PATH = join(DIR, 'questions.jsonl');
const HAY_DIR = join(DIR, 'haystacks');
const OUT_DIR = DIR;
const WS_ROOT = join(OUT_DIR, 'tmp-pi-full');

const CELL_ID = 'Pi-full-90';
const PI_CLI = 'C:/Users/19395/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
// 与 run-cells.mjs runPi 的 recall 格系统提示同文——隔离管线差异。
const QA_SHAPE = 'You have long-term memory stored as structured notes. Answer the user\'s question using only the facts in the provided memory files. Reply concisely with just the answer, no preamble.';
const AGENTS_MD = '# Project instructions\n\nThe file history.md in this workspace contains a past conversation between the user and an AI assistant.\nWhen the user asks a question:\n1. Find the answer ONLY in history.md.\n2. Reply with just the answer, nothing else.\n';

const argIdx = process.argv.indexOf('--limit');
const LIMIT = argIdx >= 0 ? Number(process.argv[argIdx + 1]) : 0;

function runPiFull({ qid, question }) {
  const wsDir = join(WS_ROOT, qid);
  mkdirSync(wsDir, { recursive: true });
  copyFileSync(join(HAY_DIR, `${qid}.md`), join(wsDir, 'history.md'));
  writeFileSync(join(wsDir, 'AGENTS.md'), AGENTS_MD, 'utf8');
  writeFileSync(join(wsDir, 'prompt.txt'), question, 'utf8');
  const args = [
    '-p',
    '--provider', 'openpangu',
    '--model', 'openpangu-embedded-1b-i1',
    '--approve',
    '--append-system-prompt', QA_SHAPE,
    '@history.md', '@prompt.txt',
  ];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [PI_CLI, ...args], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    cwd: wsDir, windowsHide: true,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Date.now() - t0 };
}

function main() {
  const rows = readFileSync(Q_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const outFile = join(OUT_DIR, `answers-${CELL_ID}.jsonl`);
  const existing = new Set();
  if (existsSync(outFile)) {
    for (const l of readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { existing.add(JSON.parse(l).question_id); } catch {}
    }
  }
  let todo = rows.filter((r) => !existing.has(r.question_id));
  if (LIMIT > 0) todo = todo.slice(0, LIMIT);
  console.log(`[${CELL_ID}] Pi 全产品管线 × 1B — ${rows.length} q (${existing.size} done, ${todo.length} todo${LIMIT ? `, limit ${LIMIT}` : ''})`);

  for (const row of todo) {
    process.stdout.write(`[${CELL_ID}] ${row.question_id} ... `);
    let r;
    try {
      r = runPiFull({ qid: row.question_id, question: row.question });
    } catch (e) {
      r = { stdout: '', stderr: String(e), status: -1, ms: 0 };
    }
    const out = {
      question_id: row.question_id,
      question_type: row.question_type,
      gold: row.gold,
      ms: r.ms,
      status: r.status,
      stdout: r.stdout,
      stderr: (r.stderr || '').slice(-2000),
      cell: CELL_ID,
      harness: 'Pi-full',
      model: '1B',
      mode: 'pipeline',
    };
    writeFileSync(outFile, JSON.stringify(out) + '\n', { flag: 'a' });
    process.stdout.write(`${r.status} ${r.ms}ms\n`);
  }
  console.log(`[${CELL_ID}] Done → ${outFile}`);
}

main();
