#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-product.mjs
// 90 题烛龙产品管线评测 runner（方案一阶段 0 基建）。
//
// 与 longmemeval-run.mjs 同一产品忠实度纪律：
//   播种：import src/memory/chatFactMemory.js 的 recordChatFact（产品函数本体，
//         非评测复制——评审 F2 结论：复制版绕过产品容量/去重路径不可接受），
//         haystack 会话逐 user/assistant 对喂入。
//   问答：spawn `npx tsx <ROOT>/src/cli.ts --headless --approval full run @question.txt`，
//         ROOT = process.cwd()——在 worktree 里以旧代码跑基线、主工作区跑修复后，
//         A/B 两轮唯一差异即 src 代码版本。
//   判分：本 runner 只落答案；评分由 grade.mjs 统一做（strict + lenient 双口径）。
//
// 用法：
//   node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label baseline
//   node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label repaired
// 环境变量：PANSHA_MODEL（默认 openpangu:openpangu-embedded-1b-i1 本地端点）
//
// 断点续跑：启动时读输出文件已有 question_id 集合并跳过；每题答完立即 append。
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(process.cwd());
const DIR = join(ROOT, 'scripts', 'eval', 'longmemeval-90');
const WS_ROOT = join(DIR, 'ws');
const TIMEOUT_MS = 180_000;
const MAX_FACTS = 80;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    label: 'baseline',
    model: process.env.PANSHA_MODEL || 'openpangu:openpangu-embedded-1b-i1',
    limit: Infinity,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label') opts.label = args[++i];
    else if (args[i] === '--model') opts.model = args[++i];
    else if (args[i] === '--limit') opts.limit = parseInt(args[++i], 10);
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
    }, opts.timeoutMs || TIMEOUT_MS);
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

/** 播种：产品 recordChatFact 逐对落卡（同源纪律：跑本脚本必须 node --import tsx）。
 *  0.8.3 时间锚定：haystack_dates 与 sessions 1:1（已验证），逐对透传 sessionDate
 *  → 卡前缀/factDate 用"事实发生时间"，不再拿评测当天冒充（假日期污染修复）。 */
async function replaySessions(q, wsDir) {
  // 相对 import（相对本脚本文件）——Windows ESM 拒绝盘符绝对路径，
  // 且相对路径天然随脚本所在 worktree 解析，基线/修复后各自同源。
  const { recordChatFact } = await import('../../../src/memory/chatFactMemory.js');
  const prevEnv = process.env.PANSHA_MEMORY_FILE;
  process.env.PANSHA_MEMORY_FILE = 'memory.json';
  const dates = q.haystack_dates ?? [];
  let facts = 0;
  let deduped = 0;
  let si = 0; // 会话索引（与 haystack_dates 对位）
  outer: for (const session of q.haystack_sessions ?? []) {
    for (let i = 0; i < session.length - 1; i++) {
      const turn = session[i];
      const next = session[i + 1];
      if (turn.role !== 'user' || next.role !== 'assistant') continue;
      const r = await recordChatFact(wsDir, turn.content, next.content, { sessionDate: dates[si] });
      if (r.recorded) facts++;
      else deduped++;
      if (facts >= MAX_FACTS) break outer;
    }
    si++;
  }
  if (prevEnv === undefined) delete process.env.PANSHA_MEMORY_FILE;
  else process.env.PANSHA_MEMORY_FILE = prevEnv;
  return { facts, deduped };
}

/**
 * 0.8.3：把 question_date 宽容解析成 yyyy-MM-dd 供 PANSHA_TODAY（"今天是几号"）。
 * 实测格式："2023/04/10 (Mon) 23:07"；兼容 ISO "2023-04-10T…"/"2023-04-10"、
 * 中文 "2023年4月10日"、英文 "April 10, 2023"/"Apr 10, 2023"。
 * 解析不出 → 返回 null（调用方不设该 env，回退真实当天）。
 */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function looseParseQuestionDate(raw) {
  const s = String(raw ?? '');
  let m = s.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) return isoFrom(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return isoFrom(Number(m[3]), mo, Number(m[2]));
  }
  return null;
}
function isoFrom(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // 组件回环校验：V8 对越界日期滚动不报错（02-31 → 03-03），必须防假日期
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function runQA(q, wsDir, model) {
  const questionFile = join(wsDir, 'question.txt');
  writeFileSync(questionFile, q.question, 'utf8');
  const env = { ...process.env, PANSHA_MEMORY_FILE: 'memory.json', PANSHA_MODEL: model };
  delete env.PANSHA_NO_MEMORY;
  const today = looseParseQuestionDate(q.question_date);
  if (today) env.PANSHA_TODAY = today;
  else delete env.PANSHA_TODAY; // 审查 FAIL-3：防父 shell 残留值穿透进 QA 子进程
  const t0 = Date.now();
  const { stdout, stderr, exitCode, error } = await spawnWithTimeout(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsx', join(ROOT, 'src', 'cli.ts'), '--headless', '--approval', 'full', 'run', `@${questionFile}`],
    { env, cwd: wsDir, timeoutMs: TIMEOUT_MS }
  );
  const ms = Date.now() - t0;
  const status = error?.message === 'timeout' ? 'timeout' : (exitCode === 0 ? 'ok' : `exit-${exitCode}`);
  return { stdout, stderr, ms, status };
}

async function main() {
  const opts = parseArgs();
  const questionsFile = join(DIR, 'questions.jsonl');
  if (!existsSync(questionsFile)) {
    console.error(`[lme90] 缺 ${questionsFile}——先跑 sample.mjs`);
    process.exit(2);
  }
  const questions = readFileSync(questionsFile, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  // questions.jsonl 只有题目字段；播种需要 haystack_sessions——回 oracle 全量 json 按 qid 取。
  const ORACLE = join(ROOT, 'scripts', 'eval', 'longmemeval', 'data', 'longmemeval_oracle.json');
  if (!existsSync(ORACLE)) {
    console.error(`[lme90] 缺 oracle 数据: ${ORACLE}`);
    process.exit(2);
  }
  const oracleById = new Map(
    JSON.parse(readFileSync(ORACLE, 'utf8')).map((q) => [q.question_id, q])
  );
  for (const q of questions) {
    const full = oracleById.get(q.question_id);
    if (!full) { console.error(`[lme90] oracle 中找不到 ${q.question_id}`); process.exit(2); }
    q.haystack_sessions = full.haystack_sessions;
    // 0.8.3 时间锚定：事实时间（播种逐对对位）与问题日期（QA 的"今天"）
    // 审查 FAIL-3：dates 与 sessions 1:1 是时间锚定的前提——错位/短缺时宁可
    // 回退当天（与旧行为一致），也不能静默把错位日期当事实时间喂进去。
    if (Array.isArray(full.haystack_dates) && full.haystack_dates.length === (full.haystack_sessions?.length ?? 0)) {
      q.haystack_dates = full.haystack_dates;
    } else {
      console.warn(`[lme90] ${q.question_id} haystack_dates 缺失或与 sessions 数不匹配，时间锚定回退当天`);
    }
    q.question_date = full.question_date;
  }
  const outFile = join(DIR, `answers-${opts.label}.jsonl`);

  const done = new Set();
  if (existsSync(outFile)) {
    for (const l of readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { done.add(JSON.parse(l).question_id); } catch {}
    }
  }
  mkdirSync(WS_ROOT, { recursive: true });
  const todo = questions.filter((q) => !done.has(q.question_id)).slice(0, opts.limit);
  console.log(`[lme90] label=${opts.label} model=${opts.model} 共 ${questions.length} 题，已完成 ${done.size}，本次待跑 ${todo.length}`);
  console.log(`[lme90] 输出: ${outFile}`);

  let n = 0;
  for (const q of todo) {
    n++;
    const wsDir = join(WS_ROOT, q.question_id);
    rmSync(wsDir, { recursive: true, force: true });
    mkdirSync(wsDir, { recursive: true });
    process.stdout.write(`[${n}/${todo.length}] ${q.question_id} [${q.question_type}] seeding...`);
    const { facts, deduped } = await replaySessions(q, wsDir);
    process.stdout.write(` ${facts} 卡(去重${deduped}) → QA...`);
    const { stdout, stderr, ms, status } = await runQA(q, wsDir, opts.model);
    const row = {
      question_id: q.question_id,
      question_type: q.question_type,
      gold: q.gold ?? q.answer,
      label: opts.label,
      model: opts.model,
      facts,
      deduped,
      ms,
      status,
      stdout,
    };
    appendFileSync(outFile, JSON.stringify(row) + '\n', 'utf8');
    console.log(` ${status} ${(ms / 1000).toFixed(1)}s`);
    try { rmSync(wsDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`[lme90] 完成。判分: node scripts/eval/longmemeval-90/grade.mjs answers-${opts.label}.jsonl`);
}

main().catch((e) => { console.error(e); process.exit(1); });
