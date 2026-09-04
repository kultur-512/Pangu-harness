#!/usr/bin/env node
// 一次性迁移脚本：把旧 Panshalach 时代的资产迁到 Panshalach 时代的位置。
//
// 来源（旧名）：
//   <workspace>/.zorge.json          （项目配置）
//   <workspace>/.zorge-memory.json  （记忆卡）
//   ~/.zorge/sessions/<id>.json     （会话）
//   ~/.zorge/rollouts/<id>.jsonl    （rollout 事件）
//   ~/.zorge/file-history/<file>/    （文件历史）
//   ~/.zorge/skills/<name>/SKILL.md （技能）
//
// 目标（新名，内部代号 Panshalach）：
//   <workspace>/.panshalach.json
//   <workspace>/.panshalach-memory.json
//   ~/.panshalach/sessions/<id>.json
//   ~/.panshalach/rollouts/<id>.jsonl
//   ~/.panshalach/file-history/<file>/
//   ~/.panshalach/skills/<name>/SKILL.md
//
// 行为：
//   - 只在目标不存在时拷贝（避免覆盖新数据）
//   - 不删除旧文件，用户可手动确认后删除（位于 ~/.zorge/）
//   - 失败条目不中断整体迁移
//   - 输出可读的迁移摘要

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const OLD_HOME = path.join(HOME, '.panshalach');
const NEW_HOME = path.join(HOME, '.panshalach');

function copyIfMissing(src, dst) {
  if (!fs.existsSync(src)) return { src, dst, action: 'skip-no-src' };
  if (fs.existsSync(dst)) return { src, dst, action: 'skip-exists' };
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, dereference: false });
    return { src, dst, action: 'copied' };
  } catch (err) {
    return { src, dst, action: 'error:' + (err?.message || String(err)) };
  }
}

function migrateFile(src, dst) {
  if (!fs.existsSync(src)) return { src, dst, action: 'skip-no-src' };
  if (fs.existsSync(dst)) return { src, dst, action: 'skip-exists' };
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return { src, dst, action: 'copied' };
  } catch (err) {
    return { src, dst, action: 'error:' + (err?.message || String(err)) };
  }
}

// 通用目录拷贝（递归）
function migrateDirChildren(srcDir, dstDir) {
  const results = [];
  if (!fs.existsSync(srcDir)) return results;
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dst = path.join(dstDir, name);
    results.push(copyIfMissing(src, dst));
  }
  return results;
}

const log = [];
const cwd = process.cwd();

// 1) 项目级 .zorge.json → .panshalach.json（仅当前目录）
log.push(migrateFile(path.join(cwd, '.zorge.json'), path.join(cwd, '.panshalach.json')));
log.push(migrateFile(path.join(cwd, '.zorge-memory.json'), path.join(cwd, '.panshalach-memory.json')));

// 2) 用户级目录（sessions / rollouts / file-history / skills）
log.push(...migrateDirChildren(path.join(OLD_HOME, 'sessions'), path.join(NEW_HOME, 'sessions')));
log.push(...migrateDirChildren(path.join(OLD_HOME, 'rollouts'), path.join(NEW_HOME, 'rollouts')));
log.push(...migrateDirChildren(path.join(OLD_HOME, 'file-history'), path.join(NEW_HOME, 'file-history')));
log.push(...migrateDirChildren(path.join(OLD_HOME, 'skills'), path.join(NEW_HOME, 'skills')));

// 摘要
let copied = 0, skipped = 0, errs = 0;
for (const r of log) {
  if (r.action === 'copied') copied++;
  else if (r.action.startsWith('skip')) skipped++;
  else if (r.action.startsWith('error')) errs++;
}
console.log('=== Panshalach 资产迁移摘要 ===');
console.log(`copied: ${copied}   skipped: ${skipped}   errors: ${errs}`);
console.log('\n明细：');
for (const r of log) console.log(`  [${r.action}] ${r.src}  →  ${r.dst}`);
if (errs === 0 && copied > 0) {
  console.log('\n迁移完成。旧资产仍在 ~/.zorge/ 下，确认新位置一切正常后可手动删除。');
}
