#!/usr/bin/env node
// scripts/eval/run-eval.mjs
// R6 评测主入口：加载任务 fixture，按消融档位 A/B/C/C4 执行，
// 产出符合 R6 合同的结果记录到 scripts/eval/results/<date>.json。
//
// 用法：
//   node scripts/eval/run-eval.mjs                          # 全部 T1-T5 × C
//   node scripts/eval/run-eval.mjs --tier A                 # 仅 A 档
//   node scripts/eval/run-eval.mjs --task T1 --tier C       # 单任务
//   node scripts/eval/run-eval.mjs --mock                   # mock 模式（不连真端点）
//   node scripts/eval/run-eval.mjs --source mock-smoke      # 同 --mock
//   node scripts/eval/run-eval.mjs --dry                    # 只打印计划，不执行不写盘
//
// 契约（R6 合同）：
//   结果必含 runId / source / seedSupport / verdict / verification{signal,exitCode,commands}
//   / memory{injectedCardIds,verifiedCardIds} / prompt{chars,estimatedTokens,hash}
//   / failureTaxonomy{primary,secondary?} / artifacts
//   统计用配对差 + Wilson 区间，任务实例为统计单位
//   mock 永不入真实结果表
//
// 路径隔离（merge 注，自 zhaotianang U1 版并入）：
//   results/<date>-real-openpangu.json       ← real-openpangu 来源（不允许 mock 前缀）
//   results/mock/<date>-mock-smoke.json      ← mock-smoke 来源（smoke-eval.mjs 同款路径）
//
// Prompt 指针加载（merge 注，自 zhaotianang U1 版并入）：
//   tasks/T1-T3 的 issue.md 为实体化 issue 正文（80d3f08 起草），优先作为 prompt 源；
//   无 issue.md 时回退解析 fixture.md 的 `## Prompt` 段（T4/T5 格式）。
//
// 退出码：
//   0  全绿（或 --dry 计划打印完成）
//   1  有任务 verdict=fail
//   2  参数/fixture 加载失败
//   3  路径隔离违规（应写入 results/mock/ 但源是 real，反之亦然）

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// 导入共享 schema
// 注：schema.mjs 的 validateResult 校验的是 v0.6.5 RESULT_SCHEMA 必填集
//（ablation/taskFamily/seed...），与本 runner 的 R6 运行时字段（tier/model/timestamp）
// 尚未完全对齐——全量 schema 校验由 smoke-eval.mjs 承担；U4/U6 字段收敛后 runner 再接入。
import {
  EVAL_SOURCES,
  FAILURE_PRIMARY, FAILURE_SECONDARY,
  normalizeFailureTaxonomy,
} from './results/schema.mjs';

// ── 常量 ──

const ROOT = resolve(process.cwd());
const TASKS_DIR = join(ROOT, 'tasks');
const RESULTS_DIR = join(ROOT, 'scripts', 'eval', 'results');
const MOCK_RESULTS_DIR = join(RESULTS_DIR, 'mock');

// 默认超时（ms），单任务最长 10 分钟
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// ── CLI 参数解析 ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    tier: /** @type {'A'|'B'|'C'|'C4'|null} */ (null),
    task: /** @type {string|null} */ (null),
    source: /** @type {'real-openpangu'|'mock-smoke'} */ ('real-openpangu'),
    mock: false,
    dry: false,
    model: 'openPangu-7B',
    seedSupport: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--tier': opts.tier = args[++i]; break;
      case '--task': opts.task = args[++i]; break;
      case '--source': opts.source = args[++i]; break;
      case '--mock': opts.source = 'mock-smoke'; opts.mock = true; break;
      case '--dry': opts.dry = true; break;
      case '--model': opts.model = args[++i]; break;
      case '--seed': opts.seedSupport = true; break;
      case '--help': opts.help = true; break;
      default: break;
    }
  }

  return opts;
}

// ── 任务 fixture 加载 ──

/**
 * 从 tasks/{T1..T5}/ 目录加载任务 fixture。
 * Prompt 指针加载优先级：
 *   1. issue.md   — T1-T3 实体化后的 issue 正文（赵天昂 80d3f08 起草）
 *   2. fixture.md — `## Prompt` 段（T4/T5 wanghaoyu 格式）
 * 每个 T* 目录含 README.md（任务族契约）+ verify.sh（自动验证）。
 *
 * @returns {Promise<Array<{id: string, tier: string, title: string, prompt: string, expected: string, workspace?: string, promptSource: string}>>}
 */
async function loadTaskFixtures({ tier, taskId } = {}) {
  const dirs = await readdir(TASKS_DIR, { withFileTypes: true });
  const fixtures = [];

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    // 只匹配 T1-T5 目录
    if (!/^T\d+$/.test(entry.name)) continue;

    const taskDir = join(TASKS_DIR, entry.name);
    const issuePath = join(taskDir, 'issue.md');
    const fixturePath = join(taskDir, 'fixture.md');

    try {
      // 1) issue.md 指针加载（T1-T3）；2) 回退 fixture.md `## Prompt`（T4/T5）
      let fixture = null;
      let promptSource = '';
      let issueContent = null;
      try { issueContent = await readFile(issuePath, 'utf8'); } catch { /* 无 issue.md → 回退 */ }

      if (issueContent) {
        fixture = parseIssueMarkdown(issueContent, entry.name);
        promptSource = 'issue.md';
      } else {
        const content = await readFile(fixturePath, 'utf8');
        fixture = parseFixtureMarkdown(content, entry.name);
        promptSource = 'fixture.md';
      }
      if (!fixture) continue;

      if (!fixture.prompt) {
        console.warn(`[eval] 跳过 ${entry.name}: ${promptSource} 中无可解析 Prompt`);
        continue;
      }

      // 过滤：指定 task 或 tier
      if (taskId && fixture.id !== taskId) continue;
      if (tier && fixture.tier !== tier) continue;

      fixture.promptSource = promptSource;
      fixtures.push(fixture);
    } catch {
      console.warn(`[eval] 跳过无法读取的任务: ${entry.name}`);
    }
  }

  return fixtures;
}

/**
 * 解析 issue.md（T1-T3 实体化正文）为结构化 fixture。
 * 正文整体作为 prompt；去掉首个 H1 标题行与尾部 "Fixture 文件清单" 元信息节。
 *
 * @param {string} content
 * @param {string} dirName - 目录名如 "T1"
 * @returns {{id: string, tier: string, title: string, prompt: string, expected: string, workspace?: string} | null}
 */
function parseIssueMarkdown(content, dirName) {
  const lines = content.split('\n');

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].replace(/^T\d+\s*[—-]\s*/, '').trim() : dirName;

  const body = [];
  let sawH1 = false;
  for (const line of lines) {
    if (!sawH1 && line.startsWith('# ')) { sawH1 = true; continue; }
    // 尾部元信息节不属于 prompt
    if (line.startsWith('## Fixture 文件清单')) break;
    body.push(line);
  }

  return {
    id: dirName,
    tier: 'C',
    title,
    prompt: body.join('\n').trim(),
    expected: '',
    workspace: undefined,
  };
}

/**
 * 解析 fixture.md 为结构化 fixture（T4/T5 及早期草稿格式）。
 * 格式：头部 YAML-like front matter (- **key**: value) + `## Prompt` / `## 期望` 段。
 *
 * @param {string} content
 * @param {string} dirName - 目录名如 "T4"
 * @returns {{id: string, tier: string, title: string, prompt: string, expected: string, workspace?: string} | null}
 */
function parseFixtureMarkdown(content, dirName) {
  const lines = content.split('\n');
  const meta = { id: dirName, tier: 'C', title: '', workspace: undefined };

  // 解析 front matter（- **key**: value）
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^-\s*\*\*(\w+)\*\*:\s*(.+)/);
    if (m) {
      const key = m[1];
      const val = m[2].trim();
      if (key === 'id') meta.id = val;
      else if (key === 'tier') meta.tier = val.split(/[\s（(]/)[0];  // 仅取 A/B/C/C4
      else if (key === 'title') meta.title = val;
      else if (key === 'workspace') meta.workspace = val || undefined;
    }
    if (line.startsWith('##') && !line.startsWith('## 任务描述')) break;
    if (line.startsWith('## 任务描述')) { i++; break; }
  }

  // 提取 Prompt 段
  let prompt = '';
  let inPrompt = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ') && !line.startsWith('## Prompt')) {
      if (inPrompt) break;
    }
    if (line.startsWith('## Prompt')) { inPrompt = true; continue; }
    if (line.startsWith('## 期望')) break;
    if (inPrompt) {
      const trimmed = line.replace(/^>\s?/, '');
      if (trimmed.startsWith('```') && prompt.length > 0) break;
      if (!trimmed.startsWith('```')) prompt += (prompt ? '\n' : '') + trimmed;
    }
  }

  // 提取期望行为
  let expected = '';
  let inExpected = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ') && !line.startsWith('## 期望')) {
      if (inExpected) break;
    }
    if (line.startsWith('## 期望')) { inExpected = true; continue; }
    if (line.startsWith('## 评测标准') || line.startsWith('## 约束')) break;
    if (inExpected && line.trim() && !line.trim().startsWith('```')) {
      expected += (expected ? '\n' : '') + line.trim().replace(/^-\s*/, '');
    }
  }

  return {
    id: meta.id,
    tier: meta.tier,
    title: meta.title,
    prompt: prompt.trim(),
    expected: expected.trim(),
    workspace: meta.workspace,
  };
}

// ── 消融配置 ──

/**
 * 按消融档位返回执行参数。
 * @param {'A'|'B'|'C'|'C4'} tier
 * @returns {{ injectMemory: boolean, overflowWindow: boolean, semanticSearch: boolean, description: string }}
 */
function ablationConfig(tier) {
  switch (tier) {
    case 'A':
      return { injectMemory: true, overflowWindow: true, semanticSearch: false, description: 'A: 记忆窗口溢出（长上下文）' };
    case 'B':
      return { injectMemory: false, overflowWindow: false, semanticSearch: false, description: 'B: 零记忆注入（防线失败基准）' };
    case 'C':
      return { injectMemory: true, overflowWindow: false, semanticSearch: false, description: 'C: 完整记忆注入（当前主线）' };
    case 'C4':
      return { injectMemory: true, overflowWindow: false, semanticSearch: true, description: 'C4: 语义检索增强' };
    default:
      return ablationConfig('C');
  }
}

// ── 子进程执行 ──

/**
 * 构建消融环境变量。
 * @param {object} ablation
 * @returns {Record<string, string>}
 */
function ablationEnv(ablation) {
  const env = { ...process.env, PANSHA_HEADLESS: '1' };

  if (ablation.overflowWindow) {
    env.PANSHA_CTX_WINDOW = '8000';
  }
  if (!ablation.injectMemory) {
    // B 档：PANSHA_NO_MEMORY=1 → PromptBuilder.buildForTask({forceEmptyInjected: true})
    env.PANSHA_NO_MEMORY = '1';
  }
  if (ablation.semanticSearch) {
    // C4 档：语义检索增强（stub，赵天昂 U5/U6 接 embed.ts）
    env.PANSHA_SEMANTIC_SEARCH = '1';
  }

  return env;
}

/**
 * 从 harness 输出中解析验证信号。
 * 优先级：ALL_TESTS_PASSED > EXIT_CODE:0 > didRealVerification > none
 */
function parseVerification(stdout, stderr, exitCode) {
  const combined = stdout + '\n' + stderr;
  const commands = [];

  const cmdPatterns = [
    /\b(npx tsc[^\n]*)/g, /\b(npm test[^\n]*)/g, /\b(npx tsx[^\n]*)/g,
    /\b(node[^\n]*\.(?:test|spec)\.[^\n]*)/g, /\b(pytest[^\n]*)/g,
    /\b(cargo test[^\n]*)/g, /\b(go test[^\n]*)/g,
  ];
  for (const pat of cmdPatterns) {
    let m;
    while ((m = pat.exec(combined)) !== null) {
      const cmd = m[1].trim();
      if (!commands.includes(cmd)) commands.push(cmd);
    }
  }

  if (/ALL_TESTS_PASSED/i.test(combined)) {
    return { signal: 'ALL_TESTS_PASSED', exitCode: 0, commands };
  }
  if (exitCode === 0 && commands.length > 0) {
    return { signal: 'EXIT_CODE:0', exitCode: 0, commands };
  }
  if (exitCode === 0 && /EXIT_CODE.*0/i.test(combined)) {
    return { signal: 'EXIT_CODE:0', exitCode: 0, commands };
  }
  if (/didRealVerification/i.test(combined) || /验证(通过|成功|完成)/.test(combined)) {
    return { signal: 'didRealVerification', exitCode: exitCode === 0 ? 0 : null, commands };
  }
  if (exitCode === 0) {
    return { signal: 'EXIT_CODE:0', exitCode: 0, commands };
  }
  return { signal: 'none', exitCode: exitCode === 0 ? 0 : null, commands };
}

/**
 * 从 harness 输出中解析记忆信息。
 */
function parseMemory(stdout) {
  const injected = [];
  const verified = [];

  const injectedMatch = stdout.match(/injectedCardIds[:\s]*\[([^\]]*)\]/i);
  if (injectedMatch) {
    const ids = injectedMatch[1].match(/[a-zA-Z0-9_-]+/g);
    if (ids) injected.push(...ids);
  }

  const verifiedMatch = stdout.match(/verifiedCardIds[:\s]*\[([^\]]*)\]/i);
  if (verifiedMatch) {
    const ids = verifiedMatch[1].match(/[a-zA-Z0-9_-]+/g);
    if (ids) verified.push(...ids);
  }

  return { injectedCardIds: injected, verifiedCardIds: verified };
}

/**
 * 从 harness 输出中解析失败分类（双层：primary + secondary?）。
 * 枚举名与 schema.mjs FAILURE_PRIMARY/FAILURE_SECONDARY 对齐（kebab-case）。
 */
function parseFailure(stdout, stderr, exitCode, errorMessage) {
  const combined = stdout + '\n' + stderr;

  if (errorMessage?.includes('timeout') || errorMessage?.includes('ETIMEDOUT')) {
    return { primary: 'timeout' };
  }
  if (errorMessage?.includes('abort') || errorMessage?.includes('ABORT')) {
    return { primary: 'aborted' };
  }
  if (/budget.*exhausted|context.*overflow|token.*limit/i.test(combined)) {
    return { primary: 'budget-exhausted', secondary: 'context-overflow' };
  }
  if (/tool.*error|command.*failed|execution.*failed/i.test(combined)) {
    return { primary: 'tool-error' };
  }
  if (/parse.*error|invalid.*json|malformed/i.test(combined)) {
    return { primary: 'parse-error' };
  }
  if (exitCode !== 0) {
    return { primary: 'verification-failed' };
  }
  return { primary: 'no-verification' };
}

// ── 核心执行 ──

/**
 * 执行单个任务，返回符合 R6 合同的结果记录。
 */
async function runOne(fixture, ablation, opts) {
  const runId = randomUUID();
  const startTime = Date.now();

  /** @type {object} */
  const result = {
    runId,
    source: opts.source,
    tier: fixture.tier,
    taskId: fixture.id,
    model: opts.model,
    seedSupport: opts.seedSupport,
    timestamp: new Date().toISOString(),
    durationMs: 0,
    verdict: 'fail',
    verification: { signal: 'none', exitCode: null, commands: [] },
    memory: { injectedCardIds: [], verifiedCardIds: [] },
    prompt: {
      chars: fixture.prompt.length,
      estimatedTokens: Math.ceil(fixture.prompt.length / 4),
      hash: createHash('sha256').update(fixture.prompt).digest('hex').slice(0, 8),
    },
    failureTaxonomy: undefined,
    artifacts: {},
  };

  // ── mock-smoke：预设通过数据 ──
  if (opts.source === 'mock-smoke') {
    result.verdict = 'pass';
    result.verification = { signal: 'EXIT_CODE:0', exitCode: 0, commands: ['npx tsc --noEmit (mock)'] };
    result.memory = {
      injectedCardIds: [`mock-card-${fixture.id}`],
      verifiedCardIds: [`mock-verified-${fixture.id}`],
    };
    result.artifacts = {
      trajectory: `mock/trajectories/${fixture.id}.jsonl`,
      log: `mock/logs/${fixture.id}.log`,
    };
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── real-openpangu：spawn harness 子进程 ──
  const isWin = process.platform === 'win32';
  const cliArgs = [
    'tsx', 'src/cli.ts',
    '--headless',
    '--approval', 'full',
    'run', fixture.prompt,
  ];

  console.log(`  [eval] spawn: npx ${cliArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);
  console.log(`  [eval] ablation: inject=${ablation.injectMemory} overflow=${ablation.overflowWindow} semantic=${ablation.semanticSearch}`);

  try {
    const { stdout, stderr, exitCode, error } = await spawnWithTimeout(
      isWin ? 'npx.cmd' : 'npx', cliArgs, {
        env: ablationEnv(ablation),
        cwd: fixture.workspace ? resolve(ROOT, fixture.workspace) : ROOT,
        timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      }
    );

    result.durationMs = Date.now() - startTime;

    if (error) {
      console.warn(`  [eval] 子进程错误: ${error.message}`);
      result.failureTaxonomy = parseFailure(stdout, stderr, exitCode ?? 1, error.message);
      result.verdict = 'fail';
      result.verification = { signal: 'none', exitCode: exitCode ?? null, commands: [] };
    } else {
      const verification = parseVerification(stdout, stderr, exitCode ?? 1);
      const memory = parseMemory(stdout);

      result.verification = verification;
      result.memory = memory;

      // 判定 verdict
      if (ablation.injectMemory === false && memory.injectedCardIds.length === 0) {
        result.verdict = 'invalid';  // B 档零注入 = 防线失败
      } else if (ablation.overflowWindow && !/(overflow|truncat|窗口|截断)/i.test(stdout)) {
        result.verdict = 'not_applicable';  // A 档未溢出
      } else if (verification.signal !== 'none') {
        result.verdict = 'pass';
      } else {
        result.verdict = 'fail';
        result.failureTaxonomy = parseFailure(stdout, stderr, exitCode ?? 1, '');
      }
    }

    // 记录产物
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const artifactDir = join(RESULTS_DIR, 'artifacts', `${dateStr}-${fixture.id}-${runId.slice(0, 8)}`);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, 'stdout.txt'), stdout, 'utf8');
    await writeFile(join(artifactDir, 'stderr.txt'), stderr, 'utf8');
    await writeFile(join(artifactDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');

    result.artifacts = {
      stdout: relative(ROOT, join(artifactDir, 'stdout.txt')),
      stderr: relative(ROOT, join(artifactDir, 'stderr.txt')),
      result: relative(ROOT, join(artifactDir, 'result.json')),
    };

  } catch (err) {
    result.durationMs = Date.now() - startTime;
    result.verdict = 'fail';
    result.failureTaxonomy = { primary: 'infra-error', secondary: 'unknown' };
    console.error(`  [eval] 致命错误: ${err.message}`);
  }

  return result;
}

/**
 * spawn 子进程，带超时控制。
 */
function spawnWithTimeout(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: opts.env || process.env,
      cwd: opts.cwd || ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
        resolve({ stdout, stderr, exitCode: null, error: new Error(`timeout after ${opts.timeoutMs}ms`) });
      }
    }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 10 * 1024 * 1024) stdout = stdout.slice(-5 * 1024 * 1024);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (!settled) { settled = true; resolve({ stdout, stderr, exitCode: code }); }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (!settled) { settled = true; resolve({ stdout, stderr, exitCode: null, error: err }); }
    });
  });
}

// ── 汇总统计 ──

function generateSummary(results, source) {
  const byTier = {
    A: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
    B: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
    C: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
    C4: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
  };
  const byFailure = {};
  let passed = 0, failed = 0, validSamples = 0;

  for (const r of results) {
    const t = byTier[r.tier];
    if (!t) continue;
    t.total++;
    if (r.verdict === 'pass') { t.passed++; passed++; validSamples++; }
    else if (r.verdict === 'fail') { t.failed++; failed++; validSamples++; }
    else if (r.verdict === 'invalid') { t.invalid++; }
    else if (r.verdict === 'not_applicable') { t.notApplicable++; }

    // 双层 taxonomy：统计 primary（枚举漂移守卫，merge 注）
    const tax = normalizeFailureTaxonomy(r.failureTaxonomy);
    if (tax?.primary) {
      if (!FAILURE_PRIMARY.includes(tax.primary)) {
        console.warn(`[eval] warning: failureTaxonomy.primary "${tax.primary}" 不在 FAILURE_PRIMARY 枚举（schema 漂移?）`);
      }
      byFailure[tax.primary] = (byFailure[tax.primary] || 0) + 1;
    }
    if (tax?.secondary !== undefined && !FAILURE_SECONDARY.includes(tax.secondary)) {
      console.warn(`[eval] warning: failureTaxonomy.secondary "${tax.secondary}" 不在 FAILURE_SECONDARY 枚举（schema 漂移?）`);
    }
  }

  return {
    summaryId: randomUUID(),
    generatedAt: new Date().toISOString(),
    source,
    totalRuns: results.length,
    validSamples,
    passed,
    failed,
    byTier,
    byFailure,
    runIds: results.map(r => r.runId),
  };
}

// ── 主入口 ──

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`用法: node scripts/eval/run-eval.mjs [选项]

选项:
  --tier <A|B|C|C4>    消融档位（默认全部；tier 取自 fixture 元数据，缺省 C）
  --task <T1|T2|...>   指定任务（默认全部）
  --source <source>    数据来源: real-openpangu | mock-smoke（默认 real-openpangu）
  --mock               等同 --source mock-smoke
  --dry                只打印计划，不执行、不写盘
  --model <model>      模型标识（默认 openPangu-7B）
  --seed               标记支持 seed 可复现
  --help               显示帮助`);
    process.exit(0);
  }

  // 参数校验（merge 注，自 zhaotianang U1 版并入）
  if (!EVAL_SOURCES.includes(opts.source)) {
    console.error(`[eval] invalid --source: ${opts.source} (expected ${EVAL_SOURCES.join('|')})`);
    process.exit(2);
  }

  console.log(`[eval] R6 评测 runner 启动`);
  console.log(`[eval] 来源: ${opts.source} | 模型: ${opts.model} | seed: ${opts.seedSupport}`);
  if (opts.tier) console.log(`[eval] 档位过滤: ${opts.tier}`);
  if (opts.task) console.log(`[eval] 任务过滤: ${opts.task}`);

  const fixtures = await loadTaskFixtures({ tier: opts.tier, taskId: opts.task });
  console.log(`[eval] 加载 ${fixtures.length} 个任务 fixture:`);
  for (const f of fixtures) {
    const cfg = ablationConfig(f.tier);
    console.log(`  - ${f.id} [${f.tier}] ${f.title} (prompt ← ${f.promptSource}) (${cfg.description})`);
  }

  if (fixtures.length === 0) {
    console.log('[eval] 无匹配任务，退出');
    process.exit(0);
  }

  if (opts.dry) {
    console.log('[eval] DRY mode — 不执行、不写盘');
    process.exit(0);
  }

  const results = [];
  for (const fixture of fixtures) {
    const cfg = ablationConfig(fixture.tier);
    console.log(`\n[eval] === ${fixture.id} [${fixture.tier}] ${fixture.title} ===`);
    console.log(`[eval] 配置: ${cfg.description}`);
    console.log(`[eval] Prompt (${fixture.prompt.length} chars): ${fixture.prompt.slice(0, 100)}...`);

    const result = await runOne(fixture, cfg, opts);
    results.push(result);
    console.log(`[eval] 结果: verdict=${result.verdict} signal=${result.verification.signal} duration=${result.durationMs}ms`);
  }

  const summary = generateSummary(results, opts.source);
  console.log(`\n[eval] === 汇总 ===`);
  console.log(`[eval] 总运行: ${summary.totalRuns} | 有效样本: ${summary.validSamples} | 通过: ${summary.passed} | 失败: ${summary.failed}`);

  // 输出路径（source 决定目录：mock → results/mock/，real → results/）
  const outDir = opts.source === 'mock-smoke' ? MOCK_RESULTS_DIR : RESULTS_DIR;
  // 路径隔离不变量（merge 注，自 zhaotianang U1 版并入；exit 3 契约）：
  // real-openpangu 源不得落入 results/mock/
  if (opts.source !== 'mock-smoke' && outDir === MOCK_RESULTS_DIR) {
    console.error('[eval] PATH ISOLATION VIOLATION: real-openpangu cannot write into results/mock/');
    process.exit(3);
  }
  await mkdir(outDir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outPath = join(outDir, `${dateStr}-${opts.source}.json`);
  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      source: opts.source,
      model: opts.model,
      runnerVersion: '0.2.0',
    },
    summary,
    results,
  };

  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[eval] 结果已写入: ${relative(ROOT, outPath)}`);
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('[eval] 致命错误:', e);
  process.exit(2);
});
