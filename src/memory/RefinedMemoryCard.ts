// Panshalach 失败记忆：提炼后持久化数据模型
// 核心思路：原始完整轨迹仅存在当前会话内存，持久化的只保留"教训卡片"
// 教训卡片结构轻量、可过滤、可衰减

import { FailureCategory } from './FailureMemory.js';

/**
 * 新的记忆类别，用于分层加载与阶梯衰减
 */
export type MemoryCategory = 'architecture' | 'failure' | 'implementation' | 'insight' | 'general';

/**
 * 提炼后的记忆卡片（RefinedMemoryCard）
 * 设计原则：轻量、可搜索、可按 tier 过滤
 * 语言要求：建设性表述（避免"致命失败""100%避免"等措辞）
 */
export interface RefinedMemoryCard {
  /** 卡片唯一 ID（hash 摘要） */
  id: string;
  /**
   * 卡片种类 — failure（失败教训）/ success（正向经验）/ preference（用户偏好）。
   * 旧卡加载默认 'failure'（向后兼容）。kind 决定注入来源标签与衰减基线。
   */
  kind?: 'failure' | 'success' | 'preference';
  /** 失败类别（保留原有 taxonomy，便于追溯具体失败模式；success/preference 用 'OTHER'） */
  category: FailureCategory;
  /**
   * 记忆类别（用于 tier 可见性 + 阶梯衰减）
   * 老文件无此字段时，加载时默认 'general'
   */
  memoryCategory?: MemoryCategory;
  /** 教训摘要（一句话，使用"重要教训"或"建议重点避免"口吻） */
  summary: string;
  /** 权重 1-5（5 = 最高）—— 作为基础权重，实际加载时会乘以衰减因子 */
  weight: number;
  /** 任务风格相关性 */
  taskStyle: 'swe' | 'terminal' | 'automation' | 'all';
  /** 触发次数 */
  count: number;
  /** 最后出现时间（timestamp ms）—— 衰减与刷新以此为准 */
  lastSeen: number;
  /** 首次记录时间（timestamp ms） */
  firstSeen: number;
  /** 适用于哪些档位（空数组 = 所有档位都适用）—— 仍保留原有机制 */
  applicableTiers: string[];
  /** 来源描述（不包含完整代码或敏感信息） */
  sourceContext: string;

  // ===== 分层加载与阶梯衰减字段 =====
  /** 衰减后的当前权重系数（0-1），用于 loadFiltered 时计算 effectiveWeight */
  decayWeight?: number;
  /** 最后被使用（加载/命中）的时间戳，用于刷新衰减 */
  lastUsedAt?: number;

  // ===== 正向记忆与偏好字段 =====
  /** pin 卡冻结衰减（decayWeight 恒 1.0）—— /remember --pin */
  pinned?: boolean;

  // ===== 卡片关键字 =====
  /**
   * 关键字（success 卡从任务文本与写入文件名提取，≤4 个 token；小写）。
   * 加性字段：旧文件无此字段照常加载；检索/相关性排序的未来消费方预留
   * （当前 loadFiltered 的 keywords 相关性仍匹配 summary）。
   */
  keywords?: string[];

  // ===== 确定性合并归档字段 =====
  /** active（默认）/ archived（合并后原卡软删除，不物理删） */
  status?: 'active' | 'archived';
  /** 合并卡记录来源卡 id（可回滚）；本期只写不读 */
  mergedFrom?: string[];
}

/**
 * 持久化文件结构
 */
export interface RefinedMemoryFile {
  meta: {
    version: string;
    lastUpdated: number;
    totalCards: number;
  };
  cards: RefinedMemoryCard[];
}

/**
 * 默认容量与衰减参数
 */
export const MEMORY_LIMITS = {
  /** 单类别最大卡片数（历史常量；容量治理已改按 kind 分桶，见 MAX_PER_KIND） */
  MAX_PER_CATEGORY: 10,
  /**
   * 按 kind 分桶的容量帽（包C 缺陷1 修复，2026-09-13）：
   * 旧 applyCapacityLimits 按 category 分桶各留 MAX_PER_CATEGORY=10，而
   * success / preference(/remember) / merged / chat-fact 卡全部 category:'OTHER'
   * → 三类卡挤一个 10 张桶，第 11 张起静默截断最旧；chat-fact 声称的 80 张帽
   * （chatFactMemory MAX_TOTAL_CARDS=80）与全局 200 帽不可达。
   * 按 kind 实际取值集合（RefinedMemoryCard.kind: 'failure' | 'success' |
   * 'preference'）映射；chat-fact 卡（chatFactMemory）kind 即 'preference'，
   * 其 80 帽以该桶承载。无 kind 的旧卡在容量归一为 'failure'（对齐 loadFiltered）。
   */
  MAX_PER_KIND: { failure: 40, success: 10, preference: 80 } as Record<string, number>,
  /** failure kind 内每 category 细分帽（category 多样时防单 category 刷爆类帽） */
  MAX_PER_KIND_PER_CATEGORY: 10,
  /** 全局硬上限（卡片数） */
  MAX_TOTAL_CARDS: 200,
  /** 衰减半衰期（天）—— 30 天未被触发的卡片权重衰减为 50% */
  DECAY_HALF_LIFE_DAYS: 30,
  /** 最小权重（衰减后低于此值会被清理） */
  MIN_WEIGHT: 0.5,
  /** 文件大小软上限（字节） */
  MAX_FILE_SIZE_BYTES: 200 * 1024,
  /** 默认持久化文件名 */
  DEFAULT_FILENAME: '.panshalach-memory.json',
  /** 默认 .gitignore 追加行 */
  GITIGNORE_LINE: '.panshalach-memory.json',
};

/**
 * 教训摘要模板（建设性、工程化口吻）
 */
export const LESSON_TEMPLATES: Record<FailureCategory, string> = {
  'HALLUCINATED_FILE': '重要教训：修改前应确认文件确实存在，避免基于幻觉的文件路径操作。',
  'HALLUCINATED_FUNCTION': '重要教训：调用函数前应确认其真实存在并已读取其定义。',
  'HALLUCINATED_BEHAVIOR': '重要教训：依赖外部行为前应先验证当前实际状态。',
  'TOOL_FORMAT_ERROR': '建议重点避免：工具调用格式不正确会浪费重试时间，请使用标准结构。',
  'LOOSE_FORMAT_USED': '建议重点避免：使用松散格式会降低可解析性，标准格式更可靠。',
  'READ_BEFORE_WRITE_VIOLATION': '重要教训：写入前应先完整读取目标文件，避免破坏性修改。',
  'WEAK_VERIFICATION': '重要教训：依赖未充分验证的结果会导致后续步骤基于错误状态。',
  'NO_VERIFICATION_BEFORE_CLAIM': '重要教训：没有明确验证信号就声称完成是高风险行为。',
  'OVERCONFIDENCE': '建议重点避免：过度自信会导致跳步和忽视风险。',
  'SKIPPED_PLAN': '建议重点避免：跳过规划会增加返工和偏离目标的风险。',
  'SKIPPED_READ': '重要教训：跳过读取步骤会丢失关键上下文。',
  'CONTEXT_LOSS': '建议重点避免：上下文丢失会导致决策失误。',
  'BAD_CRITIQUE': '建议重点避免：无效的自我批评会浪费 token 且无收益。',
  'COMMAND_FAILED': '建议重点避免：命令失败后应明确分析原因再继续。',
  'STATE_MISMATCH': '重要教训：预期状态与实际不符是高风险信号，需先排查。',
  'WORKFLOW_STEP_ERROR': '建议重点避免：工作流步骤错误会级联放大。',
  'DATA_TRANSFORM_ERROR': '建议重点避免：数据转换错误会污染下游所有步骤。',
  'TERMINAL_NO_CHECK_AFTER_COMMAND': '重要教训：关键命令后必须检查输出/退出码/状态。',
  'AUTOMATION_NO_EFFECT_VERIFICATION': '建议重点避免：自动化动作后必须验证业务效果。',
  'OTHER': '建议重点关注：本次失败模式不属于常见类别，请复盘。',
};
