#!/usr/bin/env node
/**
 * Panshalach CLI 兼容层
 *
 * 行为：
 * - 无参数 → 启动完整交互式 REPL
 * - 有参数 → 作为 REPL 单条命令执行后退出（兼容旧 simulate/memory/review/debug-adapter）
 * 
 * 旧命令映射：
 *   panshalach simulate ...   → REPL 一次性执行 run/simulate
 *   panshalach memory ...     → REPL 一次性执行 /memory ...
 *   panshalach review ...     → REPL 一次性执行 /review ...
 */

const rawArgs = process.argv.slice(2);

/**
 * dist-fresh 启动检查：npm link 的全局 bin 指向 dist/cli.js，
 * 若 src 有比 dist 更新的改动而未重建，用户实际跑的是旧代码（实测事故：
 * dist 停在 0.7.1 构建中途，0.7.2/0.7.3 修复全部不在）。只在交互模式
 * （args 为空、stdout 为 TTY、非 headless）下打一行灰字提醒，不阻塞启动。
 */
function warnIfDistStale(): void {
  try {
    if (process.stdout.isTTY !== true || process.env.PANSHA_HEADLESS === '1') return;
    const fs = require('node:fs');
    const path = require('node:path');
    // 本文件位于 dist/cli.js（tsc 产物，rootDir=src）；src 目录 = 本文件目录的上级
    const distEntry = __filename;
    const srcDir = path.join(path.dirname(__filename), '..', 'src');
    if (!fs.existsSync(srcDir)) return; // 生产安装包可能不带 src
    const distMtime = fs.statSync(distEntry).mtimeMs;
    let stale = false;
    const walk = (dir: string): void => {
      if (stale) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(p); if (stale) return; continue; }
        if (!ent.name.endsWith('.ts')) continue;
        if (fs.statSync(p).mtimeMs > distMtime) { stale = true; return; }
      }
    };
    walk(srcDir);
    if (stale) {
      console.warn('\x1b[33m⚠ dist 落后于 src，请执行 npm run build 后再使用（当前运行的是旧构建）\x1b[0m');
    }
  } catch {} // 检查绝不阻塞启动
}
warnIfDistStale();

// Support forcing classic line mode explicitly (for users who prefer the old REPL or for diagnostics).
// Accepted: --classic, -C, --line
let forceClassic = false;
// --resume [id|last] — restore a rollout before starting the interactive REPL.
let resumeArg: string | null = null;
// --branch <name> — fork the resume target into a new branch session.
let branchArg: string | null = null;
// --headless — 兼容别名（0.8 语义反转）：非 TTY 已默认真执行，本 flag 不再
// 改变 mock 门（mock 仅 PANSHA_SMOKE=1 显式 opt-in）；保留用于兼容旧脚本。
let headlessFlag = false;
const args: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--classic' || a === '-C' || a === '--line') {
    forceClassic = true;
    continue;
  }
  if (a === '--headless') {
    headlessFlag = true;
    process.env.PANSHA_HEADLESS = '1';
    continue;
  }
  // --approval <readonly|default|full> — one-shot/headless 审批档位。
  // 默认 readonly 下写文件会被拒，headless 自动化任务需要显式提权。
  if (a === '--approval') {
    const next = rawArgs[i + 1];
    if (next && !next.startsWith('-')) {
      process.env.PANSHA_APPROVAL = next;
      i++;
    }
    continue;
  }
  if (a.startsWith('--approval=')) {
    process.env.PANSHA_APPROVAL = a.slice('--approval='.length);
    continue;
  }
  if (a === '--resume' || a === '-r') {
    const next = rawArgs[i + 1];
    resumeArg = next && !next.startsWith('-') ? next : 'last';
    if (resumeArg !== 'last') i++; // consume the id token
    continue;
  }
  if (a === '--branch' || a === '-b') {
    const next = rawArgs[i + 1];
    branchArg = next && !next.startsWith('-') ? next : `b${Date.now().toString(36)}`;
    i++; // always consume the name token (we default-generated one otherwise)
    continue;
  }
  args.push(a);
}

/**
 * 读取 stdin 全部内容（headless 模式，供 R6 eval runner 等外部调用方使用）。
 * TTY 下直接返回空字符串；非 TTY 下收集所有 chunk 后返回。
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks: string[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', () => resolve(chunks.join('')));
    if (process.stdin.readableEnded) { resolve(''); }
  });
}

async function main() {
  if (forceClassic) {
    if (args.length === 0) {
      const { startClassicRepl } = await import('./cli/repl/classicRepl.js');
      await startClassicRepl();
      return;
    } else {
      const { runClassicOneShot } = await import('./cli/repl/classicRepl.js');
      await runClassicOneShot(args);
      return;
    }
  }

  if (args.length === 0) {
    // headless + stdin：从 stdin 读取任务文本作为 run 命令输入（R6 eval runner 等）
    if (headlessFlag && !process.stdin.isTTY) {
      const stdinText = await readStdin();
      if (stdinText.trim()) {
        const { runOneShot } = await import('./cli/repl.js');
        await runOneShot(['run', stdinText.trim()]);
        return;
      }
    }
    // 进入交互 REPL（默认使用 SSE 传输 + 可能富交互界面）
    const { startRepl } = await import('./cli/repl.js');
    await startRepl(resumeArg || branchArg ? { resume: resumeArg ?? 'last', branch: branchArg ?? undefined } : undefined);
  } else {
    // 作为单条命令执行（兼容旧用法）
    const { runOneShot } = await import('./cli/repl.js');
    await runOneShot(args);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
