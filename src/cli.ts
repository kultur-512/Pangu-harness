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

// Support forcing classic line mode explicitly (for users who prefer the old REPL or for diagnostics).
// Accepted: --classic, -C, --line
let forceClassic = false;
// M2.2: --resume [id|last] — restore a rollout before starting the interactive REPL.
let resumeArg: string | null = null;
// P3-3.5: --branch <name> — fork the resume target into a new branch session.
let branchArg: string | null = null;
// dogfood-①: --headless — explicit escape hatch for the isTTY mock gate.
// Set BEFORE any engine import so isSmokeEnvironment() reads it on first call.
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
    process.env.ZORGE_HEADLESS = '1';
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
