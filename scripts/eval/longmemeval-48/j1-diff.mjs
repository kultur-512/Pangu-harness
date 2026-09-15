// scripts/eval/longmemeval-48/j1-diff.mjs — J1 新旧成绩对比（一次性工具）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  if (g.length <= 2) return new RegExp(`\\b${g}\\b`).test(r) || r.startsWith(g) ? 1 : 0;
  return r.includes(g) ? 1 : 0;
};
const gradeLenient = (gold, resp) => {
  if (gold == null) return null;
  const nums = (resp.match(/\d+/g) || []).map(Number);
  const goldNums = String(gold).match(/\d+/g)?.map(Number) || [];
  return goldNums.some((gn) => nums.some((n) => n === gn)) ? 1 : 0;
};
// headless stdout 结构：@path 展开 → 开始执行 → [memory] injectedCardIds → ✓ 完成 → 答案
// 答案 = injectedCardIds 行之后、跳过 "✓ 完成…" 回执行后的正文行（通常最后一行）
const extract = (stdout) => {
  const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.trim());
  const idx = lines.findIndex((l) => l.includes('injectedCardIds'));
  const tail = (idx >= 0 ? lines.slice(idx + 1) : lines).filter((l) => !/^✓?\s*完成/.test(l) && !/^•/.test(l) && !/^@path/.test(l));
  return tail.join(' ').trim();
};

function score(file, label) {
  const rows = readFileSync(join(OUT_DIR, file), 'utf8').trim().split('\n').map(JSON.parse);
  const byType = {}; let total = 0, strictN = 0, lenN = 0;
  for (const r of rows) {
    const resp = extract(r.stdout);
    const s = gradeStrict(r.gold, resp), l = gradeLenient(r.gold, resp);
    if (s == null) continue;
    byType[r.question_type] ??= { s: 0, l: 0, n: 0 };
    byType[r.question_type].s += s; byType[r.question_type].l += l; byType[r.question_type].n++;
    total++; strictN += s; lenN += l;
  }
  console.log(`== ${label} == strict: ${strictN}/${total}  lenient: ${lenN}/${total}`);
  for (const [t, v] of Object.entries(byType)) console.log(`   ${t}: ${v.s}/${v.n} (lenient ${v.l})`);
  return { rows, byType };
}

const neo = score('answers-J1.jsonl', 'J1-new (真压缩·路径修复后)');
const old = score('answers-J1-old.jsonl', 'J1-old (零注入污染版)');

// 逐题对照
console.log('\n== 逐题差异（new vs old strict）==');
let diff = 0;
for (let i = 0; i < neo.rows.length; i++) {
  const a = neo.rows[i], b = old.rows.find((r) => r.question_id === a.question_id);
  const sa = gradeStrict(a.gold, extract(a.stdout));
  const sb = b ? gradeStrict(b.gold, extract(b.stdout)) : null;
  if (sa !== sb) {
    diff++;
    console.log(`  ${a.question_id} [${a.question_type}] ${sb}→${sa}  gold=${JSON.stringify(a.gold).slice(0, 40)} new=${JSON.stringify(extract(a.stdout)).slice(0, 60)}`);
  }
}
console.log(`差异题数: ${diff}`);
