// scripts/eval/results-schema.ts
// R6 评测基建：结果记录类型定义（契约源自 ROADMAP-NEXT §3.1 R6 合同）
//
// 使用方式：此文件为纯类型定义，供 run-eval.mjs / smoke-eval.mjs / fill-evaluation.mjs
// 通过 JSDoc 引用。不依赖任何运行时模块，可被 Node.js 直接 import type。

// ── 失败分类（运行前冻结，primary/secondary 分开） ──

/** 主失败分类——枚举值运行前冻结，不可运行时增删 */
export type FailurePrimary =
  | 'tool_error'           // 工具执行失败（bash/write/read/glob/grep 返回非零）
  | 'verification_failed'  // 真实验证步未通过（无 ALL_TESTS_PASSED/EXIT_CODE:0）
  | 'no_verification'      // 整个轨迹无真实验证步（didRealVerification 未触发）
  | 'budget_exhausted'     // 上下文窗口/步数预算耗尽
  | 'aborted'              // 用户取消或 AbortSignal
  | 'model_refusal'        // 模型拒绝执行（安全/能力边界）
  | 'parse_error'          // 模型输出解析失败（tool call JSON 损坏等）
  | 'timeout'              // 超时
  | 'infra_error';         // 基础设施错误（端点不可达、OOM 等）

/** 次要失败分类——补充描述，可选 */
export type FailureSecondary =
  | 'tool_output_parse'     // 工具输出格式异常
  | 'tool_loop'             // 工具重复调用无进展
  | 'prompt_truncation'     // prompt 被截断
  | 'context_overflow'      // 上下文溢出
  | 'model_hallucination'   // 模型幻觉（编造文件名/命令）
  | 'model_noncompliant'    // 模型不遵循指令格式
  | 'mcp_unavailable'       // MCP 工具不可用
  | 'approval_denied'       // 审批被拒绝
  | 'unknown';

// ── 验证信号枚举 ──

export type VerificationSignal =
  | 'ALL_TESTS_PASSED'   // 测试命令全部通过
  | 'EXIT_CODE:0'        // 至少一个验证命令返回 0
  | 'didRealVerification' // 轨迹中检测到真实验证步（但无明确通过信号）
  | 'none';              // 无任何验证信号

// ── 消融档位 ──

export type AblationTier = 'A' | 'B' | 'C' | 'C4';

// ── 评测结论 ──

export type EvalVerdict =
  | 'pass'              // 任务成功且验证通过
  | 'fail'              // 任务失败（含失败分类）
  | 'not_applicable'    // A 档未溢出 / B 档零注入检测失败——不进长程结论
  | 'invalid';          // 样本无效（如 B 档零注入=防线失败，不计为有效样本）

// ── 核心结果记录 ──

export interface EvalVerification {
  /** 验证信号类型 */
  signal: VerificationSignal;
  /** 验证退出码（首个非零或全部为零） */
  exitCode: number | null;
  /** 执行的验证命令列表 */
  commands: string[];
}

export interface EvalMemory {
  /** 本任务注入的记忆卡 ID 列表 */
  injectedCardIds: string[];
  /** 本任务被 markVerified 刷新的记忆卡 ID 列表 */
  verifiedCardIds: string[];
}

export interface EvalPrompt {
  /** 最终 prompt 字符数 */
  chars: number;
  /** 估算 token 数（char/4 粗略估算，非 tiktoken） */
  estimatedTokens: number;
  /** prompt 内容的 SHA-256 前 8 位（用于 diff 比对） */
  hash: string;
}

export interface EvalFailureTaxonomy {
  primary: FailurePrimary;
  secondary?: FailureSecondary;
}

export interface EvalResult {
  /** 唯一运行 ID（UUID v4） */
  runId: string;
  /** 数据来源：real-openpangu 或 mock-smoke */
  source: 'real-openpangu' | 'mock-smoke';
  /** 消融档位 */
  tier: AblationTier;
  /** 任务 ID（T1-T5） */
  taskId: string;
  /** 模型标识（如 openPangu-7B） */
  model: string;
  /** 是否支持 seed（用于可复现性） */
  seedSupport: boolean;
  /** 运行时间戳（ISO 8601） */
  timestamp: string;
  /** 耗时（ms） */
  durationMs: number;
  /** 评测结论 */
  verdict: EvalVerdict;
  /** 验证信息 */
  verification: EvalVerification;
  /** 记忆信息 */
  memory: EvalMemory;
  /** prompt 信息 */
  prompt: EvalPrompt;
  /** 失败分类（仅 verdict=fail 时填写） */
  failureTaxonomy?: EvalFailureTaxonomy;
  /** 产物路径映射（如 trajectories/xxx.jsonl, logs/xxx.log） */
  artifacts: Record<string, string>;
}

// ── 汇总统计 ──

export interface EvalSummary {
  /** 汇总 ID */
  summaryId: string;
  /** 生成时间戳 */
  generatedAt: string;
  /** 来源 */
  source: 'real-openpangu' | 'mock-smoke';
  /** 总运行数 */
  totalRuns: number;
  /** 有效样本数（排除 invalid/not_applicable） */
  validSamples: number;
  /** 通过数 */
  passed: number;
  /** 失败数 */
  failed: number;
  /** 按 tier 分组统计 */
  byTier: Record<AblationTier, {
    total: number;
    passed: number;
    failed: number;
    invalid: number;
    notApplicable: number;
  }>;
  /** 按 failurePrimary 分组统计 */
  byFailure: Record<string, number>;
  /** 配对差（A vs C 等，Wilson 区间） */
  pairwiseDiff?: {
    pairs: Array<{
      baseline: AblationTier;
      treatment: AblationTier;
      baselinePassRate: number;
      treatmentPassRate: number;
      delta: number;
      wilsonLower: number;
      wilsonUpper: number;
    }>;
  };
  /** 各 run 结果引用 */
  runIds: string[];
}

// ── 任务 Fixture 定义 ──

export interface TaskFixture {
  /** 任务 ID */
  id: string;
  /** 消融档位 */
  tier: AblationTier;
  /** 任务标题 */
  title: string;
  /** 任务描述（面向评测者） */
  description: string;
  /** 发送给 agent 的 prompt */
  prompt: string;
  /** 期望行为（自由文本，用于人工/LLM 评判） */
  expected: string;
  /** 工作目录（相对于项目根） */
  workspace?: string;
  /** 是否必须真溢出（A 档） */
  requireOverflow?: boolean;
  /** 是否禁止注入（B 档） */
  forbidInjection?: boolean;
  /** 注入的记忆卡 ID 列表（C/C4 档） */
  injectCardIds?: string[];
}