#!/usr/bin/env node
// 全面改名（Panshalach/烛龙）批量替换 — 一次性工具
//
// 命名约定（用户确认）：
//   内部代号 = 盤沙拉克 (Panshalach)：类名/文件名/存储目录/环境变量前缀/package name
//   外部产品 = 烛龙 (Zhulong)：用户可见文案/CLI bin（本脚本只处理机械层，可见文案另做）
//   最高档位 id  pangu → pangu（兼容 alias 在 TierConfig 手工加回）
//
// 映射（顺序敏感：长的/带前缀的先替换）：
//   .panshalach-memory.json → .panshalach-memory.json
//   .panshalach.json        → .panshalach.json
//   .panshalach             → .panshalach          （剩余目录段 .panshalach/）
//   PanshalachChaser        → PanshalachChaser    （类名 + import 路径 + dist 产物）
//   PanshaApp           → PanshaApp           （ink UI 组件 + 文件）
//   PANSHA_             → PANSHA_             （env + __PANSHA_INK__ + PANSHA_COMMANDS）
//   Panshalach              → Panshalach          （其余大写品牌/历史注释）
//   pangu              → pangu               （档位 id 及剩余小写；TierConfig alias 手工补）
//
// 幂等：替换串不含被替换串（.panshalach/Zhulong 无 pangu），可安全重复执行。
// 用法：node scripts/rename-panshalach-bulk.mjs
// 跳过：node_modules / dist / .git / package-lock.json 内旧名（保留 pangu bin alias，另行处理）

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PAIRS = [
  ['.panshalach-memory.json', '.panshalach-memory.json'],
  ['.panshalach.json', '.panshalach.json'],
  ['.panshalach', '.panshalach'],
  ['PanshalachChaser', 'PanshalachChaser'],
  ['PanshaApp', 'PanshaApp'],
  ['PANSHA_', 'PANSHA_'],
  ['Panshalach', 'Panshalach'],
  ['pangu', 'pangu'],
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.tmp-review', '.sandbox-test']);
const SKIP_FILES = new Set(['package-lock.json']); // 保留 pangu bin alias，单独处理

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), acc);
    } else {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

function extOk(f) {
  return /\.(ts|tsx|js|cjs|mjs|json|md|mjs|html|yml|yaml)$/.test(f) || /\.(example)$/.test(f);
}

const roots = [
  'src', 'tests', 'scripts', 'examples', 'docs',
  // 根级文件
  '.',
].map((p) => path.join(ROOT, p));

const fileList = [];
for (const r of roots) {
  if (!fs.existsSync(r)) continue;
  const st = fs.statSync(r);
  if (st.isDirectory()) walk(r, fileList);
  else if (extOk(r)) fileList.push(r);
}
const files = new Set(fileList);

let totalChanged = 0;
let totalReplacements = 0;
const changed = [];
for (const f of [...files]) {
  if (SKIP_FILES.has(path.basename(f))) continue;
  if (!fs.existsSync(f)) continue;
  if (fs.statSync(f).isDirectory()) continue;
  if (!extOk(f)) continue;
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  let text = fs.readFileSync(f, 'utf-8');
  const orig = text;
  for (const [from, to] of PAIRS) {
    if (from === to) continue;
    text = text.split(from).join(to);
  }
  if (text !== orig) {
    fs.writeFileSync(f, text, 'utf-8');
    const delta = (orig.match(/pangu/gi) || []).length - (text.match(/pangu/gi) || []).length;
    totalReplacements += Math.abs(delta);
    totalChanged++;
    changed.push(rel);
  }
}

console.log(`changed files: ${totalChanged}`);
for (const c of changed) console.log('  ', c);
console.log(`remaining 'pangu' (case-insensitive) across tree: ${grepCount()}`);

function grepCount() {
  let n = 0;
  for (const f of files) {
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) continue;
    try {
      const t = fs.readFileSync(f, 'utf-8');
      n += (t.match(/pangu/gi) || []).length;
    } catch {}
  }
  return n;
}
