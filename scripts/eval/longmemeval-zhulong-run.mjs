#!/usr/bin/env node
// scripts/eval/longmemeval-zhulong-run.mjs
// 烛龙 × LME oracle 12 题子集（与 Pi/CC 对照同题集、同 memory 内容、同判分口径）。
//
// 与 Pi runner 的对应关系（2026-09-13 控制人协议）：
//   Pi   : @lme-<qid>.md 内联进上下文 + 一句话 system + 问题
//   烛龙 : lme-<qid>.md 逐行经 recordChatFact 落卡（烛龙记忆链路）→
//          headless QA（chat 直答 + 【相关记忆】注入）→ 答案
//   判分 : longmemeval-pi/grade.mjs 同款（multi-clause + \p{S}），内嵌同逻辑直接出分
//
// 全量注入口径：PANSHA_MEMORY_LIMIT=40（对齐 Pi 把整个 memory 文件塞上下文；
// 不加该 env 则走产品默认配额=检索式，两口径都可跑）。
//
// 用法：
//   node --import tsx scripts/eval/longmemeval-zhulong-run.mjs --model openpangu:openpangu-embedded-1b-i1
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(process.cwd());
const QUESTIONS = join(ROOT, 'scripts', 'eval', 'longmemeval-claudecode', 'questions.jsonl');
const MEM_DIR = 'C:/Users/19395/.claude/projects/P--MY-codes-Pangu/memory';
const OUT_DIR = join(ROOT, 'scripts', 'eval', 'longmemeval-zhulong');
const WS_ROOT = join(OUT_DIR, 'ws');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { model: 'openpangu:openpangu-embedded-1b-i1', limit: process.env.PANSHA_MEMORY_LIMIT || '40' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') opts.model = args[++i];
    if (args[i] === '--limit') opts.limit = args[++i];
  }
  return opts;
}

function spawnWithTimeout(command, args, opts = {}) {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const spawnArgs = needsShell ? args.map((a) => (/["\s]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : args;
  return new Promise((resolveP) => {
    const child = spawn(command, spawnArgs, {
      env: opts.env || process.env, cwd: opts.cwd || ROOT,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: needsShell,
    });
    let stdout = '', stderr = '', settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (process.platform === 'win32' && child.pid) {
          try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
        } else child.kill('SIGKILL');
        resolveP({ stdout, stderr, exitCode: null, error: new Error('timeout') });
      }
    }, opts.timeoutMs || 180_000);
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => { if (!settled) { settled = true; clearTimeout(timeout); resolveP({ stdout, stderr, exitCode: code ?? null, error: null }); } });
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timeout); resolveP({ stdout, stderr, exitCode: null, error: e }); } });
  });
}

/** 与 longmemeval-pi/grade.mjs 同款判分（multi-clause + \p{S} normalize）。 */
const normalize = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
function gradeOne(gold, response) {
  if (!gold) return null;
  const g = normalize(gold);
  const r = normalize(response);
  if (!g) return null;
  // 数字等价（0.8.2）：中英混答 "38 subjects" vs "38名受试者" 文本不匹配，
  // 数字是事实核心——gold 数字串出现在回答数字集 → 命中（仅 gold 含数字时）。
  const goldNums = String(gold).match(/\d+(?:[.:]\d+)*/g) || [];
  if (goldNums.length > 0) {
    const respNums = new Set(String(response).match(/\d+(?:[.:]\d+)*/g) || []);
    for (const num of goldNums) {
      if (respNums.has(num)) return 1;
    }
  }
  const clauses = String(gold)
    .split(/(?<=[.!?;])\s+|\s+(?=\d+\s)/)
    .map((c) => normalize(c))
    .filter(Boolean);
  for (const c of clauses) {
    if (c && r.includes(c)) return 1;
  }
  if (g.length <= 2) {
    if (new RegExp(`\\b${g}\\b`).test(r)) return 1;
    if (r.startsWith(g)) return 1;
    return 0;
  }
  return r.includes(g) ? 1 : 0;
}

function extractAnswer(stdout) {
  const lines = stdout.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/完成\s*\(\d+ms\)\s*·\s*(已回复|已通过验证|未通过验证|任务执行失败)/.test(lines[i])) last = i;
  }
  if (last === -1) return stdout.slice(-500);
  return lines.slice(last + 1).filter((l) => !/^\[memory\]/.test(l) && !/^NO_TOOL_CALLS/.test(l)).join('\n').trim();
}

/** lme-<qid>.md → 逐行事实卡（跳过 frontmatter/标题/空行）。 */
async function seedFromMemoryFile(mdPath, wsDir) {
  // 0.8.2 评测直落：recordFactLines（跳过噪音/长度门——浓缩事实行非自然对话）
  const { recordFactLines } = await import('../../src/memory/chatFactMemory.js');
  const prev = process.env.PANSHA_MEMORY_FILE;
  process.env.PANSHA_MEMORY_FILE = 'memory.json';
  const raw = await readFile(mdPath, 'utf8');
  const body = raw.replace(/^---[\s\S]*?---\n/, '');           // 去 frontmatter
  const lines = body.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('---') && !/^[-*\d]+[.\s)]*$/.test(l) && l.length >= 6);
  const r = await recordFactLines(wsDir, lines);
  if (prev === undefined) delete process.env.PANSHA_MEMORY_FILE;
  else process.env.PANSHA_MEMORY_FILE = prev;
  return { lines: lines.length, facts: r.recorded };
}

async function runQA(q, wsDir, model, limit) {
  const qFile = join(wsDir, 'question.txt');
  await writeFile(qFile, q.question, 'utf8');
  const env = { ...process.env, PANSHA_MEMORY_FILE: 'memory.json', PANSHA_MODEL: model, PANSHA_MEMORY_LIMIT: String(limit) };
  delete env.PANSHA_NO_MEMORY;
  const { stdout } = await spawnWithTimeout(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsx', join(ROOT, 'src', 'cli.ts'), '--headless', '--approval', 'full', 'run', `@${qFile}`],
    { env, cwd: wsDir, timeoutMs: 180_000 }
  );
  return extractAnswer(stdout);
}

async function main() {
  const opts = parseArgs();
  const questions = (await readFile(QUESTIONS, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  console.log(`[zl-lme] 烛龙 × LME 12 题子集（模型 ${opts.model} · 注入配额 ${opts.limit}）`);
  const rows = [];
  for (const q of questions) {
    const wsDir = join(WS_ROOT, q.question_id);
    await rm(wsDir, { recursive: true, force: true });
    await mkdir(wsDir, { recursive: true });
    const memFile = join(MEM_DIR, `lme-${q.question_id}.md`);
    if (!existsSync(memFile)) {
      console.warn(`[zl-lme] 缺 memory 文件: ${memFile}，跳过`);
      continue;
    }
    const seed = await seedFromMemoryFile(memFile, wsDir);
    const answer = await runQA(q, wsDir, opts.model, opts.limit);
    const score = gradeOne(q.gold, answer);
    rows.push({ question_id: q.question_id, question_type: q.question_type, score, gold: q.gold, answer: answer.slice(0, 400), seed_lines: seed.lines, seeded: seed.facts });
    console.log(`  [${q.question_id.slice(0, 8)}] ${q.question_type.padEnd(28)} ${score === 1 ? '✓' : '✗'} (seed ${seed.facts}/${seed.lines})  ans: ${answer.slice(0, 70).replace(/\n/g, ' ')}`);
    try { await rm(wsDir, { recursive: true, force: true }); } catch {}
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'answers.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
  const byType = new Map();
  for (const r of rows) {
    byType.set(r.question_type, byType.get(r.question_type) ?? { n: 0, s: 0 });
    if (r.score !== null) { byType.get(r.question_type).n++; byType.get(r.question_type).s += r.score; }
  }
  console.log('\n=== 烛龙（openPangu-1B）× LME 12 题 ===');
  let n = 0, s2 = 0;
  for (const [t, v] of byType) {
    console.log(`  ${t.padEnd(28)} ${v.s}/${v.n} (${v.n ? Math.round(v.s / v.n * 100) : 0}%)`);
    n += v.n; s2 += v.s;
  }
  console.log(`  TOTAL ${s2}/${n} (${n ? Math.round(s2 / n * 100) : 0}%)   ← Pi+1B 9/12 75% · CC 10/12 83%`);
  console.log(`[zl-lme] answers: ${join(OUT_DIR, 'answers.jsonl')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
