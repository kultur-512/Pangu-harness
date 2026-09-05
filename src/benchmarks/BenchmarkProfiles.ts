// BenchmarkProfiles / TaskStyleProfiles — Panshalach 记忆增强智能体风格
// 保留 swe（软件工程长期维护）作为主场景 profile；去掉 terminal/automation 等与记忆增强无关的 benchmark 刷分风格。
// 保留 auto 作为自动推断 fallback。

export type BenchmarkType =
  | 'swe'                    // 代码修复/软件工程维护（主场景）
  | 'auto';                  // 自动推断（根据任务描述或默认 swe）

export interface BenchmarkProfile {
  type: BenchmarkType;
  displayName: string;
  /** 推荐/重点使用的工具名（用于 prompt 引导） */
  primaryTools: string[];
  /** 验证风格 */
  verificationStyle: 'test-suite' | 'terminal-command' | 'state-assertion' | 'workflow-effect';
  /** 是否强烈推荐“先验证再声称” */
  verifyFirstBias: boolean;
  /** 是否默认走严格纪律规则 */
  defaultStrictIronLaws: boolean;
  /** prompt 中要强调的核心原则（简短） */
  emphasis: string;
  /** 常见失败模式（用于 FailureMemory 分类引导） */
  commonFailureModes: string[];
}

const PROFILES: Record<BenchmarkType, BenchmarkProfile> = {
  'swe': {
    type: 'swe',
    displayName: '软件工程长期维护（主场景）',
    primaryTools: ['Read', 'Write', 'Edit', 'Bash', 'RunTest'],
    verificationStyle: 'test-suite',
    verifyFirstBias: false,
    defaultStrictIronLaws: false,
    emphasis: '先完整读取文件，修改后验证效果。长程任务中注意使用 /memory 沉淀教训与经验，避免早期决策随着轮次增加被遗忘。',
    commonFailureModes: ['READ_BEFORE_WRITE_VIOLATION', 'WEAK_VERIFICATION', 'NO_VERIFICATION_BEFORE_CLAIM'],
  },

  'auto': {
    type: 'auto',
    displayName: '自动推断（默认 SWE 风格）',
    primaryTools: ['Read', 'Write', 'Bash'],
    verificationStyle: 'test-suite',
    verifyFirstBias: false,
    defaultStrictIronLaws: false,
    emphasis: '根据任务自动选择验证方式，优先验证再声称。长程任务建议开启 /memory 自动沉淀。',
    commonFailureModes: ['WEAK_VERIFICATION', 'HALLUCINATED_FILE'],
  },
};

export class BenchmarkProfiles {
  static get(type: BenchmarkType | string | undefined): BenchmarkProfile {
    if (!type) return PROFILES['swe'];
    const key = (type as string).toLowerCase().replace(/[-_ ]/g, '-');
    if (key === 'swe' || key === 'swe-bench' || key === 'swepro' || key === 'maintenance') {
      return PROFILES['swe'];
    }
    return (PROFILES as any)[key] ?? PROFILES['swe'];
  }

  static getAll(): BenchmarkProfile[] {
    return Object.values(PROFILES);
  }

}
