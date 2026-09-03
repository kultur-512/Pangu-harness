// BenchmarkProfiles / TaskStyleProfiles - Multi-task-style support (SWE, Terminal, Automation etc.)
// 目标：让同一套强力工程框架能针对不同真实任务类型调整提示、验证策略、打分和失败记忆。
// 保留 GLM 铁律（Read-Before-Write、Verify-Before-Claim、严格 <> 格式）在强力模式下的高强度执行。
// 
// 这些 profile 不是为了刷特定 benchmark，而是为了让框架更好地适配日常工程场景（代码修改、终端、自动化流程等）。

export type BenchmarkType =
  | 'swe'                    // SWE-Bench / SWE-Pro 风格代码仓库修复
  | 'terminal-bench-3'       // Terminal-Bench 3.0：终端命令驱动、状态达成
  | 'automation-bench'       // Zapier AutomationBench：业务工作流 / 自动化编排
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
  /** 是否默认在强力模式下走严格铁律（高纪律路径） */
  defaultStrictIronLaws: boolean;
  /** prompt 中要强调的核心原则（简短） */
  emphasis: string;
  /** 打分权重偏好（相对基线） */
  scoringHints: {
    verificationWeight: number;   // 验证通过的权重乘数
    formatWeight: number;         // 格式纯度权重
    earlyVerifyBonus: number;
    stateConsistencyBonus: number;
  };
  /** 常见失败模式（用于 FailureMemory 分类引导） */
  commonFailureModes: string[];
}

const PROFILES: Record<BenchmarkType, BenchmarkProfile> = {
  'swe': {
    type: 'swe',
    displayName: 'SWE-Bench / Code Repair',
    primaryTools: ['Read', 'Write', 'Edit', 'Bash', 'RunTest'],
    verificationStyle: 'test-suite',
    verifyFirstBias: true,
    defaultStrictIronLaws: true,
    emphasis: '必须先完整读取文件，修改后必须通过测试或直接执行验证，再声称修复。',
    scoringHints: { verificationWeight: 1.0, formatWeight: 1.0, earlyVerifyBonus: 1.0, stateConsistencyBonus: 0.6 },
    commonFailureModes: ['READ_BEFORE_WRITE_VIOLATION', 'WEAK_VERIFICATION', 'NO_VERIFICATION_BEFORE_CLAIM', 'HALLUCINATED_FILE']
  },

  'terminal-bench-3': {
    type: 'terminal-bench-3',
    displayName: 'Terminal-Bench 3.0',
    primaryTools: ['Bash', 'RunCommand', 'Read', 'Write', 'Ls', 'CheckState'],
    verificationStyle: 'terminal-command',
    verifyFirstBias: true,
    defaultStrictIronLaws: true,
    emphasis: '通过终端命令完成任务。每次关键命令后必须检查输出/退出码/文件状态，确认目标达成后再停止。避免无谓的破坏性操作。',
    scoringHints: { verificationWeight: 1.15, formatWeight: 0.9, earlyVerifyBonus: 1.2, stateConsistencyBonus: 1.0 },
    commonFailureModes: ['COMMAND_FAILED', 'STATE_MISMATCH', 'WEAK_VERIFICATION', 'OVERCONFIDENCE']
  },

  'automation-bench': {
    type: 'automation-bench',
    displayName: 'AutomationBench (Business Workflows)',
    primaryTools: ['CallApi', 'ExecuteWorkflow', 'TransformData', 'CheckStatus', 'VerifyEffect'],
    verificationStyle: 'workflow-effect',
    verifyFirstBias: true,
    defaultStrictIronLaws: false,   // 业务流程更强调数据正确性和副作用验证，不一定严格文件读写铁律
    emphasis: '准确理解业务触发与动作映射。每个自动化步骤都要验证数据流动和最终效果（记录创建、通知发送、状态更新等）。注意幂等性和错误恢复。',
    scoringHints: { verificationWeight: 1.1, formatWeight: 0.7, earlyVerifyBonus: 0.9, stateConsistencyBonus: 1.3 },
    commonFailureModes: ['DATA_TRANSFORM_ERROR', 'WORKFLOW_STEP_ERROR', 'STATE_MISMATCH', 'WEAK_VERIFICATION']
  },

  'auto': {
    type: 'auto',
    displayName: 'Auto (fallback to SWE style)',
    primaryTools: ['Read', 'Write', 'Bash'],
    verificationStyle: 'test-suite',
    verifyFirstBias: true,
    defaultStrictIronLaws: true,
    emphasis: '根据任务特征自动选择验证方式，优先验证再声称。',
    scoringHints: { verificationWeight: 1.0, formatWeight: 1.0, earlyVerifyBonus: 1.0, stateConsistencyBonus: 0.8 },
    commonFailureModes: ['WEAK_VERIFICATION', 'HALLUCINATED_FILE']
  }
};

export class BenchmarkProfiles {
  static get(type: BenchmarkType | string | undefined): BenchmarkProfile {
    if (!type) return PROFILES['swe'];
    const key = (type as string).toLowerCase().replace(/[-_ ]/g, '-');
    if (key === 'terminal-bench' || key === 'terminal-bench-3' || key === 'terminalbench') {
      return PROFILES['terminal-bench-3'];
    }
    if (key === 'automation' || key === 'automation-bench' || key === 'automationbench') {
      return PROFILES['automation-bench'];
    }
    if (key === 'swe' || key === 'swe-bench' || key === 'swepro') {
      return PROFILES['swe'];
    }
    return (PROFILES as any)[key] ?? PROFILES['swe'];
  }

  static getAll(): BenchmarkProfile[] {
    return Object.values(PROFILES);
  }

  /**
   * 生成任务风格特定的 prompt 前缀/强调块（用于注入到 reasoning prompt）
   * highRigor: 是否处于高纪律/强力模式（behavioral strong mode），用于决定是否注入严格铁律提示。
   * 兼容旧调用方传入 isStrictGlm 语义的布尔值。
   */
  static getPromptHeader(profile: BenchmarkProfile, highRigor: boolean): string {
    const base = `【当前任务风格: ${profile.displayName}】\n${profile.emphasis}\n`;

    const toolList = profile.primaryTools.join('、');
    const tools = `重点工具：${toolList}。请优先使用这些工具达成目标。\n`;

    let iron = '';
    if (highRigor && profile.defaultStrictIronLaws) {
      iron = '严格遵守 Read-Before-Write（必要时先读文件/状态）和 Verify-Before-Claim（看到明确成功信号再声称完成）。\n';
    }

    return base + tools + iron;
  }

  /**
   * 生成验证风格提示（在循环中轻量注入）
   */
  static getVerificationHint(profile: BenchmarkProfile): string {
    switch (profile.verificationStyle) {
      case 'terminal-command':
        return '【验证提示】关键命令执行后，必须立即检查 exit code、stdout/stderr 或目标文件/进程状态。';
      case 'state-assertion':
      case 'workflow-effect':
        return '【验证提示】执行动作后，必须用 CheckStatus / VerifyEffect 等手段确认业务状态或数据效果已达成。';
      case 'test-suite':
      default:
        return '【验证提示】修改或操作后，优先运行测试或验证命令，确认 PASS 再继续。';
    }
  }
}
