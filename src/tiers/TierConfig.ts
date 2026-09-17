// Panshalach 六档强度体系（TierConfig）
// 全部使用小写：quick / standard / high / max / ex / pangu
// 默认档位：high（实用优先/标准纪律，轻纪律 low 注入）；高纪律档为 max/ex/pangu
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

export type IronLawInjectionLevel = 'none' | 'minimal' | 'low' | 'medium' | 'medium_high' | 'high' | 'highest';

export interface TierConfig {
  tier: Tier;
  /** 人类可读的典型场景 */
  typicalUseCase: string;
  /** 默认 maxStepsPerRollout（0 = 不限步数，预算闸兜底；2026-09-16 取消步数限制） */
  maxStepsPerRollout: number;
  /** 纪律规则注入强度（仅强档 isStrongMode=true 生效；非强档省略） */
  ironLawInjectionLevel?: IronLawInjectionLevel;
  /** maxConsecutiveFailures */
  maxConsecutiveFailures: number;
  /** verifyFirstBias */
  verifyFirstBias: boolean;
  /** 失败记忆加载级别 */
  memoryLoadLevel: 'none' | 'light' | 'medium' | 'high' | 'full';
  /** 是否高纪律模式（严格解析 + 验证密集） */
  isStrongMode: boolean;
  /** 是否在探索阶段自动拉取溢出记忆（standard/high 档语义） */
  autoPullMemory: boolean;
}

const TIER_CONFIGS: Record<Tier, TierConfig> = {
  quick: {
    tier: 'quick',
    typicalUseCase: '热修复、临时检查',
    maxStepsPerRollout: 0,
    maxConsecutiveFailures: 2,
    verifyFirstBias: false,
    memoryLoadLevel: 'light',
    isStrongMode: false,
    autoPullMemory: false,
  },
  standard: {
    tier: 'standard',
    typicalUseCase: '常规小修改',
    maxStepsPerRollout: 0,
    maxConsecutiveFailures: 3,
    verifyFirstBias: false,
    memoryLoadLevel: 'light',
    isStrongMode: false,
    autoPullMemory: true,
  },
  high: {
    tier: 'high',
    typicalUseCase: '日常主力（推荐）',
    maxStepsPerRollout: 0,
    maxConsecutiveFailures: 3,
    verifyFirstBias: false,
    memoryLoadLevel: 'medium',
    isStrongMode: false,
    autoPullMemory: true,
  },
  max: {
    tier: 'max',
    typicalUseCase: '重要/高风险任务',
    maxStepsPerRollout: 0,
    ironLawInjectionLevel: 'high',
    maxConsecutiveFailures: 4,
    verifyFirstBias: true,
    memoryLoadLevel: 'high',
    isStrongMode: true,
    autoPullMemory: false,
  },
  ex: {
    tier: 'ex',
    typicalUseCase: '极难任务、核心模块',
    maxStepsPerRollout: 0,
    ironLawInjectionLevel: 'highest',
    maxConsecutiveFailures: 5,
    verifyFirstBias: true,
    memoryLoadLevel: 'high',
    isStrongMode: true,
    autoPullMemory: false,
  },
  pangu: {
    tier: 'pangu',
    typicalUseCase: '极致追求（终极长程记忆模式）',
    maxStepsPerRollout: 0,
    ironLawInjectionLevel: 'highest',
    maxConsecutiveFailures: 6,
    verifyFirstBias: true,
    memoryLoadLevel: 'full',
    isStrongMode: true,
    autoPullMemory: false,
  },
};

export class TierRegistry {
  static get(tier: Tier | string | undefined): TierConfig {
    return TIER_CONFIGS[TierRegistry.normalize(tier)];
  }

  static getAll(): TierConfig[] {
    return Object.values(TIER_CONFIGS);
  }

  static isTier(value: string): boolean {
    const raw = String(value).toLowerCase();
    return raw in TIER_CONFIGS || raw in TIER_ALIASES;
  }

  /**
   * 任务风格（ModelMode）到 tier 的映射
   * strong = 高纪律 → max；practical = 务实 → quick；universal = 通用 → standard
   */
  static fromMode(mode: 'strong' | 'practical' | 'universal' | undefined): Tier {
    if (!mode) return DEFAULT_TIER;
    if (mode === 'practical') return 'quick';
    if (mode === 'strong') return 'max';
    if (mode === 'universal') return 'standard';
    return DEFAULT_TIER;
  }

  /**
   * 唯一 tier 归一化入口：trim + lowercase 后依次尝试
   *   mode 名（strong/practical/universal）→ fromMode 语义；
   *   alias（rapid/fast/strong/power/zorge）→ alias 映射；
   *   规范 tier → 自身；
   *   否则 → DEFAULT_TIER。
   */
  static normalize(input: string | undefined): Tier {
    const raw = String(input ?? '').trim().toLowerCase();
    if (!raw) return DEFAULT_TIER;
    if (raw === 'strong' || raw === 'practical' || raw === 'universal') {
      return TierRegistry.fromMode(raw as 'strong' | 'practical' | 'universal');
    }
    const aliased = TIER_ALIASES[raw];
    if (aliased) return aliased;
    if (raw in TIER_CONFIGS) return raw as Tier;
    return DEFAULT_TIER;
  }
}
