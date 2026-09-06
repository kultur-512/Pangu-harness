// scripts/eval/results/schema.mjs
// R6 评测基建：结果记录类型定义（契约源自 ROADMAP-NEXT §3.1 R6 合同）
//
// 此文件为 .mjs 格式，同时被 .mjs 脚本（run-eval/smoke-eval/fill-evaluation）
// 和 .ts 源码（via JSDoc import type）消费。不依赖任何运行时模块。

// ── 失败分类（运行前冻结，双层：primary/secondary 分开） ──

/** 主失败分类——枚举值运行前冻结，不可运行时增删 */
export const FAILURE_PRIMARY = Object.freeze([
  'tool-error',            // 工具执行失败（bash/write/read/glob/grep 返回非零）
  'verification-failed',   // 真实验证步未通过（无 ALL_TESTS_PASSED/EXIT_CODE:0）
  'no-verification',       // 整个轨迹无真实验证步（didRealVerification 未触发）
  'budget-exhausted',      // 上下文窗口/步数预算耗尽
  'aborted',               // 用户取消或 AbortSignal
  'model-refusal',         // 模型拒绝执行（安全/能力边界）
  'parse-error',           // 模型输出解析失败（tool call JSON 损坏等）
  'timeout',               // 超时
  'infra-error',           // 基础设施错误（端点不可达、OOM 等）
  'memory-not-cited',      // 注入但卡未在 verify 步被引用（R7/R8 统计"卡注入利用率"）
  'semantic-miss',         // C4 档语义检索未命中（区分检索质量失败 vs 注入失败）
]);

/** 次要失败分类——补充描述，可选 */
export const FAILURE_SECONDARY = Object.freeze([
  'tool-output-parse',     // 工具输出格式异常
  'tool-loop',             // 工具重复调用无进展
  'prompt-truncation',     // prompt 被截断
  'context-overflow',      // 上下文溢出
  'model-hallucination',   // 模型幻觉（编造文件名/命令）
  'model-noncompliant',    // 模型不遵循指令格式
  'mcp-unavailable',       // MCP 工具不可用
  'approval-denied',       // 审批被拒绝
  'prompt-too-short',      // A 档 prompt chars 未达溢出阈值（标 not-applicable）
  'unknown',
]);

// ── 验证信号枚举 ──

export const VERIFICATION_SIGNALS = Object.freeze([
  'ALL_TESTS_PASSED',     // 测试命令全部通过
  'EXIT_CODE:0',          // 至少一个验证命令返回 0
  'didRealVerification',  // 轨迹中检测到真实验证步（但无明确通过信号）
  'none',                 // 无任何验证信号
]);

// ── 消融档位 ──

export const ABLATION_TIERS = Object.freeze(['A', 'B', 'C', 'C4']);

// ── 评测结论 ──

export const EVAL_VERDICTS = Object.freeze([
  'pass',              // 任务成功且验证通过
  'fail',              // 任务失败（含失败分类）
  'not_applicable',    // A 档未溢出 / B 档 prompt 不足——不进长程结论
  'invalid',           // 样本无效（如 B 档零注入=防线失败，不计为有效样本）
]);

// ── R6 结果记录结构说明（JSDoc，供 .ts 和 .mjs 共同引用） ──

/**
 * @typedef {Object} EvalVerification
 * @property {string} signal - 验证信号（ALL_TESTS_PASSED | EXIT_CODE:0 | didRealVerification | none）
 * @property {number|null} exitCode - 验证退出码
 * @property {string[]} commands - 执行的验证命令列表
 */

/**
 * @typedef {Object} EvalMemory
 * @property {string[]} injectedCardIds - 注入的记忆卡 ID
 * @property {string[]} verifiedCardIds - 被 markVerified 的记忆卡 ID
 */

/**
 * @typedef {Object} EvalPrompt
 * @property {number} chars - prompt 字符数
 * @property {number} estimatedTokens - 估算 token 数
 * @property {string} hash - prompt SHA-256 前 8 位
 */

/**
 * @typedef {Object} EvalFailureTaxonomy
 * @property {string} primary - 主失败分类（FAILURE_PRIMARY 枚举）
 * @property {string} [secondary] - 次要失败分类（FAILURE_SECONDARY 枚举）
 */

/**
 * @typedef {Object} EvalResult
 * @property {string} runId - 唯一运行 ID
 * @property {'real-openpangu'|'mock-smoke'} source - 数据来源
 * @property {'A'|'B'|'C'|'C4'} tier - 消融档位
 * @property {string} taskId - 任务 ID
 * @property {string} model - 模型标识
 * @property {boolean} seedSupport - 是否支持 seed
 * @property {string} timestamp - ISO 8601 时间戳
 * @property {number} durationMs - 耗时
 * @property {'pass'|'fail'|'not_applicable'|'invalid'} verdict - 评测结论
 * @property {EvalVerification} verification - 验证信息
 * @property {EvalMemory} memory - 记忆信息
 * @property {EvalPrompt} prompt - prompt 信息
 * @property {EvalFailureTaxonomy} [failureTaxonomy] - 失败分类（仅 verdict=fail 时）
 * @property {Record<string,string>} artifacts - 产物路径映射
 */

/**
 * @typedef {Object} EvalSummary
 * @property {string} summaryId
 * @property {string} generatedAt
 * @property {'real-openpangu'|'mock-smoke'} source
 * @property {number} totalRuns
 * @property {number} validSamples
 * @property {number} passed
 * @property {number} failed
 * @property {Object} byTier
 * @property {Object} byFailure
 * @property {string[]} runIds
 */

/**
 * @typedef {Object} TaskFixture
 * @property {string} id - 任务 ID
 * @property {'A'|'B'|'C'|'C4'} tier - 消融档位
 * @property {string} title - 任务标题
 * @property {string} description - 任务描述
 * @property {string} prompt - 发送给 agent 的 prompt
 * @property {string} expected - 期望行为
 * @property {string} [workspace] - 工作目录
 * @property {boolean} [requireOverflow] - A 档必须溢出
 * @property {boolean} [forbidInjection] - B 档禁止注入
 * @property {string[]} [injectCardIds] - 注入的记忆卡 ID
 */

// ── 辅助函数 ──

/**
 * 校验 single-string 旧格式 → 升级为 { primary, secondary? } 双层格式。
 * 向后兼容：如果已经是双层格式则原样返回。
 * @param {string|{primary:string,secondary?:string}|undefined} taxonomy
 * @returns {{primary:string,secondary?:string}|undefined}
 */
export function normalizeFailureTaxonomy(taxonomy) {
  if (!taxonomy) return undefined;
  if (typeof taxonomy === 'string') {
    return { primary: taxonomy };
  }
  return taxonomy;
}

/**
 * 校验结果是否符合 R6 合同必含字段。
 * @param {EvalResult} result
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateResult(result) {
  const required = ['runId', 'source', 'seedSupport', 'verdict'];
  const nested = {
    verification: ['signal', 'exitCode', 'commands'],
    memory: ['injectedCardIds', 'verifiedCardIds'],
    prompt: ['chars', 'estimatedTokens', 'hash'],
  };

  const missing = [];

  for (const key of required) {
    if (result[key] === undefined || result[key] === null) {
      missing.push(key);
    }
  }

  for (const [group, keys] of Object.entries(nested)) {
    if (!result[group]) { missing.push(group); continue; }
    for (const key of keys) {
      if (result[group][key] === undefined || result[group][key] === null) {
        missing.push(`${group}.${key}`);
      }
    }
  }

  if (!result.artifacts || Object.keys(result.artifacts).length === 0) {
    missing.push('artifacts');
  }

  return { valid: missing.length === 0, missing };
}