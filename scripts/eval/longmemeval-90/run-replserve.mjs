#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-replserve.mjs
// LME 90 题 · REPL /serve 通道驱动器。
// 与 run-product.mjs 同源（recordChatFact 播种 + gold 正源 oracle 富化 + grade.mjs 判分），
// 差别仅在 QA 通道：不 spawn headless 子进程，而是 POST 到一个**真实 REPL 进程内**
// 由 /serve 启动的 SSE agent server（POST /api/run）——即 90 题全部经 REPL 的前端
// 交互通道完成。
//
// 用法：
//   1) 启动 REPL（任意工作区），在 REPL 内输入 /serve（默认端口 3456）
//   2) node scripts/eval/longmemeval-90/run-replserve.mjs --label repl-serve [--port 3456]
//   3) node scripts/eval/longmemeval-90/grade.mjs answers-repl-serve.jsonl
//
// 断点续跑：启动时读输出文件已有 question_id 集合并跳过；每题答完立即 append。

import { readFileSync, appendFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)));
const ROOT = join(DIR, '..', '..', '..');
const QUESTIONS_FILE = join(DIR, 'questions.jsonl');
const ORACLE = join(ROOT, 'scripts', 'eval', 'longmemeval', 'data', 'longmemeval_oracle.json');
const MAX_FACTS = 80;
const QA_TIMEOUT_MS = Number(process.env.PANSHA_LME_TIMEOUT_MS) || 180_000;

function parseArgs() {
  const opts = { label: 'repl-serve', port: Number(process.env.PANSHA_SERVE_PORT) || 3456, tier: process.env.PANSHA_TIER || 'high' };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label') opts.label = args[++i];
    else if (args[i] === '--port') opts.port = parseInt(args[i + 1], 10);
    else if (args[i] === '--tier') opts.tier = args[++i];
  }
  return opts;
}
const MODEL = process.env.PANSHA_MODEL || 'openpangu:openpangu-embedded-1b-i1';

/** 播种：与 run-product.replaySessions 同源——recordChatFact 逐 user/assistant 对落卡。 */
async function replaySessions(q, wsDir) {
  const { recordChatFact } = await import('../../../src/memory/chatFactMemory.js');
  const dates = q.haystack_dates ?? [];
  let facts = 0;
  let deduped = 0;
  let si = 0;
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
  return { facts, deduped };
}

/** POST /api/run 并解析 SSE 流，返回 { resultEvent, ms }。 */
async function runViaServe(port, task, workspace, tier, model) {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, workspace, tier, model }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let resultEvent = null;
  let errMsg = '';
  let done = false;
  while (!done) {
    let timeoutId;
    const timeoutP = new Promise((_, rej) => {
      timeoutId = setTimeout(() => rej(new Error('qa_timeout')), QA_TIMEOUT_MS);
    });
    let chunk;
    try {
      chunk = await Promise.race([reader.read(), timeoutP]);
    } finally {
      clearTimeout(timeoutId);
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        if (obj?.stopReason || obj?.answerText || obj?.budgetReport) resultEvent = obj;
        // /serve 错误事件（"未配置可用模型"等）——捕获进 resultEvent 供 status 标注
        if (obj?.message && obj?.error !== undefined) { errMsg = String(obj.message); done = true; }
        if (obj?.success !== undefined && obj?.durationMs !== undefined) done = true;
      } catch {}
    }
  }
  return { resultEvent, errMsg, ms: Date.now() - started };
}

async function main() {
  const opts = parseArgs();
  const OUT_FILE = join(DIR, `answers-${opts.label}.jsonl`);
  if (!existsSync(QUESTIONS_FILE)) { console.error(`[lme90] 缺 ${QUESTIONS_FILE}`); process.exit(2); }
  if (!existsSync(ORACLE)) { console.error(`[lme90] 缺 oracle 数据: ${ORACLE}`); process.exit(2); }

  const questions = readFileSync(QUESTIONS_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const oracleById = new Map(JSON.parse(readFileSync(ORACLE, 'utf8')).map((q) => [q.question_id, q]));
  for (const q of questions) {
    const full = oracleById.get(q.question_id);
    if (!full) { console.error(`[lme90] oracle 中找不到 ${q.question_id}`); process.exit(2); }
    q.haystack_sessions = full.haystack_sessions;
    if (Array.isArray(full.haystack_dates) && full.haystack_dates.length === (full.haystack_sessions?.length ?? 0)) {
      q.haystack_dates = full.haystack_dates;
    }
    if (q.gold == null && full.answer != null) q.gold = full.answer;
  }

  // 断点续跑：跳过已完成
  const done = new Set();
  if (existsSync(OUT_FILE)) {
    for (const l of readFileSync(OUT_FILE, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { done.add(JSON.parse(l).question_id); } catch {}
    }
  }
  const todo = questions.filter((q) => !done.has(q.question_id));
  console.log(`[repl-serve] label=${opts.label} port=${opts.port} tier=${opts.tier} 共 ${questions.length} 题，已完成 ${done.size}，本次待跑 ${todo.length}`);

  // 健康检查
  const health = await fetch(`http://127.0.0.1:${opts.port}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) { console.error(`[repl-serve] /serve 未就绪（http://127.0.0.1:${opts.port}）——先在 REPL 内输入 /serve`); process.exit(2); }

  let n = 0;
  for (const q of todo) {
    n++;
    const wsDir = mkdtempSync(join(tmpdir(), 'pangu-replserve-'));
    process.stdout.write(`[${n}/${todo.length}] ${q.question_id} [${q.question_type}] seeding...`);
    const { facts, deduped } = await replaySessions(q, wsDir);
    process.stdout.write(` ${facts} 卡(去重${deduped}) → QA...`);
    let status = 'ok';
    let answerText = '';
    let ms = 0;
    try {
      const { resultEvent, errMsg, ms: elapsed } = await runViaServe(opts.port, q.question, wsDir, opts.tier, MODEL);
      ms = elapsed;
      answerText = String(resultEvent?.answerText ?? '');
      if (!resultEvent) { status = 'error'; answerText = `SERVER_ERROR: ${errMsg}`; }
      else if (resultEvent.stopReason && resultEvent.stopReason !== 'answered' && resultEvent.stopReason !== 'completed') {
        status = resultEvent.stopReason;
      }
    } catch (e) {
      status = /timeout/.test(String(e?.message)) ? 'timeout' : 'error';
      answerText = '';
      console.log(` ${status}: ${String(e?.message).slice(0, 120)}`);
    }
    const row = {
      question_id: q.question_id,
      question_type: q.question_type,
      gold: q.gold ?? q.answer,
      label: opts.label,
      model: 'openpangu:openpangu-embedded-1b-i1 (REPL /serve 通道)',
      facts,
      deduped,
      ms,
      status,
      // grade.mjs extractAnswer 契约：找"完成 (Nms) · 已回复"汇总行，取其后正文
      stdout: `完成 (${ms}ms) · 已回复\n${answerText}`,
    };
    appendFileSync(OUT_FILE, JSON.stringify(row) + '\n', 'utf8');
    console.log(` ${status} ${(ms / 1000).toFixed(1)}s`);
    try { rmSync(wsDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`[repl-serve] 完成。判分: node scripts/eval/longmemeval-90/grade.mjs answers-${opts.label}.jsonl`);
}

main();
