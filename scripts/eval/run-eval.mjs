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
//
// 契约（R6 合同）：
//   结果必含 runId / source / seedSupport / verdict / verification{signal,exitCode,commands}
//   / memory{injectedCardIds,verifiedCardIds} / prompt{chars,estimatedTokens,hash}
//   / failureTaxonomy / artifacts
//   统计用配对差 + Wilson 区间，任务实例为统计单位
//   mock 永不入真实结果表

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ── 常量 ──

const ROOT = resolve(process.cwd());
const TASKS_DIR = join(ROOT, 'tasks', 'T1-T5');
const RESULTS_DIR = join(ROOT, 'scripts', 'eval', 'results');
const MOCK_RESULTS_DIR = join(ROOT, 'scripts', 'eval', 'results', 'mock');

// 失败分类枚举（运行前冻结，R6 合同）
const FAILURE_PRIMARY = Object.freeze([
  'tool_error', 'verification_failed', 'no_verification',
  'budget_exhausted', 'aborted', 'model_refusal',
  'parse_error', 'timeout', 'infra_error',
]);

const FAILURE_SECONDARY = Object.freeze([
  'tool_output_parse', 'tool_loop', 'prompt_truncation',
  'context_overflow', 'model_hallucination', 'model_noncompliant',
  'mcp_unavailable', 'approval_denied', 'unknown',
]);

// ── CLI 参数解析 ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    tier: /** @type {'A'|'B'|'C'|'C4'|null} */ (null),
    task: /** @type {string|null} */ (null),
    source: /** @type {'real-openpangu'|'mock-smoke'} */ ('real-openpangu'),
    mock: false,
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
 * 从 tasks/T1-T5/ 目录加载任务 fixture。
 * 每个子目录对应一个任务，task.md 为描述文件。
 * @returns {Promise<Array<{id: string, tier: string, title: string, prompt: string, expected: string, workspace?: string}>>}
 */
async function loadTaskFixtures({ tier, taskId } = {}) {
  const dirs = await readdir(TASKS_DIR, { withFileTypes: true });
  const fixtures = [];

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const taskDir = join(TASKS_DIR, entry.name);
    const taskMdPath = join(taskDir, 'task.md');

    try {
      const content = await readFile(taskMdPath, 'utf8');
      const fixture = parseTaskMarkdown(content, entry.name);
      if (!fixture) continue;

      // 过滤：指定 task 或 tier
      if (taskId && fixture.id !== taskId) continue;
      if (tier && fixture.tier !== tier) continue;

      fixtures.push(fixture);
    } catch {
      console.warn(`[eval] 跳过无法读取的任务: ${entry.name}`);
    }
  }

  return fixtures;
}

/**
 * 解析 task.md 为结构化 fixture。
 * 格式：YAML-like front matter (id/tier/title) + ## 段。
 * @param {string} content
 * @param {string} dirName
 * @returns {{id: string, tier: string, title: string, prompt: string, expected: string, workspace?: string} | null}
 */
function parseTaskMarkdown(content, dirName) {
  const lines = content.split('\n');
  const meta = { id: '', tier: 'C', title: '', workspace: undefined };

  // 解析 front matter（- **key**: value）
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(/^-\s*\*\*(\w+)\*\*:\s*(.+)/);
    if (m) {
      const key = m[1];
      const val = m[2].trim();
      if (key === 'id') meta.id = val;
      else if (key === 'tier') meta.tier = val.split(/[\s（(]/)[0];  // 仅取 A/B/C/C4，去掉中文描述
      else if (key === 'title') meta.title = val;
      else if (key === 'workspace') meta.workspace = val || undefined;
    }
    if (line.startsWith('##') && !line.startsWith('## 任务描述')) break;
    if (line.startsWith('## 任务描述')) { i++; break; }
  }

  if (!meta.id) return null;

  // 提取 Prompt 段
  let prompt = '';
  let inPrompt = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ') && !line.startsWith('## Prompt')) {
      if (inPrompt) break;
    }
    if (line.startsWith('## Prompt')) { inPrompt = true; continue; }
    if (line.startsWith('## 期望行为')) break;
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
    if (line.startsWith('## ') && !line.startsWith('## 期望行为')) {
      if (inExpected) break;
    }
    if (line.startsWith('## 期望行为')) { inExpected = true; continue; }
    if (line.startsWith('## 评测标准')) break;
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
      return {
        injectMemory: true,
        overflowWindow: true,   // A 档必须真溢出
        semanticSearch: false,
        description: 'A: 记忆窗口溢出（长上下文）',
      };
    case 'B':
      return {
        injectMemory: false,    // B 档零注入——防线失败基准
        overflowWindow: false,
        semanticSearch: false,
        description: 'B: 零记忆注入（防线失败基准）',
      };
    case 'C':
      return {
        injectMemory: true,
        overflowWindow: false,
        semanticSearch: false,
        description: 'C: 完整记忆注入（当前主线）',
      };
    case 'C4':
      return {
        injectMemory: true,
        overflowWindow: false,
        semanticSearch: true,   // C4: 语义检索增强
        description: 'C4: 语义检索增强',
      };
    default:
      return ablationConfig('C');
  }
}

// ── 子进程执行（U4 完整落地） ──

/** 默认超时（ms），单任务最长 10 分钟 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 构建消融环境变量。
 * 这些 env var 传给子进程，由 harness 读取以控制行为。
 * 当前 harness 支持: PANSHA_CTX_WINDOW（窗口约束）、PANSHA_HEADLESS（headless 模式）。
 * 计划支持: PANSHA_NO_MEMORY（B 档零注入）、PANSHA_SEMANTIC_SEARCH（C4 语义检索）。
 *
 * @param {object} ablation
 * @returns {Record<string, string>}
 */
function ablationEnv(ablation) {
  const env = { ...process.env, PANSHA_HEADLESS: '1' };

  if (ablation.overflowWindow) {
    // A 档：约束窗口 8000 chars 制造真溢出（R6 合同：A 档必须真溢出）
    env.PANSHA_CTX_WINDOW = '8000';
  }

  if (!ablation.injectMemory) {
    // B 档：零注入——防线失败基准（R6 合同：B 档零注入=防线失败）
    // 注意：此 env var 为 R6 eval 计划约定，当前 harness 尚未实现。
    // 在 harness 实现前，B 档结果需人工判定为 invalid。
    env.PANSHA_NO_MEMORY = '1';
  }

  if (ablation.semanticSearch) {
    // C4 档：语义检索增强
    env.PANSHA_SEMANTIC_SEARCH = '1';
  }

  return env;
}

/**
 * 从 harness 输出中解析验证信号。
 * 优先级：ALL_TESTS_PASSED > EXIT_CODE:0 > didRealVerification > none
 *
 * @param {string} stdout
 * @param {string} stderr
 * @param {number} exitCode
 * @returns {{ signal: string, exitCode: number | null, commands: string[] }}
 */
function parseVerification(stdout, stderr, exitCode) {
  const combined = stdout + '\n' + stderr;
  const commands = [];

  // 提取验证命令
  const cmdPatterns = [
    /\b(npx tsc[^\n]*)/g,
    /\b(npm test[^\n]*)/g,
    /\b(npx tsx[^\n]*)/g,
    /\b(node[^\n]*\.(?:test|spec)\.[^\n]*)/g,
    /\b(pytest[^\n]*)/g,
    /\b(cargo test[^\n]*)/g,
    /\b(go test[^\n]*)/g,
  ];
  for (const pat of cmdPatterns) {
    let m;
    while ((m = pat.exec(combined)) !== null) {
      const cmd = m[1].trim();
      if (!commands.includes(cmd)) commands.push(cmd);
    }
  }

  // 判定验证信号
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
 *
 * @param {string} stdout
 * @returns {{ injectedCardIds: string[], verifiedCardIds: string[] }}
 */
function parseMemory(stdout) {
  const injected = [];
  const verified = [];

  // 尝试匹配 refined 统计（由 finalizeTaskMemory 输出）
  // 格式: "refined: { added: N, merged: N, written: N, capped: N }"
  const refinedMatch = stdout.match(/refined:\s*\{[^}]+\}/i);
  if (refinedMatch) {
    // 记录 refined 统计存在
  }

  // 尝试匹配 injectedCardIds
  const injectedMatch = stdout.match(/injectedCardIds[:\s]*\[([^\]]*)\]/i);
  if (injectedMatch) {
    const ids = injectedMatch[1].match(/[a-zA-Z0-9_-]+/g);
    if (ids) injected.push(...ids);
  }

  // 尝试匹配 verifiedCardIds
  const verifiedMatch = stdout.match(/verifiedCardIds[:\s]*\[([^\]]*)\]/i);
  if (verifiedMatch) {
    const ids = verifiedMatch[1].match(/[a-zA-Z0-9_-]+/g);
    if (ids) verified.push(...ids);
  }

  return { injectedCardIds: injected, verifiedCardIds: verified };
}

/**
 * 从 harness 输出中解析失败分类。
 *
 * @param {string} stdout
 * @param {string} stderr
 * @param {number} exitCode
 * @param {string} errorMessage
 * @returns {{ primary: string, secondary?: string } | undefined}
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
    return { primary: 'budget_exhausted', secondary: 'context_overflow' };
  }
  if (/tool.*error|command.*failed|execution.*failed/i.test(combined)) {
    return { primary: 'tool_error' };
  }
  if (/parse.*error|invalid.*json|malformed/i.test(combined)) {
    return { primary: 'parse_error' };
  }
  if (exitCode !== 0) {
    return { primary: 'verification_failed' };
  }
  return { primary: 'no_verification' };
}

/**
 * 执行单个任务，返回符合 R6 合同的结果记录。
 *
 * 真实模式：spawn `npx tsx src/cli.ts --headless --approval full run "<prompt>"`
 * mock 模式：预设通过数据，验证骨架跑通。
 *
 * @param {object} fixture - 任务 fixture
 * @param {object} ablation - 消融配置
 * @param {object} opts - 全局选项
 * @returns {Promise<object>} EvalResult
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
    verification: {
      signal: 'none',
      exitCode: null,
      commands: [],
    },
    memory: {
      injectedCardIds: [],
      verifiedCardIds: [],
    },
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
    result.verification.signal = 'EXIT_CODE:0';
    result.verification.exitCode = 0;
    result.verification.commands = ['npx tsc --noEmit (mock)'];
    result.memory.injectedCardIds = [`mock-card-${fixture.id}`];
    result.memory.verifiedCardIds = [`mock-verified-${fixture.id}`];
    result.artifacts = {
      trajectory: `mock/trajectories/${fixture.id}.jsonl`,
      log: `mock/logs/${fixture.id}.log`,
    };
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── real-openpangu：spawn harness 子进程 ──
  const prompt = fixture.prompt;

  // 构建命令参数
  const cliArgs = [
    'tsx', 'src/cli.ts',
    '--headless',
    '--approval', 'full',
    'run', prompt,
  ];

  console.log(`  [eval] spawn: npx ${cliArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);
  console.log(`  [eval] ablation: inject=${ablation.injectMemory} overflow=${ablation.overflowWindow} semantic=${ablation.semanticSearch}`);

  try {
    const { stdout, stderr, exitCode, error } = await spawnWithTimeout(
      'npx', cliArgs, {
        env: ablationEnv(ablation),
        cwd: fixture.workspace ? resolve(ROOT, fixture.workspace) : ROOT,
        timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      }
    );

    result.durationMs = Date.now() - startTime;

    // 解析输出
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
      if (ablation.tier === 'B' && memory.injectedCardIds.length === 0) {
        // B 档零注入 = 防线失败，不计为有效样本
        result.verdict = 'invalid';
      } else if (ablation.overflowWindow && !/(overflow|truncat|窗口|截断)/i.test(stdout)) {
        // A 档未溢出 → 不进长程结论
        result.verdict = 'not_applicable';
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
    result.failureTaxonomy = {
      primary: 'infra_error',
      secondary: err.code === 'ENOENT' ? 'unknown' : 'unknown',
    };
    console.error(`  [eval] 致命错误: ${err.message}`);
  }

  return result;
}

/**
 * spawn 子进程，带超时控制。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: Record<string,string>, cwd?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null, error?: Error }>}
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
        // 二次强制 kill
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
        resolve({
          stdout,
          stderr,
          exitCode: null,
          error: new Error(`timeout after ${opts.timeoutMs}ms`),
        });
      }
    }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // 限制 stdout 积累（防止 OOM）
      if (stdout.length > 10 * 1024 * 1024) {
        stdout = stdout.slice(-5 * 1024 * 1024); // 保留最后 5MB
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 1024) {
        stderr = stderr.slice(-512 * 1024); // 保留最后 512KB
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: code });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: null, error: err });
      }
    });
  });
}

// ── 汇总统计 ──

/**
 * 从结果列表生成汇总统计。
 * @param {object[]} results
 * @param {string} source
 * @returns {object} EvalSummary
 */
function generateSummary(results, source) {
  const byTier = { A: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
                   B: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
                   C: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
                   C4: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 } };
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

    if (r.failureTaxonomy?.primary) {
      byFailure[r.failureTaxonomy.primary] = (byFailure[r.failureTaxonomy.primary] || 0) + 1;
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
  --tier <A|B|C|C4>   消融档位（默认全部）
  --task <T1|T2|...>   指定任务（默认全部）
  --source <source>     数据来源: real-openpangu | mock-smoke（默认 real-openpangu）
  --mock                等同 --source mock-smoke
  --model <model>       模型标识（默认 openPangu-7B）
  --seed                标记支持 seed 可复现
  --help                显示帮助`);
    process.exit(0);
  }

  console.log(`[eval] R6 评测 runner 启动`);
  console.log(`[eval] 来源: ${opts.source} | 模型: ${opts.model} | seed: ${opts.seedSupport}`);
  if (opts.tier) console.log(`[eval] 档位过滤: ${opts.tier}`);
  if (opts.task) console.log(`[eval] 任务过滤: ${opts.task}`);

  // 加载任务
  const fixtures = await loadTaskFixtures({ tier: opts.tier, taskId: opts.task });
  console.log(`[eval] 加载 ${fixtures.length} 个任务 fixture:`);
  for (const f of fixtures) {
    const cfg = ablationConfig(f.tier);
    console.log(`  - ${f.id} [${f.tier}] ${f.title} (${cfg.description})`);
  }

  if (fixtures.length === 0) {
    console.log('[eval] 无匹配任务，退出');
    process.exit(0);
  }

  // 执行
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

  // 汇总
  const summary = generateSummary(results, opts.source);
  console.log(`\n[eval] === 汇总 ===`);
  console.log(`[eval] 总运行: ${summary.totalRuns} | 有效样本: ${summary.validSamples} | 通过: ${summary.passed} | 失败: ${summary.failed}`);

  // 落盘
  const outDir = opts.source === 'mock-smoke' ? MOCK_RESULTS_DIR : RESULTS_DIR;
  await mkdir(outDir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outPath = join(outDir, `${dateStr}-${opts.source}.json`);
  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      source: opts.source,
      model: opts.model,
      runnerVersion: '0.1.0',
    },
    summary,
    results,
  };

  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[eval] 结果已写入: ${relative(ROOT, outPath)}`);

  // 退出码：有失败则非零
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('[eval] 致命错误:', e);
  process.exit(2);
});