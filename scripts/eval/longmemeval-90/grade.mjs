#!/usr/bin/env node
// scripts/eval/longmemeval-90/grade.mjs
// 90 题 LME 统一判分器（方案一阶段 0 基建）。
//
// 口径 = compare-48.mjs 与 longmemeval-run.mjs 两代判分的合流正源：
//   strict  ：normalize（\p{P}\p{S} 剥除）+ gold 多候选拆分（括号/or/或）
//             + 复述豁免（gold 候选是问题原文子串则跳过，防拒答句误判）
//             + 短 gold（≤2 字符）词边界匹配
//   lenient ：数字回退（gold 数字串 ∩ 回答数字串任一命中）
//
// 用法：
//   node scripts/eval/longmemeval-90/grade.mjs answers-baseline.jsonl                 # 单格成绩
//   node scripts/eval/longmemeval-90/grade.mjs answers-baseline.jsonl answers-repaired.jsonl
//                                             # 双格 A/B 对照（逐题型 win/loss + 记忆链指标）
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const DIR = join(ROOT, 'scripts', 'eval', 'longmemeval-90');

const normalize = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

function goldCandidates(gold) {
  const raw = String(gold || '');
  const parts = raw.split(/[()]/).map((x) => x.trim()).filter(Boolean);
  const cands = [];
  for (const p of parts) {
    for (const x of p.split(/or|或/i)) {
      if (x.trim()) cands.push(x.trim());
    }
  }
  return cands.length ? cands : [raw];
}

function gradeStrict(gold, resp, question) {
  if (gold == null) return null;
  const r = normalize(resp);
  const q = normalize(question);
  if (!r) return 0;
  for (const cand of goldCandidates(gold)) {
    const g = normalize(cand);
    if (!g) continue;
    if (q && q.includes(g)) continue; // 复述豁免
    if (g.length <= 2) {
      if (new RegExp(`\\b${g}\\b`).test(r)) return 1;
    } else if (r.includes(g)) return 1;
  }
  return 0;
}

function gradeLenient(gold, resp) {
  if (gold == null) return null;
  const nums = (String(resp).match(/\d+/g) || []).map(Number);
  const goldNums = String(gold).match(/\d+/g)?.map(Number) || [];
  return goldNums.length && goldNums.some((gn) => nums.some((n) => n === gn)) ? 1 : 0;
}

function extractAnswer(stdout) {
  const lines = String(stdout || '').split('\n');
  let lastSummary = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/完成\s*\(\d+ms\)\s*·\s*(已回复|已通过验证|未通过验证|任务执行失败)/.test(lines[i])) lastSummary = i;
  }
  if (lastSummary === -1) return String(stdout || '').slice(-500);
  return lines.slice(lastSummary + 1)
    .filter((l) => !/^\[memory\]/.test(l) && !/^NO_TOOL_CALLS/.test(l))
    .join('\n').trim();
}

function loadAnswers(file, goldByQid) {
  const out = new Map();
  for (const l of readFileSync(join(DIR, file), 'utf8').split(/\r?\n/).filter(Boolean)) {
    const r = JSON.parse(l);
    // gold 以 questions.jsonl 为唯一正源（早期 runner 行内 gold 字段曾缺失）
    if (r.gold == null && goldByQid) r.gold = goldByQid.get(r.question_id) ?? null;
    const ans = extractAnswer(r.stdout);
    out.set(r.question_id, { ...r, ans, ms: r.ms ?? 0 });
  }
  return out;
}

function pivot(rows, questions) {
  const types = [...new Set(questions.map((q) => q.question_type))].sort();
  const perType = new Map(types.map((t) => [t, { sp: 0, st: 0, lp: 0, lt: 0 }]));
  let sp = 0, st = 0, lp = 0, lt = 0, timeouts = 0, msSum = 0, msN = 0, factsSum = 0;
  for (const q of questions) {
    const r = rows.get(q.question_id);
    if (!r) continue;
    const s = gradeStrict(r.gold, r.ans, q.question);
    const l = gradeLenient(r.gold, r.ans);
    const t = perType.get(q.question_type);
    if (s != null) { t.sp += s; t.st++; sp += s; st++; }
    if (l != null) { t.lp += l; t.lt++; lp += l; lt++; }
    if (r.status === 'timeout') timeouts++;
    msSum += r.ms; msN++;
    factsSum += (typeof r.facts === 'number' ? r.facts : 0);
  }
  return { types, perType, total: { sp, st, lp, lt, timeouts, msAvg: msN ? msSum / msN : 0, factsAvg: msN ? factsSum / msN : 0 } };
}

function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('用法: grade.mjs answers-<label>.jsonl [answers-<label2>.jsonl ...]');
    process.exit(2);
  }
  const questions = readFileSync(join(DIR, 'questions.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const goldByQid = new Map(questions.map((q) => [q.question_id, q.gold]));
  const all = files.map((f) => ({ file: f, rows: loadAnswers(f, goldByQid) }));
  const pivots = all.map(({ file, rows }) => ({ file, rows, p: pivot(rows, questions) }));

  // Markdown 报告
  let md = `# LME 90题 对照\n\n> 生成: ${new Date().toISOString()}\n\n`;
  md += '| 题型 | ' + pivots.map(({ file }) => file.replace(/^answers-|\.jsonl$/g, '')).join(' | ') + ' |\n';
  md += '|' + '---|'.repeat(pivots.length + 1) + '\n';
  for (const t of pivots[0].p.types) {
    md += `| **${t}** |`;
    for (const { p } of pivots) {
      const d = p.perType.get(t);
      md += ` strict ${d.sp}/${d.st} · len ${d.lp}/${d.lt} |`;
    }
    md += '\n';
  }
  md += '| **TOTAL** |';
  for (const { p } of pivots) {
    const t = p.total;
    md += ` **strict ${t.sp}/${t.st} · len ${t.lp}/${t.lt}** |`;
  }
  md += '\n\n';
  for (const { file, p } of pivots) {
    const t = p.total;
    md += `- ${file}: timeout=${t.timeouts} 平均耗时=${(t.msAvg / 1000).toFixed(1)}s 平均落卡=${t.factsAvg.toFixed(1)}\n`;
  }

  // 双格 A/B：逐题型 win/loss
  if (pivots.length === 2) {
    const [A, B] = pivots;
    md += `\n## 逐题型 A/B 差值（${A.file} → ${B.file}，strict）\n\n`;
    md += '| 题型 | A | B | Δ |\n|---|---|---|---|\n';
    for (const t of A.p.types) {
      const a = A.p.perType.get(t), b = B.p.perType.get(t);
      const d = (b.sp - a.sp);
      md += `| ${t} | ${a.sp}/${a.st} | ${b.sp}/${b.st} | ${d > 0 ? '+' : ''}${d} |\n`;
    }
    const dTotal = B.p.total.sp - A.p.total.sp;
    md += `| **TOTAL** | ${A.p.total.sp}/${A.p.total.st} | ${B.p.total.sp}/${B.p.total.st} | **${dTotal > 0 ? '+' : ''}${dTotal}** |\n`;

    // 逐题翻转清单（A→B 变化的题）
    const flipped = [];
    for (const q of questions) {
      const ra = A.rows.get(q.question_id), rb = B.rows.get(q.question_id);
      if (!ra || !rb) continue;
      const sa = gradeStrict(ra.gold, ra.ans, q.question);
      const sb = gradeStrict(rb.gold, rb.ans, q.question);
      if (sa !== sb) flipped.push({ qid: q.question_id, type: q.question_type, a: sa, b: sb, dir: sb > sa ? 'A→B 转对' : 'A→B 转错' });
    }
    md += `\n## 逐题翻转（${flipped.length} 题）\n\n`;
    for (const f of flipped) md += `- ${f.qid} [${f.type}] ${f.a}→${f.b}（${f.dir}）\n`;
    md += '\n';
  }

  // 逐题分数 jsonl
  const outJsonl = [];
  for (const q of questions) {
    const entry = { question_id: q.question_id, question_type: q.question_type, gold: q.gold };
    for (const { file, rows } of all) {
      const r = rows.get(q.question_id);
      const label = file.replace(/^answers-|\.jsonl$/g, '');
      if (!r) { entry[label] = null; continue; }
      entry[label] = {
        strict: gradeStrict(r.gold, r.ans, q.question),
        lenient: gradeLenient(r.gold, r.ans),
        status: r.status,
        ms: r.ms,
        facts: r.facts,
        ans: r.ans.slice(0, 400),
      };
    }
    outJsonl.push(JSON.stringify(entry));
  }
  writeFileSync(join(DIR, 'graded.jsonl'), outJsonl.join('\n') + '\n', 'utf8');
  writeFileSync(join(DIR, 'GRADE.md'), md, 'utf8');
  console.log(md);
  console.log('Written: graded.jsonl + GRADE.md');
}

main();
