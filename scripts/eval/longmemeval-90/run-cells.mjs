#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-cells.mjs
// 90 题多 harness 交叉对比 runner（方案二）。
//
// 格子（与 48 矩阵同范式扩容）：
//   ZL-direct-90   烛龙 CLI × 本地 1B · 记忆卡内联 recall（PANSHA_NO_MEMORY=1，E1 范式）
//   ZL-pipeline-90 烛龙 CLI × 本地 1B · haystack 前置内联（H1 范式）
//   ZL-compact-90  烛龙 CLI × 本地 1B · recordFactLines 同源播种 + PANSHA_MEMORY_LIMIT=40 检索（J1 范式）
//   CC-90          Claude Code × MiniMax-M3 · 记忆卡 recall（A1 范式）
//   Pi-90          Pi × 本地 1B · 记忆卡 recall（C1 范式）
//   （ZL-product-90 即 run-product.mjs 的 repaired 轮，另行产出）
//
// 同源纪律：ZL-compact-90 播种 import src/memory/chatFactMemory.js 的
// recordFactLines（跑本脚本须 node --import tsx），禁用评测复制品直写存储。
//
// 用法：node --import tsx scripts/eval/longmemeval-90/run-cells.mjs --cell <ID>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(DIR, '../../..');
const Q_PATH = join(DIR, 'questions.jsonl');
const HAY_DIR = join(DIR, 'haystacks');
const MEM_DIR = 'C:/Users/19395/.claude/projects/P--MY-codes-Pangu/memory';
const OUT_DIR = DIR;

const CELLS = {
  'ZL-direct-90':   { harness: 'ZL-direct',   model: '1B', mode: 'recall' },
  'ZL-pipeline-90': { harness: 'ZL-pipeline', model: '1B', mode: 'pipeline' },
  'ZL-compact-90':  { harness: 'ZL-compact',  model: '1B', mode: 'pipeline-compact' },
  'CC-90':          { harness: 'CC',          model: 'M3', mode: 'recall' },
  'Pi-90':          { harness: 'Pi',          model: '1B', mode: 'recall' },
};

const cellId = process.argv[process.argv.indexOf('--cell') + 1];
if (!cellId || !CELLS[cellId]) {
  console.error('Usage: node run-cells.mjs --cell <' + Object.keys(CELLS).join('|') + '>');
  process.exit(2);
}
const cfg = CELLS[cellId];
const ONE_B = 'openpangu:openpangu-embedded-1b-i1';

const readMem = (qid) => {
  const p = `${MEM_DIR}/lme-${qid}.md`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};
const readHay = (qid) => {
  const p = `${HAY_DIR}/${qid}.md`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

const SYS = 'You have long-term memory stored as structured notes. Answer the user\'s question using ONLY the facts in the memory below. Be concise and give the direct answer.';

function buildPrompt({ qid, question, mode }) {
  if (mode === 'pipeline') {
    const hay = readHay(qid);
    return 'Conversation history:\n' + hay + '\n\n## Question\n' + question + '\n\nAnswer:';
  }
  const mem = readMem(qid);
  return [SYS, '', '## Long-term memory', mem, '## /Long-term memory', '', '## Question', question, '', 'Answer:'].join('\n');
}

/** ZL-compact 播种：产品 recordFactLines 同源落卡（tsx loader 必需）。 */
async function seedCompact(qid, wsDir) {
  const { recordFactLines } = await import('../../../src/memory/chatFactMemory.js');
  const prev = process.env.PANSHA_MEMORY_FILE;
  process.env.PANSHA_MEMORY_FILE = 'memory.json';
  const hay = readHay(qid);
  const lines = hay.split('\n')
    .filter((l) => /^\*\*(User|Assistant)\*\*: /.test(l))
    .map((l) => l.replace(/^\*\*(User|Assistant)\*\*: /, ''));
  const facts = [];
  for (let i = 0; i < lines.length - 1; i += 2) facts.push(`Q: ${lines[i]}\nA: ${lines[i + 1]}`);
  const r = recordFactLines(wsDir, facts);
  if (prev === undefined) delete process.env.PANSHA_MEMORY_FILE;
  else process.env.PANSHA_MEMORY_FILE = prev;
  return r;
}

function runZL({ qid, prompt, limitRetrieval }) {
  const tmpDir = join(OUT_DIR, `tmp-${cellId}`);
  mkdirSync(tmpDir, { recursive: true });
  const wsDir = join(tmpDir, qid);
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, 'prompt.txt'), prompt, 'utf8');
  const env = { ...process.env, PANSHA_MODEL: ONE_B, PANSHA_MEMORY_FILE: 'memory.json' };
  let facts = null;
  if (cfg.mode === 'recall') env.PANSHA_NO_MEMORY = '1';
  if (cfg.mode === 'pipeline-compact') {
    delete env.PANSHA_NO_MEMORY;
    env.PANSHA_MEMORY_LIMIT = '40';
    facts = seedCompact(qid, wsDir); // 同步（spawnSync 前）完成播种
  }
  const t0 = Date.now();
  const r = spawnSync('npx.cmd', [
    'tsx', 'src/cli.ts', '--headless', '--approval', 'full', 'run', `@${join(wsDir, 'prompt.txt')}`,
  ], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    cwd: REPO, windowsHide: true, env, shell: true,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Date.now() - t0, facts };
}

function runCC({ prompt }) {
  const t0 = Date.now();
  const r = spawnSync('claude.cmd', [
    '--print', '--dangerously-skip-permissions',
    '--model', 'MiniMax-M3',
    '--add-dir', MEM_DIR,
    '--add-dir', HAY_DIR,
    '--', prompt,
  ], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    cwd: REPO, windowsHide: true, shell: true, input: prompt,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Date.now() - t0 };
}

function runPi({ prompt }) {
  const cliJs = 'C:/Users/19395/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  const sys = 'You have long-term memory stored as structured notes. Answer the user\'s question using only the facts in the provided memory files. Reply concisely with just the answer, no preamble.';
  const tmpDir = join(OUT_DIR, 'tmp-pi');
  mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `${cellId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  writeFileSync(tmpFile, prompt, 'utf8');
  const args = [
    '-p', '--no-session',
    '--provider', 'openpangu',
    '--model', 'openpangu-embedded-1b-i1',
    '--no-tools', '--no-skills', '--no-extensions',
    '--no-context-files', '--no-prompt-templates',
    '--system-prompt', sys,
    `@${tmpFile}`,
  ];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [cliJs, ...args], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, ms: Date.now() - t0 };
}

async function main() {
  const rows = readFileSync(Q_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const outFile = join(OUT_DIR, `answers-${cellId}.jsonl`);
  const existing = new Set();
  if (existsSync(outFile)) {
    for (const l of readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { existing.add(JSON.parse(l).question_id); } catch {}
    }
  }
  const todo = rows.filter((r) => !existing.has(r.question_id));
  console.log(`[${cellId}] harness=${cfg.harness} model=${cfg.model} mode=${cfg.mode} — ${rows.length} q (${existing.size} done, ${todo.length} todo)`);

  for (const row of todo) {
    process.stdout.write(`[${cellId}] ${row.question_id} ... `);
    let r;
    try {
      const prompt = buildPrompt({ qid: row.question_id, question: row.question, mode: cfg.mode });
      if (cfg.harness === 'CC') r = runCC({ prompt });
      else if (cfg.harness === 'Pi') r = runPi({ prompt });
      else r = runZL({ qid: row.question_id, prompt, limitRetrieval: cfg.mode === 'pipeline-compact' });
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
      facts: r.facts ?? undefined,
      cell: cellId,
      harness: cfg.harness,
      model: cfg.model,
      mode: cfg.mode,
    };
    writeFileSync(outFile, JSON.stringify(out) + '\n', { flag: 'a' });
    process.stdout.write(`${r.status} ${r.ms}ms\n`);
  }
  console.log(`[${cellId}] Done → ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
