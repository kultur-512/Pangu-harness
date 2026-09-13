#!/usr/bin/env node
// scripts/eval/longmemeval-run.mjs
// LongMemEval (oracle 剖分) 真实路径评测 runner（0.8.2 · EVAL-FEASIBILITY P3）。
//
// 与 T1-T5 runner 的关键区别——**不走适配器**（控制人裁决：适配器测的是转换器
// 不是产品）。历史重放走产品自身的"对话事实记忆"链路：
//   重放阶段：haystack 会话逐轮喂 recordChatFact（chatFactMemory.ts，产品功能，
//             确定性落卡、零模型调用——1B 场景友好）
//   问答阶段：题目原文经 headless 真实提交（chat 意图直答 + 记忆注入），
//             A=PANSHA_NO_MEMORY=1 / B=记忆注入
//   判分：归一化子串匹配（官方 LLM-judge 的低成本替代；响应全文留档供复检）
//
// 用法：
//   node scripts/eval/longmemeval-run.mjs                    # 6 题型各 1 题 × A/B
//   node scripts/eval/longmemeval-run.mjs --n 12             # 12 题（题型轮转抽样）
//   node scripts/eval/longmemeval-run.mjs --types knowledge-update,abstention
//   环境变量：PANSHA_MODEL=minimax:MiniMax-M3（同 T 系列 runner）
//
// 数据：scripts/eval/longmemeval/data/longmemeval_oracle.json（hf-mirror 下载）
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(process.cwd());
const DATA_FILE = join(ROOT, 'scripts', 'eval', 'longmemeval', 'data', 'longmemeval_oracle.json');
const WS_ROOT = join(ROOT, 'scripts', 'eval', 'longmemeval', 'ws');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { n: 6, types: null, model: process.env.PANSHA_MODEL || 'minimax:MiniMax-M3' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--n') opts.n = parseInt(args[++i], 10);
    else if (args[i] === '--types') opts.types = args[++i].split(',');
  }
  return opts;
}

function spawnWithTimeout(command, args, opts = {}) {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const spawnArgs = needsShell
    ? args.map((a) => (/["\s]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
    : args;
  return new Promise((resolveP) => {
    const child = spawn(command, spawnArgs, {
      env: opts.env || process.env,
      cwd: opts.cwd || ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: needsShell,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (process.platform === 'win32' && child.pid) {
          try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
        } else { child.kill('SIGKILL'); }
        resolveP({ stdout, stderr, exitCode: null, error: new Error('timeout') });
      }
    }, opts.timeoutMs || 180_000);
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => {
      if (!settled) { settled = true; clearTimeout(timeout); resolveP({ stdout, stderr, exitCode: code ?? null, error: null }); }
    });
    child.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timeout); resolveP({ stdout, stderr, exitCode: null, error: e }); }
    });
  });
}

const normalize = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, '');
const grade = (gold, response) => {
  const g = normalize(gold);
  const r = normalize(response);
  if (!g) return null;
  if (g.length <= 2) {
    // 短 gold（纯数字/单词）：子串匹配会被列表编号/正文数字误命中
    // （1B 真机实证：gold="3" 被回答的列表编号 "3." 判对）→ 词边界匹配
    return new RegExp(`\b${g}\b`).test(r) ? 1 : 0;
  }
  return r.includes(g) ? 1 : 0;
};

function extractAnswer(stdout) {
  // 答案 = 最后一条汇总行之后的正文（RunCommand：`✓ 完成 (Nms) · 已回复`）
  const lines = stdout.split('\n');
  let lastSummary = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/完成\s*\(\d+ms\)\s*·\s*(已回复|已通过验证|未通过验证|任务执行失败)/.test(lines[i])) lastSummary = i;
  }
  if (lastSummary === -1) return stdout.slice(-500);
  return lines.slice(lastSummary + 1)
    .filter((l) => !/^\[memory\]/.test(l) && !/^NO_TOOL_CALLS/.test(l))
    .join('\n').trim();
}

/** 抽样：每题型取第一题（question_id 序，确定性可复现），凑满 n 题。 */
function sampleQuestions(data, n, types) {
  const byType = new Map();
  for (const q of data) {
    if (!byType.has(q.question_type)) byType.set(q.question_type, []);
    byType.get(q.question_type).push(q);
  }
  const keys = [...byType.keys()].sort();
  const picked = [];
  let round = 0;
  while (picked.length < n) {
    let addedThisRound = false;
    for (const t of keys) {
      if (types && !types.some((x) => t.includes(x))) continue;
      const list = byType.get(t);
      if (round < list.length) {
        picked.push(list[round]);
        addedThisRound = true;
        if (picked.length >= n) break;
      }
    }
    if (!addedThisRound) break;
    round++;
  }
  return picked;
}

/** 重放：会话历史 → 产品自身的 recordChatFact（确定性落卡，零模型调用）。 */
async function replaySessions(q, wsDir) {
  const { recordChatFact } = await import('../../dist/memory/chatFactMemory.js');
  const prevEnv = process.env.PANSHA_MEMORY_FILE;
  process.env.PANSHA_MEMORY_FILE = 'memory.json';
  let facts = 0;
  const MAX_FACTS = 80;
  outer: for (const session of q.haystack_sessions ?? []) {
    for (let i = 0; i < session.length - 1; i++) {
      const turn = session[i];
      const next = session[i + 1];
      if (turn.role !== 'user' || next.role !== 'assistant') continue;
      const r = await recordChatFact(wsDir, turn.content, next.content);
      if (r.recorded) facts++;
      if (facts >= MAX_FACTS) break outer;
    }
  }
  if (prevEnv === undefined) delete process.env.PANSHA_MEMORY_FILE;
  else process.env.PANSHA_MEMORY_FILE = prevEnv;
  return facts;
}

async function runQA(q, wsDir, tier, model) {
  const questionFile = join(wsDir, 'question.txt');
  await writeFile(questionFile, q.question, 'utf8');
  // 0.8.2 纰漏修复：模型显式透传——此前只在日志显示默认值，spawn env 里没有
  // PANSHA_MODEL → 子进程回落 .panshalach.json 默认模型（本地端点没开就必挂）。
  const env = { ...process.env, PANSHA_MEMORY_FILE: 'memory.json', PANSHA_MODEL: model };
  if (tier === 'A') env.PANSHA_NO_MEMORY = '1';
  else delete env.PANSHA_NO_MEMORY;
  const { stdout, stderr, exitCode, error } = await spawnWithTimeout(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsx', join(ROOT, 'src', 'cli.ts'), '--headless', '--approval', 'full', 'run', `@${questionFile}`],
    { env, cwd: wsDir, timeoutMs: 180_000 }
  );
  const answer = error ? `(error: ${error.message})` : extractAnswer(stdout);
  return { answer, exitCode, error: error?.message ?? null, raw: stdout, stderr };
}

async function main() {
  const opts = parseArgs();
  if (!existsSync(DATA_FILE)) {
    console.error(`[lme] 数据集缺失: ${DATA_FILE}`);
    console.error('[lme] 下载: curl -L "https://hf-mirror.com/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_oracle" -o scripts/eval/longmemeval/data/longmemeval_oracle.json');
    process.exit(2);
  }
  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const questions = sampleQuestions(data, opts.n, opts.types);
  console.log(`[lme] LongMemEval oracle 评测：${questions.length} 题 × A/B（模型 ${opts.model}）`);

  const rows = [];
  for (const q of questions) {
    const wsDir = join(WS_ROOT, q.question_id);
    await rm(wsDir, { recursive: true, force: true });
    await mkdir(wsDir, { recursive: true });
    const facts = await replaySessions(q, wsDir);
    console.log(`\n[lme] ${q.question_id} [${q.question_type}] 事实卡 ${facts} 张`);
    console.log(`  Q: ${q.question.slice(0, 80)}`);
    for (const tier of ['A', 'B']) {
      const { answer, exitCode, error, raw, stderr } = await runQA(q, wsDir, tier, opts.model);
      try {
        await writeFile(join(WS_ROOT, `debug-${q.question_id}-${tier}.txt`),
          `exit=${exitCode} error=${error ?? 'null'}\nRAW STDOUT (${raw.length}):\n${raw.slice(-1200)}\nSTDERR (${stderr.length}):\n${stderr.slice(-800)}`, 'utf8');
      } catch {}
      const score = grade(q.answer, answer);
      rows.push({
        question_id: q.question_id,
        question_type: q.question_type,
        tier,
        score,
        gold: q.answer,
        answer: answer.slice(0, 400),
        facts,
      });
      console.log(`  [${tier}] ${score === 1 ? '✓' : '✗'} ans: ${answer.slice(0, 90).replace(/\n/g, ' ')}`);
    }
    // 清理临时工作区（保留结果行）
    try { await rm(wsDir, { recursive: true, force: true }); } catch {}
  }

  // 汇总
  const outDir = join(ROOT, 'scripts', 'eval', 'results', 'longmemeval');
  await mkdir(outDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outFile = join(outDir, `${dateStr}-oracle-ab.jsonl`);
  await writeFile(outFile, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');

  console.log(`\n[lme] === 汇总（${rows.length / 2} 题 × A/B）===`);
  const byType = new Map();
  for (const r of rows) {
    const k = r.question_type;
    byType.set(k, byType.get(k) ?? { A: [], B: [] });
    if (r.score !== null) byType.get(k)[r.tier].push(r.score);
  }
  let sumA = 0, cntA = 0, sumB = 0, cntB = 0;
  for (const [t, v] of byType) {
    const a = v.A.length ? (v.A.reduce((x, y) => x + y, 0) / v.A.length * 100).toFixed(0) : '—';
    const b = v.B.length ? (v.B.reduce((x, y) => x + y, 0) / v.B.length * 100).toFixed(0) : '—';
    console.log(`  ${t.padEnd(28)} A: ${a}%  B: ${b}%`);
    sumA += v.A.reduce((x, y) => x + y, 0); cntA += v.A.length;
    sumB += v.B.reduce((x, y) => x + y, 0); cntB += v.B.length;
  }
  console.log(`  ${'TOTAL'.padEnd(28)} A: ${cntA ? (sumA / cntA * 100).toFixed(0) : '—'}%  B: ${cntB ? (sumB / cntB * 100).toFixed(0) : '—'}%`);
  console.log(`[lme] 明细: ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
