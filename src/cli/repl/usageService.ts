// src/cli/repl/usageService.ts
// local usage/cost accounting — no network, no secrets.
//
// Sources:
// - session.stats (accumulated by addTurn from budgetReports)
// - last turn's budgetReport (estimatedUsedTokens / usageRatio)
// - live context estimate (compactService estimator)
//
// Prices come from .panshalach.json `usagePrices` (OPTIONAL, append-only field —
// apiKey is never read here). Without prices, cost is reported as 0 with a
// "configure usagePrices" hint.

import type { Session } from './Session.js';
import { estimateSessionTokens } from './compactService.js';

export interface UsagePrices {
  inputPerMTokens?: number;   // e.g. 0.8  (currency per 1M input tokens)
  outputPerMTokens?: number;  // e.g. 2.0
  currency?: string;          // default 'USD'
}

export interface UsageReport {
  turns: number;
  totalDurationMs: number;
  sessionTokens: number;          // accumulated estimated tokens (from budgetReports)
  contextTokens: number;          // current live context estimate
  lastTurnEstimatedTokens: number;
  lastTurnUsageRatio: number | null;
  costUsd: number;
  currency: string;
  priceConfigured: boolean;
  lines: string[];
}

export function collectUsage(session: Session, prices?: UsagePrices): UsageReport {
  const last = session.turns.length > 0 ? session.turns[session.turns.length - 1] : null;
  const lastBudget: any = last?.result?.budgetReport;
  const lastTurnEstimatedTokens = Number(lastBudget?.estimatedUsedTokens) || 0;
  const contextTokens = estimateSessionTokens(session);
  const sessionTokens = session.stats.totalTokens || 0;
  const totalDurationMs = session.stats.totalDurationMs || 0;

  const priceConfigured = !!(prices && (prices.inputPerMTokens || prices.outputPerMTokens));
  let costUsd = 0;
  if (priceConfigured) {
    const inPerM = prices?.inputPerMTokens ?? 0;
    const outPerM = prices?.outputPerMTokens ?? 0;
    // Mixed estimate: assume 70% input / 30% output (typical agent workload).
    const inputTokens = sessionTokens * 0.7;
    const outputTokens = sessionTokens * 0.3;
    costUsd = (inputTokens / 1e6) * inPerM + (outputTokens / 1e6) * outPerM;
  }
  const currency = prices?.currency || 'USD';

  const fmt = (n: number) => n.toLocaleString('en-US');
  const lines: string[] = [];
  lines.push(`会话轮次: ${session.turns.length}  |  累计时长: ${(totalDurationMs / 1000).toFixed(1)}s`);
  lines.push(`累计 tokens（预算报告汇总）: ${fmt(sessionTokens)}`);
  lines.push(`当前上下文估算: ${fmt(contextTokens)} tokens`);
  if (lastBudget) {
    lines.push(`最近一轮: estimatedUsed=${fmt(lastTurnEstimatedTokens)} tokens, usageRatio=${lastBudget.usageRatio != null ? (lastBudget.usageRatio * 100).toFixed(0) + '%' : '-'}${lastBudget.triggeredSoftLimit ? ' (softLimit 触发)' : ''}`);
  } else {
    lines.push('最近一轮: (尚无预算报告)');
  }
  lines.push(
    priceConfigured
      ? `估算成本: ${currency} ${costUsd.toFixed(4)}（70/30 输入输出近似 × 配置单价）`
      : `估算成本: 未配置（在 .panshalach.json 追加 usagePrices: { inputPerMTokens, outputPerMTokens, currency } 后启用）`
  );

  return {
    turns: session.turns.length,
    totalDurationMs,
    sessionTokens,
    contextTokens,
    lastTurnEstimatedTokens,
    lastTurnUsageRatio: lastBudget?.usageRatio ?? null,
    costUsd,
    currency,
    priceConfigured,
    lines,
  };
}

/**
 * Read optional usagePrices from the workspace config. Never touches apiKey;
 * append-only access via ConfigManager (returns undefined when absent).
 */
export async function loadPricesFromConfig(workspaceRoot: string): Promise<UsagePrices | undefined> {
  try {
    const { ConfigManager } = await import('./ConfigManager.js');
    const all = new ConfigManager(workspaceRoot).getAll?.() ?? {};
    const up = (all as any).usagePrices;
    if (up && typeof up === 'object') {
      return {
        inputPerMTokens: Number(up.inputPerMTokens) || undefined,
        outputPerMTokens: Number(up.outputPerMTokens) || undefined,
        currency: typeof up.currency === 'string' ? up.currency : 'USD',
      };
    }
  } catch {}
  return undefined;
}
