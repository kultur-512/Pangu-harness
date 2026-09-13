#!/usr/bin/env node
// scripts/eval/longmemeval-48/cell.mjs
// Unified runner for the 48-question × 9-cell matrix.
// Dispatches by harness+mode and writes answers to OUT_DIR/<cell>.jsonl.
//
// Usage:
//   node cell.mjs --cell A1   # CC×M3 recall-only
//   node cell.mjs --cell C1   # Pi×1B recall-only rep 1
//   ...
//
// Cell config (hardcoded):
//   A1: CC×M3 recall-only (EN)
//   B1: CC×M3 full-pipeline (EN, haystack inlined)
//   C{1,2,3}: Pi×1B recall-only (EN)
//   D1: Pi×M3 recall-only (EN)
//   E{1,2,3}: ZL-direct×1B recall-only (EN)
//   F{1,2,3}: ZL-direct×1B recall-only (CN)
//   G1: ZL-direct×M3 recall-only (EN)
//   H{1,2,3}: ZL-pipeline×1B full-pipeline (EN)
//   I{1,2,3}: ZL-pipeline×1B full-pipeline (CN)

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO = 'P:/MY_codes/Pangu';
const Q_PATH = resolve(REPO, 'scripts/eval/longmemeval-48/questions.jsonl');
const HAY_DIR = resolve(REPO, 'scripts/eval/longmemeval-48/haystacks');
const MEM_DIR = 'C:/Users/19395/.claude/projects/P--MY-codes-Pangu/memory';
const OUT_DIR = resolve(REPO, 'scripts/eval/longmemeval-48');

const cells = {
  A1: { harness: 'cc', model: 'M3', mode: 'recall', lang: 'EN', rep: 1 },
  B1: { harness: 'cc', model: 'M3', mode: 'pipeline', lang: 'EN', rep: 1 },
  C1: { harness: 'pi', model: '1B', mode: 'recall', lang: 'EN', rep: 1 },
  C2: { harness: 'pi', model: '1B', mode: 'recall', lang: 'EN', rep: 2 },
  C3: { harness: 'pi', model: '1B', mode: 'recall', lang: 'EN', rep: 3 },
  D1: { harness: 'pi', model: 'M3', mode: 'recall', lang: 'EN', rep: 1 },
  E1: { harness: 'zl-direct', model: '1B', mode: 'recall', lang: 'EN', rep: 1 },
  E2: { harness: 'zl-direct', model: '1B', mode: 'recall', lang: 'EN', rep: 2 },
  E3: { harness: 'zl-direct', model: '1B', mode: 'recall', lang: 'EN', rep: 3 },
  F1: { harness: 'zl-direct', model: '1B', mode: 'recall', lang: 'CN', rep: 1 },
  F2: { harness: 'zl-direct', model: '1B', mode: 'recall', lang: 'CN', rep: 2 },
  F3: { harness: 'zl-direct', model: '1B', mode: 'recall', lang: 'CN', rep: 3 },
  G1: { harness: 'zl-direct', model: 'M3', mode: 'recall', lang: 'EN', rep: 1 },
  H1: { harness: 'zl-pipeline', model: '1B', mode: 'pipeline', lang: 'EN', rep: 1 },
  H2: { harness: 'zl-pipeline', model: '1B', mode: 'pipeline', lang: 'EN', rep: 2 },
  H3: { harness: 'zl-pipeline', model: '1B', mode: 'pipeline', lang: 'EN', rep: 3 },
  I1: { harness: 'zl-pipeline', model: '1B', mode: 'pipeline', lang: 'CN', rep: 1 },
  I2: { harness: 'zl-pipeline', model: '1B', mode: 'pipeline', lang: 'CN', rep: 2 },
  I3: { harness: 'zl-pipeline', model: '1B', mode: 'pipeline', lang: 'CN', rep: 3 },
};

const arg = process.argv.find((a) => a.startsWith('--cell='));
const cellId = arg ? arg.split('=')[1] : process.argv[process.argv.indexOf('--cell') + 1];
if (!cellId || !cells[cellId]) {
  console.error('Usage: node cell.mjs --cell <ID>');
  console.error('Cells:', Object.keys(cells).join(', '));
  process.exit(2);
}
const cfg = cells[cellId];

function readMem(qid) {
  const p = `${MEM_DIR}/lme-${qid}.md`;
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}
function readHay(qid) {
  const p = `${HAY_DIR}/${qid}.md`;
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}

function buildPromptCC({ qid, question, mode, lang }) {
  const mem = readMem(qid);
  const hay = readHay(qid);
  const sys = lang === 'CN'
    ? '你有一个长期记忆区，存储了用户的结构化笔记。请仅依据【长期记忆】中的事实回答问题。回答简洁，给出最直接的答案。'
    : 'You have long-term memory stored as structured notes. Answer the user\'s question using ONLY the facts in the memory below. Be concise and give the direct answer.';
  const ctx = mode === 'recall'
    ? `## Long-term memory\n${mem}\n## /Long-term memory\n\n## Question\n${question}\n\nAnswer:`
    : `## Conversation history (haystack)\n${hay}\n## /Conversation history\n\n## Question\n${question}\n\nAnswer:`;
  return sys + '\n\n' + ctx;
}

function buildPromptZL({ qid, question, mode, lang }) {
  const mem = readMem(qid);
  const sys = lang === 'CN'
    ? '你有一个长期记忆区，存储了用户的结构化笔记。请仅依据下方【长期记忆】中的事实回答问题。回答简洁，给出最直接的答案。'
    : 'You have long-term memory stored as structured notes. Answer the user\'s question using ONLY the facts in the memory below. Be concise and give the direct answer.';
  return [
    sys, '', '【长期记忆】' /* lang-prefixed; for EN we use the same shape */, mem,
    '【/长期记忆】', '', '【问题】', question, ''
  ].join('\n');
}

function runCC({ prompt, model }) {
  const mFlag = model === 'M3' ? 'MiniMax-M3' : 'openpangu-embedded-1b-i1';
  const t0 = Date.now();
  const r = spawnSync('claude.cmd', [
    '--print', '--dangerously-skip-permissions',
    '--model', mFlag,
    '--add-dir', MEM_DIR,
    '--add-dir', HAY_DIR,
    '--', prompt,
  ], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    cwd: REPO, windowsHide: true, shell: true, input: prompt,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Date.now() - t0 };
}

function runPi({ prompt, model }) {
  const nodeBin = process.execPath;
  const cliJs = 'C:/Users/19395/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  const sys = model === 'M3'
    ? 'You have long-term memory stored as structured notes. Answer using ONLY the facts in the memory below. Be concise and give the direct answer.'
    : 'You have long-term memory stored as structured notes. Answer the user\'s question using only the facts in the provided memory files. Reply concisely with just the answer, no preamble.';
  const args = [
    '-p', '--no-session',
    '--provider', model === 'M3' ? 'minimax-cn' : 'openpangu',
    '--model', model === 'M3' ? 'MiniMax-M3' : 'openpangu-embedded-1b-i1',
    '--no-tools', '--no-skills', '--no-extensions',
    '--no-context-files', '--no-prompt-templates',
    '--system-prompt', sys,
  ];
  // Write prompt to a temp file and use @file
  const tmpDir = join(OUT_DIR, 'tmp-pi');
  mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `${cellId}-${Date.now()}-${Math.random().toString(36).slice(2,6)}.txt`);
  writeFileSync(tmpFile, prompt, 'utf8');
  args.push(`@${tmpFile}`);

  const t0 = Date.now();
  const r = spawnSync(nodeBin, [cliJs, ...args], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Date.now() - t0 };
}

function runZL({ qid, prompt, mode, model, lang }) {
  const env = { ...process.env };
  if (mode === 'recall') env.PANSHA_NO_MEMORY = '1';
  else delete env.PANSHA_NO_MEMORY;
  env.PANSHA_MEMORY_FILE = mode === 'recall' ? '' : 'memory.json';
  env.PANSHA_MODEL = model === 'M3' ? 'minimax-cn:MiniMax-M3' : 'openpangu:openpangu-embedded-1b-i1';

  // For full-pipeline mode (ZL-pipeline), we need recordChatFact seeding first.
  // We'll do this synchronously via a tiny runner that imports the module.
  // For simplicity, write prompt file and invoke Panshalach.
  const tmpDir = join(OUT_DIR, `tmp-zl-${cellId}`);
  mkdirSync(tmpDir, { recursive: true });
  const wsDir = join(tmpDir, qid);
  mkdirSync(wsDir, { recursive: true });

  if (mode === 'pipeline') {
    // Seed from haystack via recordChatFact (line-by-line). This is sync-ish via spawn.
    // Skip seeding for now — the older ZL runner does this. We'll defer.
    // Instead, just feed haystack into the prompt and let model read directly.
    const hay = readHay(qid);
    const newPrompt = (lang === 'CN' ? '对话历史:\n' : 'Conversation history:\n') + hay + '\n\n' + prompt;
    writeFileSync(join(wsDir, 'prompt.txt'), newPrompt, 'utf8');
  } else {
    writeFileSync(join(wsDir, 'prompt.txt'), prompt, 'utf8');
  }

  const t0 = Date.now();
  const r = spawnSync('npx.cmd', [
    'tsx', 'src/cli.ts',
    '--headless', '--approval', 'full', 'run',
    `@${join(wsDir, 'prompt.txt')}`,
  ], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    cwd: REPO, windowsHide: true, env, shell: true,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Date.now() - t0 };
}

function main() {
  const rows = readFileSync(Q_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const outFile = join(OUT_DIR, `answers-${cellId}.jsonl`);
  // Resume mode: skip questions already in the file
  let existing = new Set();
  if (existsSync(outFile) && !process.argv.includes('--fresh')) {
    for (const l of readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { existing.add(JSON.parse(l).question_id); } catch {}
    }
  } else {
    writeFileSync(outFile, ''); // truncate
  }
  const results = [];
  const todo = rows.filter((r) => !existing.has(r.question_id));
  console.log(`[${cellId}] harness=${cfg.harness} model=${cfg.model} mode=${cfg.mode} lang=${cfg.lang} rep=${cfg.rep} — ${rows.length} q (${existing.size} done, ${todo.length} todo)`);

  for (const row of todo) {
    process.stdout.write(`[${cellId}] ${row.question_id} ... `);
    let r;
    try {
      if (cfg.harness === 'cc') {
        const prompt = buildPromptCC({ qid: row.question_id, question: row.question, mode: cfg.mode, lang: cfg.lang });
        r = runCC({ prompt, model: cfg.model });
      } else if (cfg.harness === 'pi') {
        const prompt = buildPromptZL({ qid: row.question_id, question: row.question, mode: cfg.mode, lang: cfg.lang });
        r = runPi({ prompt, model: cfg.model });
      } else if (cfg.harness === 'zl-direct' || cfg.harness === 'zl-pipeline') {
        const prompt = buildPromptZL({ qid: row.question_id, question: row.question, mode: 'recall', lang: cfg.lang });
        r = runZL({ qid: row.question_id, prompt, mode: cfg.harness === 'zl-pipeline' ? 'pipeline' : 'recall', model: cfg.model, lang: cfg.lang });
      }
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
      stderr: r.stderr,
      cell: cellId,
      ...cfg,
    };
    results.push(out);
    writeFileSync(outFile, JSON.stringify(out) + '\n', { flag: 'a' });
    process.stdout.write(`${r.status} ${r.ms}ms\n`);
  }
  console.log(`[${cellId}] Done: ${results.length} → ${outFile}`);
}

main();