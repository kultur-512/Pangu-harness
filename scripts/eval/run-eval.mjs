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
const PANSHALACH_VERSION = '0.8.0-rc';

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
        // CRLF→LF 归一（T4/T5 fixture.md 是 CRLF：\r 残留在行尾会让空行
        // 判定与段标题精确匹配全部失效，2026-09-16 真机 T4/T5 prompt 只解析出
        // 78 字符说明文字）
        fixture = parseIssueMarkdown(issueContent.replace(/\r\n/g, '\n'), entry.name);
        promptSource = 'issue.md';
      } else {
        const content = await readFile(fixturePath, 'utf8');
        fixture = parseFixtureMarkdown(content.replace(/\r\n/g, '\n'), entry.name);
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

      // T3 长文档溢出校准（R6 前置，2026-09-16）：document.md 全文拼入 prompt。
      // 真机 1B 实测不会主动 read_file 长文档（smoke 0 次工具调用）→ A 档
      // 溢出场景永不成立（ROADMAP A1 前置："T3 fixture 按窗口校准溢出规模，
      // 否则 A 档整档无效"）。文档 ~26K tokens > A 档窗口线 8000 → A 档必然
      // 触发溢出防护（[ctx] contextOverflowCompacted=1 或网关报错模式）；
      // B/C/C4 档在同等压力下由记忆预算/压缩管理上下文，档间对照保留。
      if (fixture.id === 'T3') {
        try {
          const doc = await readFile(join(taskDir, 'document.md'), 'utf8');
          fixture.prompt = `${fixture.prompt}\n\n## document.md 全文（本任务的工作输入）\n\n${doc}`;
        } catch { /* document.md 缺失时保持原 prompt（校准失败安全） */ }
      }

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
    // 2026-09-16 修：段标题精确匹配——T4/T5 fixture.md 的 "## Prompt 加载
    // （runner 契约）" 说明节以 "## Prompt " 开头，旧 startsWith 匹配把它误当
    // 成 Prompt 段起点，prompt 只收集到 78 字符的说明文字（真机 T4/T5 全档
    // 拿到无效任务）。精确 `=== '## Prompt'` 后，说明节正常被当普通段跳过。
    const isPromptHeading = line.trim() === '## Prompt';
    if (line.startsWith('## ') && !isPromptHeading) {
      if (inPrompt) break;
    }
    if (isPromptHeading) { inPrompt = true; continue; }
    if (line.startsWith('## 期望')) break;
    if (inPrompt) {
      const trimmed = line.replace(/^>\s?/, '');
      // 2026-09-16 修：空行不入 prompt（CRLF 行尾 + 段内空行曾把 prompt 填成
      // '\n'，导致开块 ``` 行就 break——配合上面精确段标题修复一起生效）；
      // 开块 ``` 跳过（prompt 为空时），闭块 ``` 在已有内容时结束。
      if (!trimmed) continue;
      if (trimmed.startsWith('```')) {
        if (prompt) break;
        continue;
      }
      prompt += (prompt ? '\n' : '') + trimmed;
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
/**
 * 默认合成 seed（0.8.2 重写）：按任务族注入**业务相关**的方法论记忆。
 * 旧版占位卡（"请传 --seed-memory 覆盖"）对任务零价值——真机 A/B 曲线实证
 * B 档无增益反拖累（T1: A 40% vs B 20%）。记忆的价值在内容与任务的相关性，
 * 不在注入动作本身——本函数让 B 档真正测"有相关经验 vs 无记忆"。
 * 正式跑分仍推荐 --seed-memory <path> 预填真实业务记忆。
 */
function defaultSeedMemory(now, taskFamily = 'T1') {
  const PLAYBOOK = {
    T1: [
      { id: 'seed-t1-checklist', kind: 'success', mc: 'implementation',
        summary: '【经验】多约束文件生成任务：先逐条列出约束清单，写完后用 read_file 复读全文逐条自检（文件名大小写/数量/空行/禁用字符），一条不满足就重写' },
      { id: 'seed-t1-format', kind: 'success', mc: 'implementation',
        summary: '【经验】markdown checkbox 规范：格式必须是 "- [ ] "（短横+空格+方括号+空格），每个 checkbox 行后跟一个空行，全文禁止 tab 与 emoji' },
    ],
    T2: [
      { id: 'seed-t2-refactor', kind: 'success', mc: 'implementation',
        summary: '【经验】跨文件签名重构：先 grep 全部调用点并列清单，逐个调用点改写后再改函数签名，最后 tsc + 测试双验证；禁止改不相关文件' },
      { id: 'seed-t2-bigint', kind: 'success', mc: 'implementation',
        summary: '【经验】number|bigint 联合类型函数：调用点传 BigInt() 结果时返回值也要 .toString()/bigint 传播，测试用例必须覆盖 2 个以上 bigint 场景' },
    ],
    T3: [
      { id: 'seed-t3-longdoc', kind: 'success', mc: 'implementation',
        summary: '【经验】长文档摘要任务：先 read_file 分段读完全文再动笔，摘要必须覆盖全部小节结构，保留关键数字与结论' },
    ],
  };
  const cards = (PLAYBOOK[taskFamily] || PLAYBOOK.T1).map((c) => ({
    id: c.id,
    kind: c.kind,
    category: 'OTHER',
    memoryCategory: c.mc,
    summary: c.summary,
    weight: 1.0,
    taskStyle: 'all',
    count: 1,
    lastSeen: now,
    firstSeen: now,
    applicableTiers: [],
    decayWeight: 1.0,
    lastUsedAt: now,
  }));
  return { meta: { version: '1.1.0', lastUpdated: now, totalCards: cards.length }, cards };
}

// export 给 tests 单独验证 defaultSeedMemory 结构合法
export { defaultSeedMemory };

async function writeSeedMemory(memFileAbs, ablation, opts, now, memTaskFamily) {
  let seed;
  if (opts.seedMemory) {
    seed = JSON.parse(await readFile(opts.seedMemory, 'utf8'));
  } else if (ablation.injectMemory && !ablation.overflowWindow) {
    // B/C/C4 档:无 --seed-memory 时写默认合成 seed（按任务族定制业务方法论）
    seed = defaultSeedMemory(now, memTaskFamily ?? 'T1');
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
    const injectedMatch = stdout.match(/injectedCardIds\s*[:=]\s*\[([^\]]*)\]/i);
    if (injectedMatch) {
      const ids = injectedMatch[1].match(/[a-zA-Z0-9_-]+/g);
      if (ids) injected.push(...ids);
    }
  }
  if (verified.length === 0) {
    const verifiedMatch = stdout.match(/verifiedCardIds\s*[:=]\s*\[([^\]]*)\]/i);
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

  // 0.8.2 评审必改：per-run 隔离工作区——agent 产物（TODO.md/repo 改动等）写入
  // 临时副本，不落活仓库；跨 run 残留（根目录遗留 TODO.md → 下次 run 零动作
  // 也 completed 的构造性假阳性）随 finally 清目录根除。任务语料（T2 repo、
  // T3 document.md 等）从 tasks/<Tn>/ 整目录拷入，保证 prompt 相对路径成立。
  const wsDir = join(ROOT, '.panshalach-eval-tmp', `ws-${taskFamily}-${runId.slice(0, 8)}`);
  const { cpSync, existsSync } = await import('node:fs');
  const taskAssetDir = join(TASKS_DIR, taskFamily);
  try {
    cpSync(taskAssetDir, wsDir, { recursive: true });
    console.log(`  [eval] 隔离工作区: ${relative(ROOT, wsDir)}（语料拷自 ${relative(ROOT, taskAssetDir)}）`);
  } catch (e) {
    console.warn(`  [eval] 任务语料拷贝失败（${e.message}）——回退 ROOT cwd`);
  }
  const cwd = existsSync(wsDir) ? wsDir : (fixture.workspace ? resolve(ROOT, fixture.workspace) : ROOT);
  // 0.8.2：fixture repo 带 devDependencies（tsx/typescript）但 node_modules 不入库
  // ——副本里不装依赖，T2 verify.sh 的 tsc/npm test 检查结构性必挂（exit 2 假阴性）。
  let repoDepsReady = false;
  if (existsSync(join(wsDir, 'repo', 'package.json'))) {
    try {
      const isWinNpm = process.platform === 'win32';
      const dr = await spawnWithTimeout(isWinNpm ? 'npm.cmd' : 'npm',
        ['install', '--no-audit', '--no-fund', '--loglevel=error'],
        { cwd: join(wsDir, 'repo'), timeoutMs: 180_000 });
      repoDepsReady = dr.exitCode === 0;
      console.log(`  [eval] repo deps install exit=${dr.exitCode}`);
    } catch (e) {
      console.warn(`  [eval] repo deps install 失败: ${e.message}`);
    }
  }
  const memFileAbs = join(cwd, memFileRel);
  let memSeeded = false;
  let memCleaned = false;
  async function cleanupRunMemory() {
    if (memCleaned) return;
    memCleaned = true;
    try { await (await import('node:fs/promises')).rm(memFileAbs, { force: true }); } catch {}
    try { await (await import('node:fs/promises')).rm(wsDir, { recursive: true, force: true }); } catch {}
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
  // cwd = 隔离工作区 → 入口必须绝对路径（相对 src/cli.ts 在临时目录下不存在）
  const cliArgs = [
    'tsx', join(ROOT, 'src', 'cli.ts'),
    '--headless',
    '--approval', 'full',
    'run', `@${promptFile}`,  // @path 机制：eval harness 展开临时文件内容
  ];

  console.log(`  [eval] spawn: npx ${cliArgs.join(' ')} (@<prompt> = 临时文件内容)`);
  console.log(`  [eval] ablation: inject=${ablation.injectMemory} overflow=${ablation.overflowWindow} semantic=${ablation.semanticSearch}`);
  console.log(`  [eval] memFile: ${memFileRel} (cwd=${relative(ROOT, cwd) || '.'})`);

  // R6 follow-up #1: pre-seed 业务记忆到 per-run 文件
  // - B/C/C4 档（有 seed 或默认合成）→ 期望注入非空
  // - A 档不写 → 期望 0 注入
  try {
    await writeSeedMemory(memFileAbs, ablation, opts, startedAt.getTime(), taskFamily);
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

    let externalVerify = null;
    let externalVerifyCmd;
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

      // 解析引擎真实 stopReason——锚定 one-shot 汇总行（`完成 (Nms) · <四态>`），
      // 不做全文子串匹配（agent 答案正文里说"已通过验证"会误翻）。此值为
      // engineStopReason：verdict 分支无更权威值时保留它（此前各分支无条件重写
      // stopReason → answered 永不可达的死存储，评审必改项）。
      const summaryMatch = stdout.match(/完成 \(\d+ms\)\s*·\s*(已通过验证|已回复|任务执行失败|未通过验证)/);
      const engineStopReason = summaryMatch
        ? ({ '已通过验证': 'completed', '已回复': 'answered', '任务执行失败': 'error', '未通过验证': 'no-verification' })[summaryMatch[1]]
        : undefined;
      if (engineStopReason) result.stopReason = engineStopReason;

      // R6 合同外部验证（0.8.2 纰漏修复）：runner 亲自执行任务族 verify.sh——
      // 此前 verdict 只看 agent 自验信号，agent 做对工作但未自验时证据链断裂
      // （真机 MiniMax T1 实证：TODO.md 5/5 约束全对，verdict 却 no-verification）。
      if (!error) {
        const verifyScript = join(TASKS_DIR, fixture.id, 'verify.sh');
        try {
          const vr = await spawnWithTimeout('bash', [verifyScript], {
            env: evalAblationEnv(ablation, evalTaskId, memFileRel),
            cwd,
            timeoutMs: 120_000,
          });
          externalVerify = { exitCode: vr.exitCode, tail: String(vr.stdout || '').slice(-1200) };
        } catch (e2) {
          externalVerify = { exitCode: null, error: e2?.message || String(e2) };
        }
        console.log(`  [eval] external verify.sh exit=${externalVerify.exitCode}`);
        externalVerifyCmd = `bash tasks/${fixture.id}/verify.sh (exit=${externalVerify.exitCode})`;
      }

      result.verification = verification;
      // 外部验证证据在 verification 对象赋值后合并（此前追加被整体替换丢弃——评审必改项）
      if (externalVerifyCmd) {
        result.verification.commands = [...(result.verification.commands || []), externalVerifyCmd];
      }
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
      // 溢出要求限定长上下文任务族（T3 长文档 / T5 压缩保持）——T1/T2 是小 prompt
      // 任务，A 档永远不可能溢出；按子串匹配判溢出会被 agent 答案正文里的
      // "窗口/截断"字样误翻（真机 T1×A 实证假阳性 completed）。0.8.2 起溢出
      // 检查只对 T3/T5 生效，T1/T2 的 A 档 = 有效基线样本（A/B 曲线可统计）。
      const overflowRequired = taskFamily === 'T3' || taskFamily === 'T5';
      // verdict 优先级（评审裁决）：防线失败 > 溢出豁免 > 外部验证（authoritative，
      // 非 0 一票否决 agent 自称 PASS——Verify-Before-Claim 的机器执法）> 自验信号。
      if (ablation.injectMemory === true && memory.injectedCardIds.length === 0) {
        result.tags.push('line-defense-failed');
        result.verdict = 'invalid';            // EVAL_VERDICTS：不计为有效样本
        result.stopReason = 'no-verification';
        result.failureTaxonomy = { primary: 'memory-not-cited' };
      } else if (overflowRequired && ablation.overflowWindow
                 // 溢出证据唯一正源（2026-09-16 收紧）：
                 // ① [ctx] contextOverflowCompacted=1 —— loop 触发过溢出重试的
                 //    机器可读标记（权威，RunCommand 证据行）。
                 // ② 网关报错正文模式 —— 已删除。实证：1B 端点（LM Studio）对
                 //    超窗请求返回 200 静默截断（无 context length 报错），且
                 //    长文档 prompt 原文本身包含"被截断/窗口"等任意检索词——
                 //    任何基于 stdout 子串匹配的溢出判定都必然假阳性
                 //    （09-14 数据即被裸"窗口|截断"词污染）。
                 && !/\[ctx\] contextOverflowCompacted=1/i.test(stdout + '\n' + stderr)) {
        result.tags.push('overflow-skipped');
        result.verdict = 'not_applicable';    // EVAL_VERDICTS：A 档未溢出
        result.stopReason = 'no-verification';
        result.failureTaxonomy = { primary: 'no-verification', secondary: 'prompt-too-short' };
      } else if (externalVerify && externalVerify.exitCode !== null && externalVerify.exitCode !== 0) {
        // 外部验证失败（exit≥1）：工作产物不满足约束。即使 agent 自称
        // ALL_TESTS_PASSED 也一票否决（真机 T2×B 实证：重构 1/5 自称通过）。
        // stopReason 保留引擎终态，verdict/signal 反映外部验证失败。
        result.verdict = 'no-verification';
        result.verification.signal = 'FAIL';
        result.verification.exitCode = externalVerify.exitCode;
        result.failureTaxonomy = { primary: 'verification-failed', secondary: 'external-verify-nonzero' };
      } else if (externalVerify && externalVerify.exitCode === 0) {
        // 外部验证退出码 0 = R6 验收四问之④（有外部验证退出码吗）的正源
        result.verdict = 'completed';
        result.stopReason = 'completed';
        result.verification.signal = 'PASS';
        result.verification.exitCode = externalVerify.exitCode;
        result.failureTaxonomy = undefined;
        writeEvalTaskNextStep(opts, evalTaskId, 'verification done', fixture.workspace ? resolve(ROOT, fixture.workspace) : ROOT).catch(() => {});
      } else if (verification.signal === 'PASS' || verification.signal === 'ALL_TESTS_PASSED') {
        // 无外部验证脚本可依时的自验回退（T4/T5 之外的路径不触发——runner 现对
        // 全部 T1-T5 执行 verify.sh，本分支仅防御性保留）
        result.verdict = 'completed';
        result.stopReason = 'completed';
        result.failureTaxonomy = undefined;
        writeEvalTaskNextStep(opts, evalTaskId, 'verification done', fixture.workspace ? resolve(ROOT, fixture.workspace) : ROOT).catch(() => {});
      } else if (verification.signal === 'FAIL' || verification.signal === 'TESTS_FAILED') {
        result.verdict = 'no-verification';
        if (!engineStopReason) result.stopReason = 'no-verification';
        result.failureTaxonomy = parseFailure(stdout, stderr, exitCode ?? 1, '');
      } else {
        // 无自验、无外部验证信号：verdict=no-verification；stopReason 保留引擎终态
        // （answered = 有正文但未动手的假完成，verdict 不计成功——口径一致）
        result.verdict = 'no-verification';
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
    if (externalVerify) {
      let wsListing = '';
      try {
        const { readdirSync } = await import('node:fs');
        wsListing = readdirSync(cwd).join(String.fromCharCode(10));
      } catch { wsListing = '(cwd 已清理或不可读)'; }
      await writeFile(join(artifactDir, 'external-verify.txt'),
        `exit=${externalVerify.exitCode}
[cwd listing]
${wsListing}

${externalVerify.tail || ''}`, 'utf8');
    }

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
  // Windows: Node >= 20.12 (CVE-2024-27980) 直接 spawn .cmd/.bat 抛 EINVAL——
  // 必须 shell:true 且把参数拼成带引号的命令串（路径含空格安全）。
  // Windows: Node >= 20.12 (CVE-2024-27980) 直接 spawn .cmd/.bat 抛 EINVAL——
  // 必须 shell:true 且把参数拼成带引号的命令串。cmd.exe 的引号转义是 `""` 加倍
  // （不是 \"——那是 POSIX 惯例，对 cmd 是 no-op，评审指出原实现为恒等替换）。
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const spawnArgs = needsShell
    ? args.map((a) => (/["\s]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
    : args;
  return new Promise((resolve) => {
    const child = spawn(command, spawnArgs, {
      env: opts.env || process.env,
      cwd: opts.cwd || ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: needsShell,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        // Windows shell:true 下 kill 只杀 cmd.exe 包装进程——npx→node 孙进程存活
        // 会与下一 run 的外部验证并发写工作区。taskkill /T 杀整棵进程树。
        if (process.platform === 'win32' && child.pid) {
          try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
        } else {
          child.kill('SIGTERM');
          setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
        }
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

  // 增量合并（2026-09-16）：读当日已有结果文件，与本次 results 按
  // taskId+ablation 合并（新覆盖旧）——支持按 --task/--tier 分批跑、
  // 中途被杀不丢已完成数据（此前写盘只在末尾发生，长跑被中断 = 全丢）。
  let existing = [];
  try {
    const prev = JSON.parse(await readFile(outPath, 'utf8'));
    if (Array.isArray(prev?.results)) existing = prev.results;
    console.log(`[eval] 合并已有 ${existing.length} 条当日结果（taskId+ablation 去重，新覆盖旧）`);
  } catch { /* 无当日文件 → 全量新写 */ }

  const merged = new Map();
  for (const r of [...existing, ...results]) merged.set(`${r.taskId}:${r.ablation}`, r);
  const mergedResults = [...merged.values()];
  const mergedSummary = generateSummary(mergedResults, opts.source);

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      source: opts.source,
      model: opts.model,
      runnerVersion: '0.2.0',
    },
    summary: mergedSummary,
    results: mergedResults,
  };

  // schema 有违规时不写真实结果表（mock 模式允许写，方便调试）
  if (schemaErrors > 0 && opts.source !== 'mock-smoke') {
    console.error('[eval] 因 schema 违规，跳过真实结果写盘');
    process.exit(1);
  }

  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[eval] 结果已写入: ${relative(ROOT, outPath)}`);

  const hasFailures = mergedSummary.failed > 0 || schemaErrors > 0;
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
