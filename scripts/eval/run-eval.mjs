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
// U4 字段收敛：runOne 返回结构与 RESULT_SCHEMA 对齐，写盘前跑 validateResult 校验。
import {
  ABLATIONS,
  EVAL_SOURCES,
  FAILURE_PRIMARY, FAILURE_SECONDARY,
  normalizeFailureTaxonomy,
  validateResult,
  hashPrompt,
  stopwatch,
  EVAL_VERDICTS,
} from './results/schema.mjs';

/** 当前 runner 对应的 panshalach 版本（证据链必填） */
const PANSHALACH_VERSION = '0.7.4';

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
    seedMemory: /** @type {string|null} */ (null),
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
      // R6 follow-up #1: --seed-memory <json>  预填业务记忆到 B/C/C4 档 per-run 文件
      case '--seed-memory': opts.seedMemory = args[++i]; break;
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
 * fixture.tier 是任务族元数据（展示用），不参与消融配对。
 *
 * @returns {Promise<Array<{id: string, tier: string, title: string, prompt: string, expected: string, workspace?: string, promptSource: string}>>}
 */
async function loadTaskFixtures({ taskId } = {}) {
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

      // 过滤：仅按 task 过滤（U5 重构：fixture.tier 是任务族元数据，不再决定消融配对；
      // 消融维度由 --tier 在 main() 里过滤）
      if (taskId && fixture.id !== taskId) continue;

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
 * @param {'A'|'B'|'C'|'C4'} key
 * @returns {{ key: string, injectMemory: boolean, overflowWindow: boolean, semanticSearch: boolean, description: string }}
 */
function ablationConfig(key) {
  switch (key) {
    case 'A':
      // A = baseline（无记忆、无 refine，必须真溢出）——对齐 schema.mjs ABLATIONS 合同
      return { key: 'A', injectMemory: false, overflowWindow: true, semanticSearch: false, description: 'A: baseline 无记忆（必须溢出）' };
    case 'B':
      // B = memory on（refine + markVerified）；零注入 = 防线失败
      return { key: 'B', injectMemory: true, overflowWindow: false, semanticSearch: false, description: 'B: 记忆开启（零注入=防线失败基准）' };
    case 'C':
      return { key: 'C', injectMemory: true, overflowWindow: false, semanticSearch: false, description: 'C: 完整记忆注入（当前主线）' };
    case 'C4':
      return { key: 'C4', injectMemory: true, overflowWindow: false, semanticSearch: true, description: 'C4: 语义检索增强' };
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
    // A 档（baseline no-memory）：PANSHA_NO_MEMORY=1 → PromptBuilder.buildForTask({forceEmptyInjected: true})
    env.PANSHA_NO_MEMORY = '1';
  }
  if (ablation.semanticSearch) {
    // C4 档：语义检索增强（stub，赵天昂 U5/U6 接 embed.ts）
    env.PANSHA_SEMANTIC_SEARCH = '1';
  }

  return env;
}

/**
 * 构建 eval 专用 TaskState 隔离 env。
 * 在 ablationEnv 基础上追加 PANSHA_TASK_ID 和 PANSHA_TASK_STATE_FILE，
 * 确保评测任务的 TaskState 写入独立文件（.panshalach-task-state.eval.json），
 * 不与用户日常任务的 .panshalach-task-state.json 串扰。
 *
 * R6 follow-up #1：再追加 PANSHA_MEMORY_FILE 指向 per-run 文件，
 * RefinedMemoryStore 只读该文件，不读默认 .panshalach-memory.json →
 * 彻底隔断跨 run 记忆泄露。
 *
 * @param {object} ablation
 * @param {string} evalTaskId - 格式 eval-<taskFamily>-<ablation>-<seed>
 * @param {string} memFileRel - per-run 记忆文件名（相对 cwd）
 * @returns {Record<string, string>}
 */
function evalAblationEnv(ablation, evalTaskId, memFileRel) {
  const env = ablationEnv(ablation);
  env.PANSHA_TASK_ID = evalTaskId;
  env.PANSHA_TASK_STATE_FILE = '.panshalach-task-state.eval.json';
  if (memFileRel) env.PANSHA_MEMORY_FILE = memFileRel;
  return env;
}

/**
 * R6 follow-up #1：默认 seed 记忆内容（B/C/C4 用，保证能注入并区分档）。
 * 当 --seed-memory 未指定时，B/C/C4 默认预写 2 张合成 success/lesson 卡，
 * 验证记忆注入链路通畅；缺 seed 的真实跑分应在 --seed-memory 传业务记忆。
 *
 * 合成卡内容对齐 RefinedMemoryCard schema（v3 记忆卡）：
 * - kind: success | lesson | constraint
 * - category: 跨实例
 * - summary: 简短中文
 * - weight/decayWeight: 1.0（最新）
 * - taskStyle/applicableTiers: 与档位无关（"all"）
 * - count/lastSeen/firstSeen/lastUsedAt: 同 now
 */
function defaultSeedMemory(now) {
  return {
    meta: { version: '1.0.0', lastUpdated: now, totalCards: 2 },
    cards: [
      {
        id: 'seed-success-001',
        kind: 'success',
        category: 'OTHER',
        memoryCategory: 'implementation',
        summary: '【seed】真实跑分前必传 --seed-memory <path> 覆盖本合成卡',
        weight: 1.0,
        taskStyle: 'all',
        count: 1,
        lastSeen: now,
        firstSeen: now,
        applicableTiers: [],
        decayWeight: 1.0,
        lastUsedAt: now,
      },
      {
        id: 'seed-lesson-001',
        kind: 'lesson',
        category: 'OTHER',
        memoryCategory: 'process',
        summary: '【seed】B/C/C4 档需真实预填业务记忆方有比较意义',
        weight: 1.0,
        taskStyle: 'all',
        count: 1,
        lastSeen: now,
        firstSeen: now,
        applicableTiers: [],
        decayWeight: 1.0,
        lastUsedAt: now,
      },
    ],
  };
}

// export 给 tests 单独验证 defaultSeedMemory 结构合法
export { defaultSeedMemory };

async function writeSeedMemory(memFileAbs, ablation, opts, now) {
  let seed;
  if (opts.seedMemory) {
    seed = JSON.parse(await readFile(opts.seedMemory, 'utf8'));
  } else if (ablation.injectMemory && !ablation.overflowWindow) {
    // B/C/C4 档:无 --seed-memory 时写默认合成 seed
    seed = defaultSeedMemory(now);
  } else {
    // A 档:不写 seed（预期 0 注入）
    return;
  }
  await writeFile(memFileAbs, JSON.stringify(seed, null, 2), 'utf8');
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
 * 优先抓 SSE/JSON 格式的 memory.finalized 事件；回退到正则文本匹配。
 */
function parseMemory(stdout) {
  const injected = [];
  const verified = [];
  const refined = { added: 0, merged: 0, written: 0, capped: 0 };

  // 优先：抓 memory.finalized 事件（JSON 行）
  const memFinalizedMatch = stdout.match(/memory\.finalized[:\s]*(\{[^\n]+\})/i);
  if (memFinalizedMatch) {
    try {
      const data = JSON.parse(memFinalizedMatch[1]);
      if (Array.isArray(data.injectedCardIds)) injected.push(...data.injectedCardIds);
      if (Array.isArray(data.verifiedCardIds)) verified.push(...data.verifiedCardIds);
      if (data.refined) {
        refined.added = data.refined.added ?? 0;
        refined.merged = data.refined.merged ?? 0;
        refined.written = data.refined.written ?? 0;
        refined.capped = data.refined.capped ?? 0;
      }
    } catch { /* JSON 解析失败，回退正则 */ }
  }

  // 回退：正则文本匹配（兼容旧输出）
  if (injected.length === 0) {
    const injectedMatch = stdout.match(/injectedCardIds[:\s]*\[([^\]]*)\]/i);
    if (injectedMatch) {
      const ids = injectedMatch[1].match(/[a-zA-Z0-9_-]+/g);
      if (ids) injected.push(...ids);
    }
  }
  if (verified.length === 0) {
    const verifiedMatch = stdout.match(/verifiedCardIds[:\s]*\[([^\]]*)\]/i);
    if (verifiedMatch) {
      const ids = verifiedMatch[1].match(/[a-zA-Z0-9_-]+/g);
      if (ids) verified.push(...ids);
    }
  }

  return { injectedCardIds: injected, verifiedCardIds: verified, refined };
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
 * 写 eval TaskState 的 nextStep 字段（成功态专用）。
 * 直接操作 .panshalach-task-state.eval.json（不依赖 TypeScript 编译产物）。
 * best-effort：任何异常不抛给调用方。
 *
 * @param {object} opts - CLI opts（含 source 判 mock）
 * @param {string} evalTaskId
 * @param {string} nextStep
 */
async function writeEvalTaskNextStep(opts, evalTaskId, nextStep, workspace) {
  if (opts.source === 'mock-smoke') return;
  try {
    const statePath = join(workspace || ROOT, '.panshalach-task-state.eval.json');
    const raw = await readFile(statePath, 'utf8');
    const file = JSON.parse(raw);
    const task = file?.tasks?.[evalTaskId];
    if (task) {
      task.nextStep = nextStep;
      task.updatedAt = Date.now();
      file.lastUpdated = Date.now();
      await writeFile(statePath, JSON.stringify(file, null, 2), 'utf8');
    }
  } catch { /* best-effort */ }
}

/**
 * 执行单个任务，返回符合 R6 合同的结果记录。
 *
 * 返回形状严格对齐 scripts/eval/results/schema.mjs 的 RESULT_SCHEMA，
 * 写盘前会跑 validateResult() 校验，失败即 exit 1。
 */
async function runOne(fixture, ablation, opts) {
  const runId = randomUUID();
  const startedAt = new Date();
  const tick = stopwatch();

  // 从 fixture id 提取 taskFamily（如 "T1" → "T1"）
  const taskFamilyMatch = fixture.id.match(/^([A-Z]\d+)/);
  const taskFamily = taskFamilyMatch ? taskFamilyMatch[1] : 'T1';

  // U2/U3: 构建 eval 专用 taskId，格式 eval-<taskFamily>-<ablation>-<seed>
  // 用于 TaskState 隔离（写入 .panshalach-task-state.eval.json），不与用户任务串扰。
  const evalTaskId = `eval-${taskFamily}-${ablation.key}-${fixture.seed ?? 42}`;

  // R6 follow-up #1：per-run 记忆文件隔离。
  // - 文件名带 runId 前8位 → 跨 run 不撞名
  // - cwd 仍 = fixture.workspace 或 ROOT（保留 fixture 任务语料）
  // - PANSHA_MEMORY_FILE 注入 → RefinedMemoryStore 只读这个文件，不漏默认 .panshalach-memory.json
  // - B/C/C4 档预写 seed；A 档不写（预期 0 注入,靠 PANSHA_NO_MEMORY=1 保证）
  // - run 后 finally 删除该文件 → 下次 run 不污染
  const memFileRel = `.panshalach-memory.eval-${runId.slice(0, 8)}.json`;
  const cwd = fixture.workspace ? resolve(ROOT, fixture.workspace) : ROOT;
  const memFileAbs = join(cwd, memFileRel);
  let memSeeded = false;
  let memCleaned = false;
  async function cleanupRunMemory() {
    if (memCleaned) return;
    memCleaned = true;
    try { await (await import('node:fs/promises')).rm(memFileAbs, { force: true }); } catch {}
  }

  /** @type {import('./results/schema.mjs').EvalResult} */
  const result = {
    runId,
    source: opts.source,
    ablation: ablation.key,
    taskId: fixture.id,
    taskFamily,
    seed: fixture.seed ?? 42,
    seedSupport: opts.seedSupport,
    modelId: opts.model,
    panshalachVersion: PANSHALACH_VERSION,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    verdict: 'no-verification',
    verification: { signal: 'NO_VERIFICATION', exitCode: 0, commands: [] },
    memory: { injectedCardIds: [], verifiedCardIds: [] },
    prompt: {
      chars: fixture.prompt.length,
      estimatedTokens: Math.ceil(fixture.prompt.length / 4),
      hash: hashPrompt(fixture.prompt),
    },
    stopReason: 'no-verification',
    attemptCount: 1,
    failureTaxonomy: { primary: 'no-verification', secondary: 'unknown' },
    refined: { added: 0, merged: 0, written: 0, capped: 0 },
    artifacts: {},
    tags: [],
  };

  // ── mock-smoke：预设通过数据 ──
  if (opts.source === 'mock-smoke') {
    result.verdict = 'completed';
    result.stopReason = 'completed';
    result.verification = { signal: 'PASS', exitCode: 0, commands: ['npx tsc --noEmit (mock)'] };
    result.memory = {
      injectedCardIds: [`mock-card-${fixture.id}`],
      verifiedCardIds: [`mock-verified-${fixture.id}`],
    };
    result.failureTaxonomy = undefined;
    result.refined = { added: 1, merged: 0, written: 1, capped: 0 };
    result.artifacts = {
      rolloutJsonl: `mock/trajectories/${fixture.id}.jsonl`,
      stdoutTail: `mock/logs/${fixture.id}.log`,
    };
    result.durationMs = tick();
    result.finishedAt = new Date().toISOString();
    return result;
  }

  // ── real-openpangu：spawn harness 子进程 ──
  const isWin = process.platform === 'win32';
  // R6: 将 prompt 写入临时文件，通过 @path 机制传入——避免 Windows 命令行
  // 长度/特殊字符限制（spawn EINVAL）。临时文件在进程退出后由 artifact 落盘覆盖。
  const tmpDir = join(ROOT, '.panshalach-eval-tmp');
  await mkdir(tmpDir, { recursive: true });
  const promptFile = join(tmpDir, `prompt-${fixture.id}-${ablation.key}.txt`);
  await writeFile(promptFile, fixture.prompt, 'utf8');
  const cliArgs = [
    'tsx', 'src/cli.ts',
    '--headless',
    '--approval', 'full',
    'run', `@${promptFile}`,  // @path 机制：eval harness 展开临时文件内容
  ];

  console.log(`  [eval] spawn: npx ${cliArgs.slice(0, -1).join(' ')} run @<prompt>`);
  console.log(`  [eval] ablation: inject=${ablation.injectMemory} overflow=${ablation.overflowWindow} semantic=${ablation.semanticSearch}`);
  console.log(`  [eval] memFile: ${memFileRel} (cwd=${relative(ROOT, cwd) || '.'})`);

  // R6 follow-up #1: pre-seed 业务记忆到 per-run 文件
  // - B/C/C4 档（有 seed 或默认合成）→ 期望注入非空
  // - A 档不写 → 期望 0 注入
  try {
    await writeSeedMemory(memFileAbs, ablation, opts, startedAt.getTime());
    memSeeded = true;
  } catch (e) {
    console.warn(`  [eval] seedMemory 写入失败: ${e.message}`);
  }

  try {
    const { stdout, stderr, exitCode, error } = await spawnWithTimeout(
      isWin ? 'npx.cmd' : 'npx', cliArgs, {
        env: evalAblationEnv(ablation, evalTaskId, memFileRel),
        cwd,
        timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      }
    );

    result.durationMs = tick();
    result.finishedAt = new Date().toISOString();

    if (error) {
      console.warn(`  [eval] 子进程错误: ${error.message}`);
      result.failureTaxonomy = parseFailure(stdout, stderr, exitCode ?? 1, error.message);
      result.verdict = 'aborted';
      result.stopReason = 'aborted';
      result.lastError = error.message;
      result.verification = { signal: 'UNKNOWN', exitCode: exitCode ?? null, commands: [] };
    } else {
      const verification = parseVerification(stdout, stderr, exitCode ?? 1);
      const memory = parseMemory(stdout);

      result.verification = verification;
      result.memory = {
        injectedCardIds: memory.injectedCardIds,
        verifiedCardIds: memory.verifiedCardIds,
      };
      if (memory.refined) result.refined = memory.refined;

      // 判定 verdict（按 RESULT_SCHEMA 语义：completed / max-steps / aborted / no-verification）
      // R6 runner 方言：line-defense-failed / overflow-skipped 直接落 verdict 到 EVAL_VERDICTS
      // (invalid / not_applicable),不再仅靠 tags——下游消费方按 verdict 直接分类
      // 防线失败只对 memory-on 档（B/C/C4）有意义：被要求注入却 0 注入 = 防线失守；
      // A 档（baseline no-memory）0 注入是预期行为，不算失败。
      if (ablation.injectMemory === true && memory.injectedCardIds.length === 0) {
        result.tags.push('line-defense-failed');
        result.verdict = 'invalid';            // EVAL_VERDICTS：不计为有效样本
        result.stopReason = 'no-verification';
        result.failureTaxonomy = { primary: 'memory-not-cited' };
      } else if (ablation.overflowWindow && !/(overflow|truncat|窗口|截断)/i.test(stdout)) {
        result.tags.push('overflow-skipped');
        result.verdict = 'not_applicable';    // EVAL_VERDICTS：A 档未溢出
        result.stopReason = 'no-verification';
        result.failureTaxonomy = { primary: 'no-verification', secondary: 'prompt-too-short' };
      } else if (verification.signal === 'PASS' || verification.signal === 'ALL_TESTS_PASSED') {
        result.verdict = 'completed';
        result.stopReason = 'completed';
        result.failureTaxonomy = undefined;

        // U2/U3: 成功时写 nextStep = verification done 到 eval TaskStateStore
        // 失败/异常不写 nextStep（合同约定：nextStep 仅成功态写入）
        writeEvalTaskNextStep(opts, evalTaskId, 'verification done', fixture.workspace ? resolve(ROOT, fixture.workspace) : ROOT).catch(() => {});
      } else if (verification.signal === 'FAIL' || verification.signal === 'TESTS_FAILED') {
        result.verdict = 'no-verification';
        result.stopReason = 'no-verification';
        result.failureTaxonomy = parseFailure(stdout, stderr, exitCode ?? 1, '');
      } else {
        result.verdict = 'no-verification';
        result.stopReason = 'no-verification';
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
      rolloutJsonl: relative(ROOT, join(artifactDir, 'stdout.txt')),
      stdoutTail: relative(ROOT, join(artifactDir, 'stdout.txt')),
      traceJson: relative(ROOT, join(artifactDir, 'result.json')),
    };

  } catch (err) {
    result.durationMs = tick();
    result.finishedAt = new Date().toISOString();
    result.verdict = 'aborted';
    result.stopReason = 'aborted';
    result.failureTaxonomy = { primary: 'infra-error', secondary: 'unknown' };
    result.lastError = err?.message || String(err);
    console.error(`  [eval] 致命错误: ${err.message}`);
  } finally {
    // R6 follow-up #1: per-run 记忆文件清理（任何路径都执行,防半文件遗留污染下一 run）
    await cleanupRunMemory();
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
      // Windows 下 npx.cmd 通过 child_process.spawn 直接拉起会触发 EINVAL；
      // shell 仅用于解析 npm shim，参数仍来自固定 runner 数组。
      ...(process.platform === 'win32' ? { shell: true } : {}),
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

/**
 * 把单 rollout 的 verdict 直接落地为 R6 评测结论（EVAL_VERDICTS）。
 * runOne 已在源处把 line-defense-failed/overflow-skipped 落为 invalid/not_applicable;
 * 这里只把 TURN_STOP_REASONS 形态映射为 pass/fail。
 *  - verdict='completed' → pass
 *  - verdict='invalid' / 'not_applicable' → 透传
 *  - 其余 → fail
 *
 * export 给 tests/eval/run-eval-verdict.test.ts 单独验证（R6 域合同）。
 */
export function verdictToEvalVerdict(r) {
  if (r.verdict === 'invalid') return 'invalid';
  if (r.verdict === 'not_applicable') return 'not_applicable';
  if (r.verdict === 'completed') return 'pass';
  return 'fail';
}

function generateSummary(results, source) {
  const byAblation = {
    A: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
    B: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
    C: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
    C4: { total: 0, passed: 0, failed: 0, invalid: 0, notApplicable: 0 },
  };
  const byFailure = {};
  let passed = 0, failed = 0, validSamples = 0;

  for (const r of results) {
    const t = byAblation[r.ablation];
    if (!t) continue;
    t.total++;
    const ev = verdictToEvalVerdict(r);
    if (ev === 'pass') { t.passed++; passed++; validSamples++; }
    else if (ev === 'fail') { t.failed++; failed++; validSamples++; }
    else if (ev === 'invalid') { t.invalid++; }
    else if (ev === 'not_applicable') { t.notApplicable++; }

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
    byAblation,
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
  --tier <A|B|C|C4>      消融档位过滤（默认全部 A/B/C/C4；每个任务跑所选档）
  --task <T1|T2|...>     指定任务（默认全部）
  --source <source>      数据来源: real-openpangu | mock-smoke（默认 real-openpangu）
  --mock                 等同 --source mock-smoke
  --dry                  只打印计划，不执行、不写盘
  --model <model>        模型标识（默认 openPangu-7B）
  --seed                 标记支持 seed 可复现
  --seed-memory <json>   R6: B/C/C4 档预填业务记忆；未传则写默认合成 seed
                         （A 档不写 seed，依赖 PANSHA_NO_MEMORY=1 保证 0 注入）
  --help                 显示帮助`);
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

  const fixtures = await loadTaskFixtures({ taskId: opts.task });
  console.log(`[eval] 加载 ${fixtures.length} 个任务 fixture:`);
  for (const f of fixtures) {
    console.log(`  - ${f.id} [${f.tier}] ${f.title} (prompt ← ${f.promptSource})`);
  }

  if (fixtures.length === 0) {
    console.log('[eval] 无匹配任务，退出');
    process.exit(0);
  }

  // U5 重构：消融是独立维度——每个任务跑全部所选档位（不再按 fixture.tier 单档配对）
  const ABLATION_KEYS = Object.keys(ABLATIONS);  // ['A','B','C','C4']
  const ablationKeys = opts.tier ? [opts.tier] : ABLATION_KEYS;
  console.log(`[eval] 消融档位: ${ablationKeys.join(', ')} × ${fixtures.length} 任务 = ${ablationKeys.length * fixtures.length} runs`);

  if (opts.dry) {
    console.log('[eval] DRY mode — 不执行、不写盘');
    process.exit(0);
  }

  const results = [];
  let schemaErrors = 0;
  for (const fixture of fixtures) {
    for (const key of ablationKeys) {
      const cfg = ablationConfig(key);
      console.log(`\n[eval] === ${fixture.id} [${cfg.key}] ${fixture.title} ===`);
      console.log(`[eval] 配置: ${cfg.description}`);
      console.log(`[eval] Prompt (${fixture.prompt.length} chars): ${fixture.prompt.slice(0, 100)}...`);

      const result = await runOne(fixture, cfg, opts);

      // U4 字段收敛：每条结果过 schema 校验
      const v = validateResult(result);
      if (!v.ok) {
        schemaErrors++;
        console.error(`  [eval] SCHEMA VIOLATION: ${v.errors.join('; ')}`);
      }

      results.push(result);
      console.log(`[eval] 结果: verdict=${result.verdict} signal=${result.verification.signal} duration=${result.durationMs}ms`);
    }
  }

  const summary = generateSummary(results, opts.source);
  console.log(`\n[eval] === 汇总 ===`);
  console.log(`[eval] 总运行: ${summary.totalRuns} | 有效样本: ${summary.validSamples} | 通过: ${summary.passed} | 失败: ${summary.failed}`);
  if (schemaErrors > 0) {
    console.error(`[eval] SCHEMA 违规: ${schemaErrors} 条结果未通过 validateResult`);
  }

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

  // schema 有违规时不写真实结果表（mock 模式允许写，方便调试）
  if (schemaErrors > 0 && opts.source !== 'mock-smoke') {
    console.error('[eval] 因 schema 违规，跳过真实结果写盘');
    process.exit(1);
  }

  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[eval] 结果已写入: ${relative(ROOT, outPath)}`);

  const hasFailures = summary.failed > 0 || schemaErrors > 0;
  process.exit(hasFailures ? 1 : 0);
}

// 仅当作为入口直接执行时跑 main();被 import 时(测试场景)跳过。
// 守卫 import.meta.url 等于当前 argv[1] 路径(对齐 Node ESM CLI 入口检测惯例)。
const isDirectRun = (() => {
  try {
    const arg1 = process.argv[1];
    if (!arg1) return false;
    const url = new URL(import.meta.url).pathname.replace(/\\/g, '/');
    return url.endsWith(arg1.replace(/\\/g, '/')) || arg1.replace(/\\/g, '/').endsWith(url.split('/').pop() ?? '');
  } catch { return false; }
})();
if (isDirectRun) {
  main().catch(e => {
    console.error('[eval] 致命错误:', e);
    process.exit(2);
  });
}
