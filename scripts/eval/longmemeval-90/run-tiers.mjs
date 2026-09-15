#!/usr/bin/env node
// scripts/eval/longmemeval-90/run-tiers.mjs
// 内置 tier 六档扫描：对每个 tier 跑 ZL 产品管线 90 题（默认 1B），
// 观察 tier（纪律注入强度 / 记忆加载级别 / 步数上限 / 强模式）对 LME 召回的影响。
//
// 依赖：CLI 支持 PANSHA_TIER（src/cli/repl.ts runOneShot 经 modelSeed.envTier 读取）。
//
// 用法：
//   node --import tsx scripts/eval/longmemeval-90/run-tiers.mjs            # 全部六档
//   node --import tsx scripts/eval/longmemeval-90/run-tiers.mjs quick max  # 只跑指定档
// 环境变量：PANSHA_MODEL（默认 openpangu:openpangu-embedded-1b-i1 本地 1B）
//
// 断点续跑：run-product.mjs 内部按 question_id 跳过已完成题（同 label 重跑续接）。

import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(process.cwd());
const RUNNER = join(ROOT, 'scripts', 'eval', 'longmemeval-90', 'run-product.mjs');
const ALL_TIERS = ['quick', 'standard', 'high', 'max', 'ex', 'pangu'];

const argv = process.argv.slice(2);
const tiers = argv.length ? argv : ALL_TIERS;

function runTier(tier) {
  return new Promise((res) => {
    const env = { ...process.env, PANSHA_TIER: tier };
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', RUNNER, '--label', `tier-${tier}`],
      { env, cwd: ROOT, stdio: 'inherit', windowsHide: true },
    );
    child.on('close', (code) => res(code ?? 0));
    child.on('error', (e) => {
      console.error(`[run-tiers] tier=${tier} spawn 失败:`, e.message);
      res(1);
    });
  });
}

(async () => {
  console.log(`[run-tiers] 档位: ${tiers.join(' ')} · 模型: ${process.env.PANSHA_MODEL || '1B（默认）'}`);
  for (const t of tiers) {
    console.log(`\n========== tier=${t} ==========`);
    const code = await runTier(t);
    if (code !== 0) console.error(`[run-tiers] tier=${t} 退出码 ${code}`);
  }
  console.log('\n[run-tiers] 完成。判分：');
  for (const t of tiers) {
    console.log(`node scripts/eval/longmemeval-90/grade.mjs answers-tier-${t}.jsonl`);
  }
})();
