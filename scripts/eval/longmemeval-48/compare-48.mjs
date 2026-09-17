#!/usr/bin/env node
// scripts/eval/longmemeval-48/compare-48.mjs
// Comprehensive grader + comparison for the 9-cell × 48-question matrix.
// Outputs: compare-48.jsonl + COMPARE-48.md

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const OUT_DIR = 'P:/MY_codes/Pangu/scripts/eval/longmemeval-48';
const normalize = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

const gradeStrict = (gold, resp) => {
  if (gold == null) return null;
  const g = normalize(gold), r = normalize(resp);
  if (!g) return null;
  const clauses = String(gold)
    .split(/(?<=[.!?;])\s+|\s+(?=\d+\s)/)
    .map((c) => normalize(c))
    .filter(Boolean);
  for (const c of clauses) if (c && r.includes(c)) return 1;
  if (g.length <= 2)
    return new RegExp(`\\b${g}\\b`).test(r) || r.startsWith(g) ? 1 : 0;
  return r.includes(g) ? 1 : 0;
};

const gradeLenient = (gold, resp) => {
  if (gold == null) return null;
  const nums = (resp.match(/\d+/g) || []).map(Number);
  const goldNums = String(gold).match(/\d+/g)?.map(Number) || [];
  return goldNums.some((gn) => nums.some((n) => n === gn)) ? 1 : 0;
};

const stripPrefix = (s) =>
  (s || '')
    .replace(/^@path 已展开.*\n?/, '')
    .replace(/^.*?开始执行.*?\n?/, '')
    .trim();

// All completed cells
const cells = ['A1','B1','C1','C2','E1','E2','F1','F2','H1','I1','J1'];
const cellMeta = {
  A1: { harness:'CC', model:'M3', mode:'recall', lang:'EN', rep:1 },
  B1: { harness:'CC', model:'M3', mode:'pipeline', lang:'EN', rep:1 },
  C1: { harness:'Pi', model:'1B', mode:'recall', lang:'EN', rep:1 },
  C2: { harness:'Pi', model:'1B', mode:'recall', lang:'EN', rep:2 },
  E1: { harness:'ZL-direct', model:'1B', mode:'recall', lang:'EN', rep:1 },
  E2: { harness:'ZL-direct', model:'1B', mode:'recall', lang:'EN', rep:2 },
  F1: { harness:'ZL-direct', model:'1B', mode:'recall', lang:'CN', rep:1 },
  F2: { harness:'ZL-direct', model:'1B', mode:'recall', lang:'CN', rep:2 },
  H1: { harness:'ZL-pipeline', model:'1B', mode:'pipeline', lang:'EN', rep:1 },
  I1: { harness:'ZL-pipeline', model:'1B', mode:'pipeline', lang:'CN', rep:1 },
  J1: { harness:'ZL-compact', model:'1B', mode:'pipeline-compact', lang:'EN', rep:1 },
};

// Load all data
const byQ = {};
for (const cell of cells) {
  const f = join(OUT_DIR, `answers-${cell}.jsonl`);
  try {
    for (const l of readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const r = JSON.parse(l);
      const qid = r.question_id;
      if (!byQ[qid]) byQ[qid] = {};
      const ans = stripPrefix(r.stdout);
      byQ[qid][cell] = {
        gold: r.gold,
        ans,
        ansLen: ans.length,
        scoreStrict: gradeStrict(r.gold, ans),
        scoreLenient: gradeLenient(r.gold, ans),
        status: r.status,
        ms: r.ms,
      };
    }
  } catch {}
}

const qids = Object.keys(byQ).sort();
const qTypes = [...new Set(qids.map((qid) => byQ[qid][cells[0]]?.gold ??
  ''))].sort(); // won't use this

// Collect question types from data
const qTypeMap = {};
for (const qid of qids) {
  const sample = Object.values(byQ[qid]).find(Boolean);
  if (sample) qTypeMap[qid] = sample.gold || 'unknown';
}

// Re-read questions.jsonl for type info
const questions = readFileSync(join(OUT_DIR, 'questions.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const qMeta = new Map(questions.map((q) => [q.question_id, q]));

// Per-type aggregation
const types = [...new Set(questions.map((q) => q.question_type))].sort();

// Cell-level strict scores
const cellStrict = (cell) => {
  let pass = 0, total = 0;
  for (const qid of qids) {
    const d = byQ[qid][cell];
    if (d && d.scoreStrict != null) { pass += d.scoreStrict; total++; }
  }
  return { pass, total };
};

// Per-type per-cell
const byTypeCell = {};
for (const t of types) {
  byTypeCell[t] = {};
  for (const cell of cells) {
    const qids_t = qids.filter((qid) => qMeta.get(qid)?.question_type === t);
    let pass = 0, total = 0;
    for (const qid of qids_t) {
      const d = byQ[qid]?.[cell];
      if (d && d.scoreStrict != null) { pass += d.scoreStrict; total++; }
    }
    byTypeCell[t][cell] = { pass, total };
  }
}

// === Markdown Report ===
let md = '# LME 48题 × 9格 成绩矩阵\n\n';
md += `> 生成时间: ${new Date().toISOString()}\n`;
md += `> 完成格子: ${cells.join(', ')}\n\n`;

// Strict pivot
md += '## Strict 评分（多子句匹配 + normalize）\n\n';
md += '| 题型 | ' + cells.map(c => `${c} (${cellMeta[c].harness}×${cellMeta[c].model})`).join(' | ') + ' |\n';
md += '|' + '-|'.repeat(cells.length + 1) + '\n';
for (const t of types) {
  md += `| **${t}** |`;
  for (const cell of cells) {
    const { pass, total } = byTypeCell[t][cell];
    const pct = total > 0 ? Math.round(pass / total * 100) : 0;
    md += ` ${pass}/${total} (${pct}%) |`;
  }
  md += '\n';
}
md += '| **TOTAL** |';
for (const cell of cells) {
  const { pass, total } = cellStrict(cell);
  const pct = total > 0 ? Math.round(pass / total * 100) : 0;
  md += ` **${pass}/${total}** (${pct}%) |`;
}
md += '\n\n';

// Lenient pivot
md += '## Lenient 评分（数字回退 fallback）\n\n';
const cellLenient = (cell) => {
  let pass = 0, total = 0;
  for (const qid of qids) {
    const d = byQ[qid][cell];
    if (d && d.scoreLenient != null) { pass += d.scoreLenient; total++; }
  }
  return { pass, total };
};
const byTypeCellLenient = {};
for (const t of types) {
  byTypeCellLenient[t] = {};
  for (const cell of cells) {
    const qids_t = qids.filter((qid) => qMeta.get(qid)?.question_type === t);
    let pass = 0, total = 0;
    for (const qid of qids_t) {
      const d = byQ[qid]?.[cell];
      if (d && d.scoreLenient != null) { pass += d.scoreLenient; total++; }
    }
    byTypeCellLenient[t][cell] = { pass, total };
  }
}
md += '| 题型 | ' + cells.map(c => `${c}`).join(' | ') + ' |\n';
md += '|' + '-|'.repeat(cells.length + 1) + '\n';
for (const t of types) {
  md += `| **${t}** |`;
  for (const cell of cells) {
    const { pass, total } = byTypeCellLenient[t][cell];
    md += ` ${pass}/${total} |`;
  }
  md += '\n';
}
md += '| **TOTAL** |';
for (const cell of cells) {
  const { pass, total } = cellLenient(cell);
  md += ` **${pass}/${total}** |`;
}
md += '\n\n';

// Per-replicate stability (ZL-direct EN: E1 vs E2)
md += '## 1B 重复性：E1 vs E2（ZL-direct EN）\n\n';
md += '| 题型 | E1 strict | E2 strict | 差异 |\n';
md += '|------|---------|---------|------|\n';
for (const t of types) {
  const qids_t = qids.filter((qid) => qMeta.get(qid)?.question_type === t);
  let e1p = 0, e1t = 0, e2p = 0, e2t = 0;
  for (const qid of qids_t) {
    const d1 = byQ[qid]?.E1;
    const d2 = byQ[qid]?.E2;
    if (d1?.scoreStrict != null) { e1p += d1.scoreStrict; e1t++; }
    if (d2?.scoreStrict != null) { e2p += d2.scoreStrict; e2t++; }
  }
  const diff = e1t > 0 && e2t > 0 ? e2p - e1p : 0;
  md += `| ${t} | ${e1p}/${e1t} | ${e2p}/${e2t} | ${diff > 0 ? '+' : ''}${diff} |\n`;
}

// Cross-language: E1 vs F1 (ZL-direct EN vs CN)
md += '\n## 跨语言：E1 (EN) vs F1 (CN)（ZL-direct 1B）\n\n';
md += '| 题型 | E1 strict | F1 strict | 差异 |\n';
md += '|------|---------|---------|------|\n';
for (const t of types) {
  const qids_t = qids.filter((qid) => qMeta.get(qid)?.question_type === t);
  let e1p = 0, e1t = 0, f1p = 0, f1t = 0;
  for (const qid of qids_t) {
    const d1 = byQ[qid]?.E1;
    const d2 = byQ[qid]?.F1;
    if (d1?.scoreStrict != null) { e1p += d1.scoreStrict; e1t++; }
    if (d2?.scoreStrict != null) { f1p += d2.scoreStrict; f1t++; }
  }
  const diff = e1t > 0 && f1t > 0 ? f1p - e1p : 0;
  md += `| ${t} | ${e1p}/${e1t} | ${f1p}/${f1t} | ${diff > 0 ? '+' : ''}${diff} |\n`;
}

// CC recall vs full-pipeline: A1 vs B1
md += '\n## CC×M3: recall (A1) vs full-pipeline (B1)\n\n';
for (const t of types) {
  const qids_t = qids.filter((qid) => qMeta.get(qid)?.question_type === t);
  let a1p = 0, a1t = 0, b1p = 0, b1t = 0;
  for (const qid of qids_t) {
    const d1 = byQ[qid]?.A1;
    const d2 = byQ[qid]?.B1;
    if (d1?.scoreStrict != null) { a1p += d1.scoreStrict; a1t++; }
    if (d2?.scoreStrict != null) { b1p += d2.scoreStrict; b1t++; }
  }
  console.log(`${t}: A1=${a1p}/${a1t} B1=${b1p}/${b1t}`);
}

// Pi stability: C1 vs C2
md += '\n## Pi×1B 重复性：C1 vs C2（EN）\n\n';
md += '| 题型 | C1 strict | C2 strict | 差异 |\n';
md += '|------|---------|---------|------|\n';
for (const t of types) {
  const qids_t = qids.filter((qid) => qMeta.get(qid)?.question_type === t);
  let c1p = 0, c1t = 0, c2p = 0, c2t = 0;
  for (const qid of qids_t) {
    const d1 = byQ[qid]?.C1;
    const d2 = byQ[qid]?.C2;
    if (d1?.scoreStrict != null) { c1p += d1.scoreStrict; c1t++; }
    if (d2?.scoreStrict != null) { c2p += d2.scoreStrict; c2t++; }
  }
  const diff = c1t > 0 && c2t > 0 ? c2p - c1p : 0;
  md += `| ${t} | ${c1p}/${c1t} | ${c2p}/${c2t} | ${diff > 0 ? '+' : ''}${diff} |\n`;
}

md += '\n---\n*Strict: multi-clause substring match + \\p{P}\\p{S} normalize. Lenient: number fallback.*\n';

// Write outputs
writeFileSync(join(OUT_DIR, 'compare-48.jsonl'),
  qids.map((qid) => JSON.stringify({ question_id: qid, ...byQ[qid] })).join('\n'), 'utf8');
writeFileSync(join(OUT_DIR, 'COMPARE-48.md'), md, 'utf8');
console.log('Written: compare-48.jsonl + COMPARE-48.md');
console.log(md);
