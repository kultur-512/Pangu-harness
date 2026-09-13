#!/usr/bin/env node
// scripts/eval/longmemeval-zhulong/compare.mjs
// Three-way comparison: CC vs Pi vs Zhulong (direct + product pipeline).
// Reads:
//   - longmemeval-claudecode/results.jsonl  (CC, M3, graded by CC grade.mjs)
//   - longmemeval-pi/results.jsonl          (Pi, 1B, graded by Pi grade.mjs)
//   - longmemeval-zhulong/answers.jsonl     (Zhulong direct-inline, 1B)
//   - longmemeval-zhulong/product-pipeline-answers.jsonl (Zhulong product pipeline, 1B)
//
// Applies STRICT grader (multi-clause + normalize incl \p{S}) to BOTH Zhulong
// variants for apples-to-apples comparison. Records lenient (number-fallback)
// score from old runner as a separate column.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(process.cwd());
const DIR = join(ROOT, 'scripts/eval/longmemeval-zhulong');
const PI_DIR = join(ROOT, 'scripts/eval/longmemeval-pi');
const CC_DIR = join(ROOT, 'scripts/eval/longmemeval-claudecode');

const normalize = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
function gradeStrict(gold, response) {
  if (!gold) return null;
  const g = normalize(gold);
  const r = normalize(response);
  if (!g) return null;
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

// CC results
const ccRows = readFileSync(join(CC_DIR, 'results.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
// Pi results
const piRows = readFileSync(join(PI_DIR, 'results.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
// Zhulong direct-inline raw
const zDirect = readFileSync(join(DIR, 'answers.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
// Zhulong product-pipeline raw (old runner output)
const zPipeline = readFileSync(join(DIR, 'product-pipeline-answers.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);

function byId(arr) {
  return new Map(arr.map((r) => [r.question_id, r]));
}
const ccM = byId(ccRows), piM = byId(piRows),
      zdM = byId(zDirect), zpM = byId(zPipeline);

const questions = ccRows.map((r) => ({
  question_id: r.question_id,
  question_type: r.question_type,
}));

function stripEcho(s) {
  // Remove Panshalach log prefixes from stdout (direct-inline echoes the
  // entire prompt file content). Pull only the last segment after "完成"
  // marker if present, else use the full string.
  if (!s) return '';
  const tail = s.split('\n');
  let last = -1;
  for (let i = 0; i < tail.length; i++) {
    if (/完成\s*\(\d+ms\)/.test(tail[i])) last = i;
  }
  if (last < 0) return s;
  return tail.slice(last + 1)
    .filter((l) => !/^\[memory\]/.test(l) && !/^NO_TOOL_CALLS/.test(l))
    .join('\n').trim();
}

const rows = questions.map((q) => {
  const cc = ccM.get(q.question_id);
  const pi = piM.get(q.question_id);
  const zd = zdM.get(q.question_id);
  const zp = zpM.get(q.question_id);

  const zDirectAns = stripEcho(zd?.zl_stdout || '');
  const zPipelineAns = zp?.answer || '';

  return {
    question_id: q.question_id,
    question_type: q.question_type,
    cc_score: cc?.score,
    pi_score: pi?.score,
    zl_direct_score: gradeStrict(cc?.gold, zDirectAns),
    zl_pipeline_score_strict: gradeStrict(cc?.gold, zPipelineAns),
    zl_pipeline_score_lenient: zp?.score, // number-fallback grader
  };
});

console.log('\n=== 三方对比 (12 题 LME 子集) — 同 12 题、同 lme-*.md memory ===\n');

// Pivot table by question type
const byType = new Map();
for (const r of rows) {
  if (!byType.has(r.question_type)) byType.set(r.question_type, []);
  byType.get(r.question_type).push(r);
}

function tally(rows, fn) {
  return rows.filter((r) => fn(r) === 1).length;
}

console.log('题型'.padEnd(28), 'CC(M3)  Pi(1B)  ZL-direct  ZL-pipe(strict)  ZL-pipe(lenient)');
console.log('-'.repeat(95));
let ccT=0, piT=0, zdT=0, zp1T=0, zp2T=0, nT=0;
for (const [t, list] of [...byType.entries()].sort()) {
  const c = tally(list, r=>r.cc_score);
  const p = tally(list, r=>r.pi_score);
  const zd = tally(list, r=>r.zl_direct_score);
  const zp1 = tally(list, r=>r.zl_pipeline_score_strict);
  const zp2 = tally(list, r=>r.zl_pipeline_score_lenient);
  const n = list.length;
  ccT+=c; piT+=p; zdT+=zd; zp1T+=zp1; zp2T+=zp2; nT+=n;
  console.log(t.padEnd(28),
    `${c}/${n}`.padEnd(8),
    `${p}/${n}`.padEnd(8),
    `${zd}/${n}`.padEnd(11),
    `${zp1}/${n}`.padEnd(17),
    `${zp2}/${n}`);
}
console.log('-'.repeat(95));
console.log('TOTAL'.padEnd(28),
  `${ccT}/${nT}`.padEnd(8),
  `${piT}/${nT}`.padEnd(8),
  `${zdT}/${nT}`.padEnd(11),
  `${zp1T}/${nT}`.padEnd(17),
  `${zp2T}/${nT}`);

console.log('\n=== ZL-direct vs ZL-pipeline：同一 Zhulong harness 不同 memory 注入方式 ===');
console.log('  ZL-direct: 直接 readFileSync 把 lme-*.md 内联进 prompt（不走 Panshalach 记忆）');
console.log('  ZL-pipeline: Panshalach recordChatFact 落卡 → PANSHA_MEMORY_LIMIT=40 全量检索注入');

console.log('\n=== 明细（strict 判定）===');
for (const r of rows) {
  const marks = [
    r.cc_score === 1 ? '✓' : '✗', 'CC',
    r.pi_score === 1 ? '✓' : '✗', 'Pi',
    r.zl_direct_score === 1 ? '✓' : '✗', 'ZD',
    r.zl_pipeline_score_strict === 1 ? '✓' : '✗', 'ZP-strict',
    r.zl_pipeline_score_lenient === 1 ? '✓' : '✗', 'ZP-lenient',
  ].join(' ');
  console.log(`  ${r.question_id} [${r.question_type}]  ${marks}`);
}

writeFileSync(join(DIR, 'compare-results.jsonl'),
  rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
console.log(`\n[zl-cmp] 详细结果: ${join(DIR, 'compare-results.jsonl')}`);