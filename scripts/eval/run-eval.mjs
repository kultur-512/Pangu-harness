// scripts/eval/run-eval.mjs
// 评测主入口（A/B/C/C4 × T1-T5）。U1 骨架：CLI + fixture 加载 + 结果落盘。
//
// 契约（R6 合同，ROADMAP-NEXT §3.1）：
//   - A 档必须真溢出（不溢出的样本标"不适用"，不进长程结论）。
//   - B 档零注入 = 防线失败，不计为有效样本。
//   - 失败分类枚举运行前冻结。
//   - 统计单位：任务实例（每条 result.runId 一个）。
//   - mock 永不入真实结果表（路径隔离）。
//   - 配对差 + Wilson 区间（实现在 U4 王浩宇的 report 脚本）。
//
// 路径：
//   results/<date>.json          ← real-openpangu 来源（不允许 smoke 前缀）
//   results/smoke-<date>.json    ← mock-smoke 来源（smoke-eval.mjs 唯一产出路径）
//
// 用法：
//   node scripts/eval/run-eval.mjs --help
//   node scripts/eval/run-eval.mjs --ablation A --task-family T1 --seed 42
//   node scripts/eval/run-eval.mjs --source mock-smoke --ablation B  # 演练模式
//
// 退出码：
//   0  全绿
//   1  schema 校验失败
//   2  provider/fixture 加载失败
//   3  路径隔离违规（应写入 smoke-* 但源是 real，反之亦然）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ABLATIONS,
  EVAL_SOURCES,
  newResult,
  validateResult,
  hashPrompt,
  stopwatch,
} from './results/schema.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..', '..');
const TASKS_DIR  = path.join(ROOT, 'tasks');
const RESULTS_DIR = path.join(ROOT, 'scripts', 'eval', 'results');

/** 极简 argv 解析（避免引 commander/yargs 依赖）。--flag 后无值 → 视为 boolean true。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      // 若下一个不是 --xxx 起头，视为值；否则视为 boolean flag
      if (next !== undefined && !next.startsWith('--')) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    } else {
      out._positional = out._positional || [];
      out._positional.push(a);
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/eval/run-eval.mjs [options]

Options:
  --source <real-openpangu|mock-smoke>   评测源（默认 real-openpangu；mock 模式不落真实表）
  --ablation <A|B|C|C4>                  单档运行；缺省 = 全部
  --task-family <T1|T2|T3|T4|T5>          单族运行；缺省 = 全部
  --seed <int>                            随机种子（默认 42）
  --model-id <provider:model>             覆盖默认模型（从 .panshalach.json 读 model 字段）
  --dry                                   只打印计划，不执行
  --help                                  本帮助

Examples:
  node scripts/eval/run-eval.mjs --dry
  node scripts/eval/run-eval.mjs --ablation A --task-family T1 --seed 42
  node scripts/eval/run-eval.mjs --source mock-smoke            # 演练模式（落 smoke-*.json）
`);
}

/** 加载 fixture（T1-T5 README 作为契约，fixture 正文由 U4 王浩宇实体化） */
function loadFixture(taskFamily, ablation) {
  const dir = path.join(TASKS_DIR, taskFamily);
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    return { ok: false, error: `missing fixture README: ${path.relative(ROOT, readme)}` };
  }
  const body = fs.readFileSync(readme, 'utf8');
  return {
    ok: true,
    body,
    // U1 阶段：从 README 提取占位 issue 文本（U4 由 fixture.md 提供 issue 字段）
    issue: `[stub] ${taskFamily} ${ablation} issue from ${path.relative(ROOT, readme)}`,
  };
}

/**
 * U1 占位 runner：调用真实 Chaser（dist/cli.js 或 tsx）跑单任务。
 * 实现将在 U4 由王浩宇 R6 runner 实体化（routes through PanshalachChaser.solveIssue）。
 *
 * @returns {Promise<{ verdict: string, stopReason: string, memory: { injectedCardIds: string[]; verifiedCardIds: string[] }, verification: { signal: string; exitCode: number; commands: string[] }, continueCount: number, lastError?: string }>}
 */
async function runOne({ taskFamily, ablation, seed, modelId }) {
  // TODO(U4): 接入 PanshalachChaser.solveIssue 真实调用
  //  - A 档：禁用记忆注入（force empty cardIds）
  //  - B 档：默认记忆 + markVerified 信号源
  //  - C 档：B + 注入预算上限
  //  - C4 档：B + n-gram 语义检索
  // 当前 U1 阶段：返回可观察的占位结构（schema 校验可过，verdict 全为 no-verification）
  return {
    verdict: 'no-verification',
    stopReason: 'no-verification',
    memory: { injectedCardIds: [], verifiedCardIds: [] },
    verification: { signal: 'NO_VERIFICATION', exitCode: 0, commands: [] },
    continueCount: 0,
  };
}

/** 主流程 */
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }

  const source = args.source || 'real-openpangu';
  const seed   = args.seed ? parseInt(args.seed, 10) : 42;
  const modelId = args['model-id'] || 'default-from-config';
  const dry    = !!args.dry;
  const wantedAblations = args.ablation ? [args.ablation] : Object.keys(ABLATIONS);
  const wantedFamilies  = args['task-family'] ? [args['task-family']] : ['T1', 'T2', 'T3', 'T4', 'T5'];

  // 参数校验
  if (!EVAL_SOURCES.includes(source)) {
    console.error(`[run-eval] invalid --source: ${source} (expected ${EVAL_SOURCES.join('|')})`);
    process.exit(2);
  }
  for (const a of wantedAblations) {
    if (!(a in ABLATIONS)) {
      console.error(`[run-eval] invalid --ablation: ${a}`);
      process.exit(2);
    }
  }
  for (const f of wantedFamilies) {
    if (!fs.existsSync(path.join(TASKS_DIR, f))) {
      console.error(`[run-eval] missing task family dir: tasks/${f}`);
      process.exit(2);
    }
  }

  // 路径隔离：source 决定输出前缀
  const today = new Date().toISOString().slice(0, 10);
  const outFile = source === 'mock-smoke' ? `smoke-${today}.json` : `${today}.json`;
  if (source === 'real-openpangu' && outFile.startsWith('smoke-')) {
    console.error(`[run-eval] PATH ISOLATION VIOLATION: real-openpangu cannot write to smoke-*`);
    process.exit(3);
  }

  console.log(`[run-eval] source=${source} seed=${seed} model=${modelId} ablations=${wantedAblations.join(',')} families=${wantedFamilies.join(',')} dry=${dry}`);

  const results = [];
  const errors = [];
  let total = 0;

  for (const ablation of wantedAblations) {
    for (const taskFamily of wantedFamilies) {
      total++;
      const taskId = `${taskFamily}-${ablation.toLowerCase()}-${seed}`;
      const fx = loadFixture(taskFamily, ablation);
      if (!fx.ok) {
        errors.push({ taskId, errors: [fx.error] });
        continue;
      }

      const r = newResult({
        source,
        ablation,
        taskFamily,
        taskId,
        seed,
        seedSupport: true,
        modelId,
      });

      const sw = stopwatch();
      const prompt = fx.issue;
      r.prompt = {
        chars: prompt.length,
        estimatedTokens: Math.ceil(prompt.length / 4),
        hash: hashPrompt(prompt),
      };

      if (!dry) {
        try {
          const out = await runOne({ taskFamily, ablation, seed, modelId });
          r.verdict = out.verdict;
          r.stopReason = out.stopReason;
          r.memory = out.memory;
          r.verification = out.verification;
          r.continueCount = out.continueCount;
          r.lastError = out.lastError;
        } catch (e) {
          r.lastError = (e && e.message) || String(e);
          r.failureTaxonomy = 'unknown';
          r.verdict = 'aborted';
          r.stopReason = 'aborted';
          errors.push({ taskId, errors: [r.lastError] });
        }
      }

      r.durationMs = sw();
      r.finishedAt = new Date().toISOString();
      r.artifacts = { rolloutJsonl: `results/${r.runId}/rollout.jsonl` };

      const v = validateResult(r);
      if (!v.ok) {
        errors.push({ taskId, errors: v.errors });
        continue;
      }
      results.push(r);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    source,
    seed,
    modelId,
    total,
    passed: results.length,
    failed: errors.length,
    ablations: ABLATIONS,
    results,
    errors,
  };

  console.log(`[run-eval] total=${total} passed=${results.length} failed=${errors.length}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(' -', e.taskId, e.errors.join('; '));
  }

  if (dry) {
    console.log('[run-eval] DRY mode — not writing');
    return;
  }

  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  } catch (e) {
    console.error(`[run-eval] mkdir failed: ${e.message}`);
    process.exit(2);
  }

  const outPath = path.join(RESULTS_DIR, outFile);
  try {
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`[run-eval] wrote ${outPath}`);
  } catch (e) {
    console.error(`[run-eval] write failed: ${e.message}`);
    process.exit(2);
  }

  if (errors.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`[run-eval] fatal: ${e.stack || e.message || e}`);
  process.exit(2);
});
