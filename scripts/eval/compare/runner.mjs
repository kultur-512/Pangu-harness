// zl vs cc 批量对比 runner：每任务 setup 两份隔离工作区（D:zl / P:cc），
// 并行跑两 agent（M3），verify 产物，输出矩阵。
// 用法：node runner.mjs [--only id1,id2] [--conc N] [--skip-cc]
import { TASKS } from './tasks.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx > -1 ? args[onlyIdx + 1].split(',') : null;
const concIdx = args.indexOf('--conc');
const CONC = concIdx > -1 ? Number(args[concIdx + 1]) : 3;
const SKIP_CC = args.includes('--skip-cc');
const SKIP_ZL = args.includes('--skip-zl');

const ENV_MINIMAX = {
  PANSHA_MODEL: 'minimax:MiniMax-M3',
  PANSHA_MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  PANSHA_MINIMAX_BASE_URL: 'https://api.minimaxi.com/v1',
  PANSHA_MINIMAX_MODEL: 'MiniMax-M3',
  PANSHA_APPROVAL: 'full',
};

const ZL_TSX = 'P:/MY_codes/Pangu/node_modules/tsx/dist/loader.mjs';
const ZL_CLI = 'P:/MY_codes/Pangu/src/cli.ts';

function runCmd(cmd, args, opts) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, { ...opts, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', lastOut = Date.now();
    const finish = (code) => { if (!runCmd._done) { runCmd._done = true; try { cp.kill(); } catch {} resolve({ code, stdout, stderr }); } };
    runCmd._done = false;
    const timer = setTimeout(() => finish(code0(opts.timeoutMs || 600000)), opts.timeoutMs || 600000);
    const quiet = setInterval(() => { if (Date.now() - lastOut > 30000 && stdout.length > 0) finish(0); }, 5000);
    const tick = (d) => { stdout += d; lastOut = Date.now(); };
    cp.stdout?.on('data', tick);
    cp.stderr?.on('data', d => { stderr += d; lastOut = Date.now(); });
    cp.on('close', (code) => { clearTimeout(timer); clearInterval(quiet); resolve({ code, stdout, stderr }); });
    cp.on('error', (e) => { clearTimeout(timer); clearInterval(quiet); resolve({ code: -1, stdout, stderr: String(e) }); });
    if (opts.input) { try { cp.stdin.write(opts.input); } catch {} }
    try { cp.stdin.end(); } catch {}
    function code0(ms) { return 124; }
  });
}

async function runZL(ws, taskFile) {
  const t0 = Date.now();
  const r = await runCmd(process.execPath, ['--import', 'file:///p:/MY_codes/Pangu/node_modules/tsx/dist/loader.mjs', ZL_CLI, '--headless', 'run', '@' + taskFile], {
    cwd: ws, timeoutMs: 600000,
    env: { ...process.env, ...ENV_MINIMAX, PANSHA_HEADLESS: '1' },
  });
  return { ms: Date.now() - t0, stdout: r.stdout, exit: r.code };
}

async function runCC(ws, prompt) {
  const t0 = Date.now();
  const r = await runCmd('claude.cmd', ['--print', '--dangerously-skip-permissions'], {
    cwd: ws, timeoutMs: 600000, shell: true, input: prompt,
  });
  return { ms: Date.now() - t0, stdout: r.stdout, exit: r.code };
}

// 并发队列
async function pool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: n }, async () => {
    while (queue.length > 0) {
      const it = queue.shift();
      await fn(it);
    }
  });
  await Promise.all(workers);
}

const results = [];
await pool(TASKS.filter(t => !ONLY || ONLY.includes(t.id)), CONC, async (task) => {
  const zlWs = 'D:/zl-tasks/' + task.id;
  const ccWs = 'P:/cc-tasks/' + task.id;
  console.log(`\n[${task.id}] (${task.size}) setup...`);
  for (const ws of [zlWs, ccWs]) { rmSync(ws, { recursive: true, force: true }); mkdirSync(ws, { recursive: true }); task.setup(ws); }

  console.log(`[${task.id}] running ${SKIP_ZL ? 'cc' : 'zl + cc'}...`);
  const ccP = SKIP_CC ? Promise.resolve({ ms: 0, stdout: '(skipped)', exit: 0 }) : runCC(ccWs, task.prompt);
  const zlP = SKIP_ZL ? Promise.resolve({ ms: 0, stdout: '(skipped)', exit: 0 }) : runZL(zlWs, join(zlWs, 'task.txt'));
  const [zl, cc] = await Promise.all([zlP, ccP]);

  const zlV = task.verify(zlWs);
  const ccV = task.verify(ccWs);
  const row = {
    id: task.id, size: task.size,
    zl: { ms: zl.ms, exit: zl.exit, ...Object.fromEntries([['ok', zlV[0]], ['detail', zlV[1]]]) },
    cc: { ms: cc.ms, exit: cc.exit, ...Object.fromEntries([['ok', ccV[0]], ['detail', ccV[1]]]) },
    zlAnswerHead: String(zl.stdout.split('已通过验证')[0] ?? '').slice(-150),
    ccAnswerHead: cc.stdout.slice(0, 150),
  };
  results.push(row);
  console.log(`[${task.id}] zl: ${zlV[0] ? 'PASS' : 'FAIL'} (${(zl.ms / 1000).toFixed(0)}s) ${zlV[1]} | cc: ${ccV[0] ? 'PASS' : 'FAIL'} (${(cc.ms / 1000).toFixed(0)}s) ${ccV[1]}`);
  // 保存两 agent 回复全文
  writeFileSync(`P:/MY_codes/Pangu/.zcode/compare/out-${task.id}-zl.txt`, zl.stdout);
  writeFileSync(`P:/MY_codes/Pangu/.zcode/compare/out-${task.id}-cc.txt`, cc.stdout);
});

console.log('\n================ 矩阵 ================');
console.log('id'.padEnd(20), 'size', 'zl'.padEnd(6), 'cc'.padEnd(6), 'zl_s', 'cc_s');
for (const r of results) {
  console.log(r.id.padEnd(20), r.size.padEnd(4), (r.zl.ok ? 'PASS' : 'FAIL').padEnd(6), (r.cc.ok ? 'PASS' : 'FAIL').padEnd(6), String((r.zl.ms / 1000).toFixed(0)).padEnd(5), String((r.cc.ms / 1000).toFixed(0)));
}
const zlPass = results.filter(r => r.zl.ok).length, ccPass = results.filter(r => r.cc.ok).length;
console.log(`\n汇总：zl ${zlPass}/${results.length} | cc ${ccPass}/${results.length}`);
// 按 id 增量合并：本轮结果覆盖同名；被 --skip 的 agent 保留历史行
try {
  const rp = 'P:/MY_codes/Pangu/.zcode/compare/report.json';
  const prev = JSON.parse(readFileSync(rp, 'utf8'));
  const byId = new Map(prev.map(r => [r.id, r]));
  for (const r of results) {
    const p = byId.get(r.id) || {};
    byId.set(r.id, {
      ...p, id: r.id, size: r.size,
      zl: SKIP_ZL && p.zl ? p.zl : r.zl,
      cc: SKIP_CC && p.cc ? p.cc : r.cc,
      zlAnswerHead: SKIP_ZL && p.zlAnswerHead ? p.zlAnswerHead : r.zlAnswerHead,
      ccAnswerHead: SKIP_CC && p.ccAnswerHead ? p.ccAnswerHead : r.ccAnswerHead,
    });
  }
  writeFileSync(rp, JSON.stringify([...byId.values()], null, 2));
} catch { writeFileSync('P:/MY_codes/Pangu/.zcode/compare/report.json', JSON.stringify(results, null, 2)); }
console.log('report.json written (merged)');
