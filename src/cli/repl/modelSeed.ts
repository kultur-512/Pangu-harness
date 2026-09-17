// src/cli/repl/modelSeed.ts
// session.model 播种：env 优先（applyEnvModel），配置文件兜底（本模块）。
// 背景：headless 一次性执行与交互入口此前只认 PANSHA_MODEL env，配置文件
// （项目级 .panshalach.json / 用户级 ~/.panshalach/config.json）里的 model
// 字段从未被读进 session，导致不带 env 启动时报"未配置可用的模型客户端"。

import { ConfigManager } from './ConfigManager.js';
import type { SessionApprovalMode } from './Session.js';
import { TierRegistry } from '../../tiers/TierConfig.js';

/**
 * PANSHA_MODEL env seeds the session model（headless one-shot 多 provider，
 * e.g. PANSHA_MODEL="a6:openPangu-7B"）。返回 session 本身便于链式播种。
 * D1（真机实测 2026-09-15）：交互 REPL（rich/classic）此前从不调用本函数，
 * PANSHA_MODEL 被静默忽略——带 minimax:MiniMax-M3 启动仍落在配置文件 1B。
 * 播种顺序纪律：applyEnvModel → applyConfigModel（env 优先，配置兜底）。
 */
export function applyEnvModel(session: { model: string }): { model: string } {
  const envModel = process.env.PANSHA_MODEL;
  if (envModel && typeof envModel === 'string' && envModel.trim()) {
    session.model = envModel.trim();
  }
  return session;
}

/** 仅当 model 仍是占位 'default' 时才用配置兜底；env / 显式 /model 选择永远优先。 */
export function applyConfigModel(
  session: { model: string },
  workspaceRoot?: string
): { model: string } {
  if (session.model && session.model !== 'default') return session;
  try {
    const m = new ConfigManager(workspaceRoot ?? process.cwd()).get('model');
    if (typeof m === 'string' && m.trim()) session.model = m.trim();
  } catch {
    // 配置缺失/损坏时静默保持 'default'（resolveClient 已有降级与报错路径）
  }
  return session;
}

const APPROVAL_MODES: readonly SessionApprovalMode[] = ['readonly', 'default', 'full'];

/** PANSHA_APPROVAL / --approval：one-shot/headless 的审批档位；非法值静默回落 readonly。 */
export function envApprovalMode(): SessionApprovalMode | undefined {
  const v = process.env.PANSHA_APPROVAL?.trim().toLowerCase();
  if (!v) return undefined;
  return (APPROVAL_MODES as readonly string[]).includes(v) ? (v as SessionApprovalMode) : undefined;
}

/** PANSHA_TIER：headless one-shot 的档位（六档 quick/standard/high/max/ex/pangu + 旧别名）；非法值静默回落 undefined（Session 默认 high）。 */
export function envTier(): string | undefined {
  const v = process.env.PANSHA_TIER?.trim().toLowerCase();
  if (!v) return undefined;
  return TierRegistry.isTier(v) ? TierRegistry.normalize(v) : undefined;
}
