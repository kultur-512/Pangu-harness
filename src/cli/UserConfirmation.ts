// Panshalach 用户确认流程
// 当档位需要用户确认时（strong / power）执行此流程
// 展示预估消耗、风险、记忆条数，并等待用户输入 yes

import { TierConfig } from '../tiers/TierConfig.js';
import { BudgetReport } from '../PanshalachChaser.js';
import { FailureMemory } from '../memory/FailureMemory.js';

export interface ConfirmationInput {
  tierConfig: TierConfig;
  estimatedTokensUpper: number;
  estimatedCalls: number;
  estimatedDuration: string;
  budgetReport?: BudgetReport;
  failureMemory?: FailureMemory;
  additionalRisks?: string[];
}

export interface ConfirmationResult {
  confirmed: boolean;
  userInput?: string;
  reason: string;
}

/**
 * 检查档位是否需要用户确认
 */
export function tierRequiresConfirmation(tierConfig: TierConfig): boolean {
  return tierConfig.userConfirmationRequired;
}

/**
 * 渲染确认面板
 */
export function renderConfirmationPanel(input: ConfirmationInput): string {
  const { tierConfig, estimatedTokensUpper, estimatedCalls, estimatedDuration, budgetReport, failureMemory, additionalRisks = [] } = input;
  const lines: string[] = [];

  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════════╗');
  lines.push(`║  ⚠️  Panshalach 用户确认 (Tier: ${tierConfig.tier.toUpperCase()})                     ║`);
  lines.push('╚══════════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`【档位】      ${tierConfig.tier}  (${tierConfig.typicalUseCase})`);
  lines.push(`【典型场景】  ${tierConfig.typicalUseCase}`);
  lines.push('');
  lines.push('──── 预估消耗 ────');
  lines.push(`  Token 上限:     ~${estimatedTokensUpper.toLocaleString()}`);
  lines.push(`  模型调用次数:   ~${estimatedCalls}`);
  lines.push(`  预估时长:       ~${estimatedDuration}`);
  if (budgetReport) {
    lines.push(`  预算已使用:     ${budgetReport.estimatedUsedTokens} (${Math.round(budgetReport.usageRatio * 100)}%)`);
  }
  lines.push('');
  lines.push('──── 主要风险 ────');
  lines.push(`  纪律规则强度:     ${tierConfig.ironLawInjectionLevel}（${tierConfig.verifyFirstBias ? '高验证优先' : '轻量验证'}）`);
  lines.push(`  探索深度:     ${tierConfig.explorationDepth}（${tierConfig.explorationDepth > 5 ? '激进' : '保守'}）`);
  lines.push(`  并行 rollout: ${tierConfig.parallelRollouts}`);
  lines.push(`  锚点上限:     ${tierConfig.anchorMax}`);
  if (tierConfig.isStrongMode) {
    lines.push('  高纪律模式:     启用（高纪律工程模式）');
  }
  if (failureMemory) {
    const cardCount = (failureMemory as any).getCardCount ? (failureMemory as any).getCardCount() : '未知';
    lines.push(`  记忆条数:     ${cardCount}（可能影响注入量）`);
  }
  for (const risk of additionalRisks) {
    lines.push(`  - ${risk}`);
  }
  lines.push('');
  lines.push('──── 预算策略 ────');
  lines.push(`  行为: ${tierConfig.budgetBehavior}（${tierConfig.budgetBehavior.includes('soft') ? '默认软限制，70% 警告 / 90% 动态降级' : '硬限制'}）`);
  lines.push('');
  lines.push('────────────────────────────────────────');
  lines.push('提示：输入 yes 继续，或使用 --yes 跳过交互（CI 场景需谨慎）');
  lines.push('────────────────────────────────────────');

  return lines.join('\n');
}

/**
 * 等待用户确认（同步 stdin）
 */
export function waitForUserConfirmation(prompt: string = '确认继续？[yes/no]: '): Promise<ConfirmationResult> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf-8');
    const onData = (chunk: string) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      const input = chunk.trim().toLowerCase();
      if (input === 'yes' || input === 'y') {
        resolve({ confirmed: true, userInput: input, reason: 'user confirmed' });
      } else {
        resolve({ confirmed: false, userInput: input, reason: 'user declined' });
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
