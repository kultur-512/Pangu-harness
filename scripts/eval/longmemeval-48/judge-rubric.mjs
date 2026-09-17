#!/usr/bin/env node
// scripts/eval/longmemeval-48/judge-rubric.mjs
// G5 判分侧修复：single-session-preference 的要点 rubric 判分。
//
// 背景：preference 题的 gold 是 150-300 字描述段落（"The user would prefer
// suggestions of Sony-compatible accessories... They may not prefer..."），
// strict 逐字匹配结构性不可能命中——连 Claude×M3 蒸馏卡全文内联的 A1 都是
// 0/8，8 题因此从矩阵中"消失"。
//
// rubric 口径（无 LLM、确定性）：
//   prefer 段 = gold 中 "prefer" 首次出现到 "not prefer" 之间的文本；
//   要点 = prefer 段实词（去停用词、长度 ≥4、词形还原 -s/-es 后粗对齐）；
//   回答命中要点 ≥ HIT_RATE(35%) → 1，否则 0。
//
// 用法：node judge-rubric.mjs [answers-A1.jsonl answers-E1.jsonl ...]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = import.meta.dirname;
const FILES = process.argv.slice(2).length ? process.argv.slice(2) : ['answers-A1.jsonl', 'answers-E1.jsonl', 'answers-F1.jsonl', 'answers-H1.jsonl', 'answers-I1.jsonl', 'answers-J1.jsonl'];

const STOP = new Set(['would', 'prefer', 'suggestions', 'that', 'their', 'they', 'them', 'with', 'such', 'also', 'user', 'users', 'like', 'likes', 'into', 'when', 'while', 'being', 'about', 'from', 'more', 'than', 'other', 'these', 'those', 'this', 'have', 'hasing', 'based', 'items', 'related', 'previous', 'mention', 'mentioning', 'instead', 'rather', 'might', 'could', 'should', 'answer', 'answers', 'respond', 'responds', 'responses', 'response', 'recommend', 'recommends', 'questions', 'question', 'topics', 'content', 'context', 'helpful', 'useful', 'avoid', 'avoiding', 'brand', 'brands', 'product', 'products', 'experiences', 'generally', 'typically', 'overall']);
const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(ses|xes|zes|ches|shes|s)$/, '');

const extractPreferKeywords = (gold) => {
  const g = String(gold || '');
  const start = g.toLowerCase().indexOf('prefer');
  const notIdx = g.toLowerCase().search(/may not|not prefer|doesn't|does not|dislike|avoid/);
  const preferSeg = g.slice(start === -1 ? 0 : start, notIdx === -1 ? g.length : notIdx);
  const words = preferSeg.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words.map(stem))];
};

const gradeRubric = (gold, resp) => {
  const keys = extractPreferKeywords(gold);
  if (keys.length === 0) return null;
  const r = ' ' + String(resp || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let hit = 0;
  for (const k of keys) if (r.includes(` ${k} `) || r.includes(` ${k}`)) hit++;
  return hit / keys.length >= 0.35 ? 1 : 0;
};

// headless stdout → 答案正文（与 j1-diff 同口径）
const extract = (stdout) => {
  const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.trim());
  const idx = lines.findIndex((l) => l.includes('injectedCardIds'));
  const tail = (idx >= 0 ? lines.slice(idx + 1) : lines).filter((l) => !/^✓?\s*完成/.test(l) && !/^•/.test(l) && !/^@path/.test(l));
  return tail.join(' ').trim();
};

console.log('== preference 题 rubric 重判（strict 全 0 的 8 题）==');
for (const f of FILES) {
  let file = join(OUT_DIR, f);
  let rows;
  try {
    rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  } catch { continue; }
  const pref = rows.filter((r) => r.question_type === 'single-session-preference');
  if (pref.length === 0) continue;
  let passed = 0;
  const detail = [];
  for (const r of pref) {
    const g = gradeRubric(r.gold, extract(r.stdout));
    if (g === 1) passed++;
    detail.push(`${r.question_id.slice(0, 8)}=${g}`);
  }
  console.log(`${f.replace('answers-', '').replace('.jsonl', '')}: ${passed}/${pref.length}  [${detail.join(' ')}]`);
}
