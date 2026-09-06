// scripts/check-protected-files.mjs
// Run with: node scripts/check-protected-files.mjs
// 保护契约检查（backlog D3）：merge 前强制核对三个契约文件的关键声明未被无声明修改。
//   1) src/PanshalachChaser.ts            — solveIssue 签名前缀（调用方依赖）
//   2) src/cli/repl/types.ts              — TurnStopReason 枚举六值（0.7 三态语义，R6 评测 schema 依赖）
//   3) src/memory/RefinedMemoryCard.ts    — RefinedMemoryCard 核心字段（id / kind / memoryCategory
//                                           —— 身份、种类 taxonomy、tier 可见性分类三层契约）
// 任一违约：打印违约项并以非零码退出；全部通过打印 PASS 退出 0。
// 注意：只检查"声明存在"，不做语义校验——字段类型细化（向后兼容方向）不算违约。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const violations = [];
const lines = [];

function CHECK(label, ok) {
  const line = `CHECK ${label.padEnd(64)}: ${ok ? 'OK' : 'FAIL'}`;
  lines.push(line);
  if (!ok) violations.push(label);
}

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; }
}

// ==================== 1) PanshalachChaser.solveIssue 签名 ====================
const chaserSrc = read('src/PanshalachChaser.ts');
const SOLVE_ISSUE_PREFIX = 'async solveIssue(issueDescription: string, workspaceRoot: string';
if (chaserSrc === null) {
  CHECK('src/PanshalachChaser.ts exists', false);
} else {
  CHECK(`PanshalachChaser.solveIssue signature ("${SOLVE_ISSUE_PREFIX}...")`, chaserSrc.includes(SOLVE_ISSUE_PREFIX));
}

// ==================== 2) TurnStopReason 枚举（0.7 六值，以实际枚举为准） ====================
const typesSrc = read('src/cli/repl/types.ts');
const STOP_REASONS = ['completed', 'answered', 'max-steps', 'consecutive-failures', 'aborted', 'no-verification'];
if (typesSrc === null) {
  CHECK('src/cli/repl/types.ts exists', false);
} else {
  const m = typesSrc.match(/export\s+type\s+TurnStopReason\s*=\s*([\s\S]*?)\s*;/);
  if (!m) {
    CHECK('TurnStopReason enum declared in src/cli/repl/types.ts', false);
  } else {
    const body = m[1];
    for (const v of STOP_REASONS) {
      CHECK(`TurnStopReason includes '${v}'`, body.includes(`'${v}'`));
    }
  }
}

// ==================== 3) RefinedMemoryCard 核心字段 ====================
const cardSrc = read('src/memory/RefinedMemoryCard.ts');
if (cardSrc === null) {
  CHECK('src/memory/RefinedMemoryCard.ts exists', false);
} else {
  const iface = cardSrc.match(/export\s+interface\s+RefinedMemoryCard\s*\{([\s\S]*?)\n\}/);
  const body = iface ? iface[1] : '';
  CHECK('RefinedMemoryCard interface declared', !!iface);
  // 核心字段契约（2.7 定稿的三层：身份 / 种类 / 记忆类别）
  const CORE_FIELDS = [
    ['id',             /(^|\n)\s*id:\s*string\s*[,;]/],
    ['kind',           /(^|\n)\s*kind\?\s*:\s*'failure'\s*\|\s*'success'\s*\|\s*'preference'/],
    ['memoryCategory', /(^|\n)\s*memoryCategory\?\s*:\s*MemoryCategory/],
  ];
  for (const [name, re] of CORE_FIELDS) {
    CHECK(`RefinedMemoryCard core field "${name}"`, re.test(body));
  }
}

// ==================== 汇总 ====================
console.log('=== Protected Files Contract Check (D3) ===');
for (const l of lines) console.log(l);
if (violations.length > 0) {
  console.log('\nVIOLATIONS（保护契约被无声明修改，merge 前必须恢复或走契约变更评审）:');
  violations.forEach((v) => console.log('  VIOLATION:', v));
  console.log('PROTECTED-FILES OVERALL: FAIL');
  process.exit(1);
}
console.log('PROTECTED-FILES OVERALL: PASS');
process.exit(0);
