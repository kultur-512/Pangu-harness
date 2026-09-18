#!/usr/bin/env node
// scripts/eval/archive-eval-artifacts.mjs
// 评测结果与中间产物归档工具（2026-09-17，审计 R-01/R-04 配套）：
//   把 scripts/eval/** 下的结果数据与运行时产物移入 eval-archive/<原路径>，
//   对其中被 git 跟踪的文件执行 `git rm --cached`（停止跟踪，保留历史）。
//
// 保留不迁（输入 fixture / 脚本 / 文档——runner 运行依赖）：
//   oracle 数据集（longmemeval/data/）、questions.jsonl、haystacks/*.md、
//   *.mjs 脚本、COMPARE-*.md / GRADE.md 报告文档、results/schema.mjs。
//
// 幂等：源已不存在则跳过；归档目录在 .gitignore 的 eval-archive/ 下，永不被跟踪。

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const ARCHIVE = join(ROOT, 'eval-archive');

// ── 规则表：相对仓库根的路径（目录 = 整体搬迁，文件 = 单搬） ──
const RULES = {
  files: [
    'scripts/eval/compare/report.json',
    'scripts/eval/longmemeval-48/compare-48.jsonl',
    'scripts/eval/longmemeval-48/phase1.log.jsonl',
    'scripts/eval/longmemeval-90/graded.jsonl',
    'scripts/eval/longmemeval-90/phase1.log.jsonl',
    'scripts/eval/longmemeval-zhulong/answers.jsonl',
    'scripts/eval/longmemeval-zhulong/results.jsonl',
    'scripts/eval/longmemeval-zhulong/compare-results.jsonl',
    'scripts/eval/longmemeval-zhulong/product-pipeline-answers.jsonl',
    'scripts/eval/longmemeval-pi/answers.jsonl',
    'scripts/eval/longmemeval-pi/results.jsonl',
    'scripts/eval/longmemeval-claudecode/answers.jsonl',
    'scripts/eval/longmemeval-claudecode/results.jsonl',
    '.panshalach-task-state.eval.json',
  ],
  // answers-*.jsonl 按目录前缀收集（含 .bak 变体）
  answersDirs: [
    'scripts/eval/longmemeval-48',
    'scripts/eval/longmemeval-90',
  ],
  dirs: [
    'scripts/eval/longmemeval/ws',
    'scripts/eval/longmemeval-90/ws',
    'scripts/eval/longmemeval-zhulong/ws',
    'scripts/eval/longmemeval-zhulong/product-pipeline',
    'scripts/eval/longmemeval-hermes',
    'scripts/eval/results/artifacts',
    'scripts/eval/results/longmemeval',
    'scripts/eval/results/overnight-0913',
    '.panshalach-eval-tmp',
  ],
  // results/ 下的真实结果 json + mock 结果 json（schema.mjs 与 .gitignore 保留）
  resultsJsons: true,
  // .zcode/compare 只迁运行产物（out-*.txt + report.json），runner/tasks/reconstruct 脚本保留
  zcodeCompareData: true,
};

const moved = [];
const untracked = [];

function movePath(rel) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) return;
  const dst = join(ARCHIVE, rel);
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(src, dst);
  moved.push(rel);
  try {
    execSync(`git ls-files --error-unmatch -- "${rel}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync(`git rm -q -r --cached -- "${rel}"`, { cwd: ROOT, stdio: 'pipe' });
    untracked.push(rel);
  } catch { /* 未跟踪，无需 git rm */ }
}

// 1) 显式文件
for (const rel of RULES.files) movePath(rel);

// 2) answers-*.jsonl 收集
for (const dirRel of RULES.answersDirs) {
  const abs = join(ROOT, dirRel);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs)) {
    if (/^answers-.*\.jsonl$/.test(f)) movePath(join(dirRel, f));
  }
}

// 3) results/ 结果 json（*.json，除 schema.mjs 外；mock 子目录逐文件搬）
if (RULES.resultsJsons) {
  const resDir = join(ROOT, 'scripts', 'eval', 'results');
  if (existsSync(resDir)) {
    for (const f of readdirSync(resDir)) {
      if (/^\d{8}-.*\.json$/.test(f)) movePath(join('scripts', 'eval', 'results', f));
    }
    const mockDir = join(resDir, 'mock');
    if (existsSync(mockDir)) {
      for (const f of readdirSync(mockDir)) {
        if (/\.json$/.test(f)) movePath(join('scripts', 'eval', 'results', 'mock', f));
      }
    }
  }
}

// 4) 整目录搬迁
for (const rel of RULES.dirs) movePath(rel);

// 4b) .zcode/compare 运行产物（脚本保留）
if (RULES.zcodeCompareData) {
  const cmp = join(ROOT, '.zcode', 'compare');
  if (existsSync(cmp)) {
    for (const f of readdirSync(cmp)) {
      if (/^out-.*\.txt$/.test(f) || f === 'report.json') {
        movePath(join('.zcode', 'compare', f));
      }
    }
  }
}

// 5) longmemeval-90 下残留 tmp-* 目录
const lme90 = join(ROOT, 'scripts', 'eval', 'longmemeval-90');
if (existsSync(lme90)) {
  for (const f of readdirSync(lme90)) {
    if (/^tmp-/.test(f)) movePath(join('scripts', 'eval', 'longmemeval-90', f));
  }
}

// 6) 迁空后清掉残留空目录（迁移目录的父壳）
for (const rel of ['scripts/eval/longmemeval', 'scripts/eval/results/mock', 'scripts/eval/longmemeval-zhulong', 'scripts/eval/longmemeval-pi', 'scripts/eval/longmemeval-claudecode', '.zcode']) {
  const abs = join(ROOT, rel);
  try {
    if (existsSync(abs) && readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
  } catch {}
}

console.log(`归档完成：${moved.length} 个路径 → ${ARCHIVE}`);
console.log(`其中解除 git 跟踪：${untracked.length} 个（git rm --cached，历史保留）`);
for (const rel of moved) console.log('  →', rel);
