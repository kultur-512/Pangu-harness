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
    // review FAIL-1：or 拆分必须词界——旧 /or|或/i 把词内 or 切开
    // （information→inf+mation、transportation→transp+tation）产出词碎片候选，
    // 任意答案含同串即记 1 分（CC 4 个翻转由此虚高）。
    for (const x of p.split(/\s+or\s+|或/i)) {
      if (x.trim()) cands.push(x.trim());
    }
  }
  return cands.length ? cands : [raw];
}

/**
 * grader v2（#4a）：句子子候选切分。gold 候选拆分后（括号/or/或），对每个候选
 * 再按句末标点（[.!?;] 后接空白）拆成子候选——"30 days. 31 days (…) is also
 * acceptable." 能拆出 "30 days" 与 "31 days" 两个独立候选，任一字串命中即过
 * （对齐 compare-48 的 gradeStrict 语义）。十进制/缩写（"3.5"/"e.g."）因点后
 * 无空白不被误切。
 */
function sentenceSubCandidates(cand) {
  const raw = String(cand || '');
  const parts = raw.split(/[.!?;]\s+/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [raw];
}

function gradeStrict(gold, resp, question) {
  if (gold == null) return null;
  const r = normalize(resp);
  const q = normalize(question);
  if (!r) return 0;
  const cands = [];
  for (const cand of goldCandidates(gold)) cands.push(...sentenceSubCandidates(cand));
  for (const cand of cands) {
    const g = normalize(cand);
    if (!g) continue;
    if (q && q.includes(g)) continue; // 复述豁免
    if (g.length <= 2) {
      // grader v2（#4b）：短数字 gold 用响应数字 token 集合相等替代 \b 词界——
      // 英文连写（"3 months ago"→归一化"3months"）里 "3" 不再是孤词、\b3\b 永不
      // 命中；而中文答案数字两侧是 CJK 反而命中（系统性偏袒数字+CJK 书写风格）。
      // review FAIL-3：token 相等只防连写/进位形态（gold=3 不命中 13/30/123）；
      // 列表项编号（"2. National Geographic" 的 2）等于 gold 时旧实现仍会命中——
      // 先排除行首编号形态的 token 再比（1a8a66a6 答"5 份订阅"错答被 "2." 编号
      // 误记 1 分的防回归）。注意 r 是归一化串（标点空白已剥光），行首编号的
      // 残留形态 = 该 token 前是行首/非数字字符（"2nationalgeographic"），且
      // 该 token 后紧邻字母（编号后必跟内容词）——连写数字（"2magazines"）也
      // 是此形态，故改为：仅排除"后随字母且前为行首或非数字"的 token（连写
      // 数字是本路径要命中的正确形态，不可一并排除）。
      if (/^\d+$/.test(g)) {
        // 排除"列表编号"位置的数字 token（1a8a66a6 答"5 份订阅"被 "2." 编号误记
        // 1 分的防回归）。编号形态须在**原始响应**（resp，未归一化）上识别：
        // \d+ 后跟 . 或 ) 再跟空白；归一化串标点已剥，无法区分编号与连写。
        const listItemNums = new Set(
          (String(resp).match(/\d+[.)]\s/g) || []).map((m) => m.replace(/[.)]\s$/, ''))
        );
        const numericTokens = (r.match(/\d+/g) || []).filter((t) => !listItemNums.has(t));
        if (numericTokens.some((t) => t === g)) return 1;
      } else if (new RegExp(`\\b${g}\\b`).test(r)) {
        return 1;
      }
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

export { normalize, goldCandidates, sentenceSubCandidates, gradeStrict, gradeLenient, extractAnswer };

// 仅当作为入口直接执行时跑 main()；被 import 时（测试场景）跳过。
// 守卫 import.meta.url 等于当前 argv[1] 路径（对齐 run-eval.mjs 的入口检测惯例）。
const isDirectRun = (() => {
  try {
    const arg1 = process.argv[1];
    if (!arg1) return false;
    const url = new URL(import.meta.url).pathname.replace(/\\/g, '/');
    return url.endsWith(arg1.replace(/\\/g, '/')) || arg1.replace(/\\/g, '/').endsWith(url.split('/').pop() ?? '');
  } catch { return false; }
})();
if (isDirectRun) main();
