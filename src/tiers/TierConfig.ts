// Panshalach 六档强度体系（TierConfig）
// 全部使用小写：quick / standard / high / max / ex / pangu
// 默认档位：high（高强度 + 高验证密度 + 高适用编码）
// 目标：让每个 tier 都有可量化的行为契约，差异化纪律规则、记忆、探索、预算

export type Tier =
  | 'quick'
  | 'standard'
  | 'high'
  | 'max'
  | 'ex'
  | 'pangu';

export const DEFAULT_TIER: Tier = 'high';

/**
 * 旧 tier 名 alias 映射（3 个月过渡期）
 * 迁移策略：
 *   rapid -> quick
 *   fast  -> standard
 *   strong -> max
 *   power -> pangu
 *   (high / max / ex 在新六档中已存在，ex 来自 strong 的更激进含义)
 */
const TIER_ALIASES: Record<string, Tier> = {
  rapid: 'quick',
  fast: 'standard',
  strong: 'max',
  power: 'pangu',
  zorge: 'pangu', // 旧档位名 zorge → pangu（兼容既有会话/配置）
};

export interface CritiqueFrequencySpec {
  /** 周期性复盘的步数间隔（0 = 不周期性复盘） */
  periodicEvery: number;
  /** 是否在问题步骤必须复盘 */
  onProblem: boolean;
  /** 连续多少步未真实验证后强制复盘（0 = 不强制） */
  longNoVerifyThreshold: number;
  /** 前几步跳过复盘（减少早期噪音） */
  skipFirstN: number;
}

export type IronLawInjectionLevel = 'none' | 'minimal' | 'low' | 'medium' | 'medium_high' | 'high' | 'highest';

export type BudgetBehavior = 'hard_cap' | 'soft_limit' | 'soft_limit_with_report' | 'soft_limit_with_warning';

export interface TierConfig {
  tier: Tier;
  /** 人类可读的典型场景 */
  typicalUseCase: string;
  /** 默认 maxRollouts */
  maxRollouts: number;
  /** 默认 maxStepsPerRollout */
  maxStepsPerRollout: number;
  /** critique 频率配置 */
  critiqueFrequency: CritiqueFrequencySpec;
  /** 纪律规则注入强度 */
  ironLawInjectionLevel: IronLawInjectionLevel;
  /** maxConsecutiveFailures */
  maxConsecutiveFailures: number;
  /** verifyFirstBias */
  verifyFirstBias: boolean;
  /** 探索深度（RepoExplorer maxDepth） */
  explorationDepth: number;
  /** 失败记忆加载级别 */
  memoryLoadLevel: 'none' | 'light' | 'medium' | 'high' | 'full';
  /** 预算行为 */
  budgetBehavior: BudgetBehavior;
  /** 是否允许并行 rollout */
  parallelRollouts: number;
  /** 是否需要用户确认 */
  userConfirmationRequired: boolean;
  /** 是否高纪律模式（isStrongMode 等价行为） */
  isStrongMode: boolean;
  /** 锚点数量上限 */
  anchorMax: number;
}

const TIER_CONFIGS: Record<Tier, TierConfig> = {
  quick: {
    tier: 'quick',
    typicalUseCase: '热修复、临时检查',
    maxRollouts: 1,
    maxStepsPerRollout: 10,
    critiqueFrequency: { periodicEvery: 0, onProblem: true, longNoVerifyThreshold: 0, skipFirstN: 2 },
    ironLawInjectionLevel: 'none',
    maxConsecutiveFailures: 2,
    verifyFirstBias: false,
    explorationDepth: 3,
    memoryLoadLevel: 'none',
    budgetBehavior: 'hard_cap',
    parallelRollouts: 1,
    userConfirmationRequired: false,
    isStrongMode: false,
    anchorMax: 4,
  },
  standard: {
    tier: 'standard',
    typicalUseCase: '常规小修改',
    maxRollouts: 1,
    maxStepsPerRollout: 15,
    critiqueFrequency: { periodicEvery: 4, onProblem: true, longNoVerifyThreshold: 4, skipFirstN: 2 },
    ironLawInjectionLevel: 'low',
    maxConsecutiveFailures: 3,
    verifyFirstBias: false,
    explorationDepth: 4,
    memoryLoadLevel: 'light',
    budgetBehavior: 'soft_limit',
    parallelRollouts: 1,
    userConfirmationRequired: false,
    isStrongMode: false,
    anchorMax: 6,
  },
  high: {
    tier: 'high',
    typicalUseCase: '日常主力（推荐）',
    maxRollouts: 1,
    maxStepsPerRollout: 20,
    critiqueFrequency: { periodicEvery: 5, onProblem: true, longNoVerifyThreshold: 4, skipFirstN: 3 },
    ironLawInjectionLevel: 'low',
    maxConsecutiveFailures: 3,
    verifyFirstBias: false,
    explorationDepth: 5,
    memoryLoadLevel: 'medium',
    budgetBehavior: 'soft_limit_with_report',
    parallelRollouts: 1,
    userConfirmationRequired: false,
    isStrongMode: false,
    anchorMax: 8,
  },
  max: {
    tier: 'max',
    typicalUseCase: '重要/高风险任务',
    maxRollouts: 3,
    maxStepsPerRollout: 25,
    critiqueFrequency: { periodicEvery: 2, onProblem: true, longNoVerifyThreshold: 2, skipFirstN: 1 },
    ironLawInjectionLevel: 'high',
    maxConsecutiveFailures: 4,
    verifyFirstBias: true,
    explorationDepth: 6,
    memoryLoadLevel: 'high',
    budgetBehavior: 'soft_limit_with_warning',
    parallelRollouts: 2,
    userConfirmationRequired: true, // 必须
    isStrongMode: true,
    anchorMax: 10,
  },
  ex: {
    tier: 'ex',
    typicalUseCase: '极难任务、核心模块',
    maxRollouts: 4,
    maxStepsPerRollout: 30,
    critiqueFrequency: { periodicEvery: 2, onProblem: true, longNoVerifyThreshold: 2, skipFirstN: 1 },
    ironLawInjectionLevel: 'highest',
    maxConsecutiveFailures: 5,
    verifyFirstBias: true,
    explorationDepth: 7,
    memoryLoadLevel: 'high',
    budgetBehavior: 'soft_limit_with_warning',
    parallelRollouts: 3,
    userConfirmationRequired: true, // 必须
    isStrongMode: true,
    anchorMax: 12,
  },
  pangu: {
    tier: 'pangu',
    typicalUseCase: '极致追求（终极长程记忆模式）',
    maxRollouts: 5,
    maxStepsPerRollout: 40,
    critiqueFrequency: { periodicEvery: 2, onProblem: true, longNoVerifyThreshold: 2, skipFirstN: 1 },
    ironLawInjectionLevel: 'highest',
    maxConsecutiveFailures: 6,
    verifyFirstBias: true,
    explorationDepth: 8,
    memoryLoadLevel: 'full',
    budgetBehavior: 'soft_limit_with_warning',
    parallelRollouts: 4,
    userConfirmationRequired: true, // 必须 + 预算确认
    isStrongMode: true,
    anchorMax: 15,
  },
};

export class TierRegistry {
  static get(tier: Tier | string | undefined): TierConfig {
    if (!tier) return TIER_CONFIGS[DEFAULT_TIER];
    const raw = String(tier).toLowerCase();
    // alias 兼容
    const aliased = TIER_ALIASES[raw] ?? (raw as Tier);
    return TIER_CONFIGS[aliased] ?? TIER_CONFIGS[DEFAULT_TIER];
  }

  static getAll(): TierConfig[] {
    return Object.values(TIER_CONFIGS);
  }

  static isTier(value: string): boolean {
    const raw = String(value).toLowerCase();
    return raw in TIER_CONFIGS || raw in TIER_ALIASES;
  }

  static get defaultTier(): Tier {
    return DEFAULT_TIER;
  }

  /**
   * 把新 tier 映射到旧 `isStrongMode` 旗标，便于逐步清理旧代码
   */
  static toLegacyIsStrongMode(tier: Tier | string | undefined): boolean {
    return TierRegistry.get(tier).isStrongMode;
  }

  /**
   * 旧 --mode 旗标到新 tier 的转换（兼容层）
   */
  static fromLegacyMode(mode: 'strong' | 'practical' | 'universal' | undefined): Tier {
    if (!mode) return DEFAULT_TIER;
    if (mode === 'practical') return 'quick';
    if (mode === 'strong') return 'high';
    if (mode === 'universal') return 'standard';
    return DEFAULT_TIER;
  }
}
