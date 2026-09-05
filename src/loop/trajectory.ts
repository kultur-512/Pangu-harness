// src/loop/trajectory.ts
// 轨迹类型（0.7 从 TestTimeOrchestrator 迁出——该编排器已归档，
// runMultiple 恒单次后 count/sort/预算裁剪全为死路径）。
//
// Trajectory 是"一条 rollout"的轨迹：steps 为逐步轨迹，success/stopReason
// 是回合结局（见 src/cli/repl/types.ts TurnStopReason）。continueCount 已
// 随判官机制摘除（2026-09-05 0.7）。

import type { TurnStopReason } from '../cli/repl/types.js';

export interface TrajectoryStep {
  stepNumber: number;
  thought: string;
  plan: string;
  action: any;
  result: string;
  critique?: string;
  detectedFormat?: string;
  /** 工程纪律合规信号 */
  didRealVerification?: boolean;
  readBeforeWriteViolation?: boolean;
  terminalNoCheck?: boolean;
  automationNoEffectCheck?: boolean;
}

export interface Trajectory {
  id: string;
  steps: TrajectoryStep[];
  finalPatch?: string;
  /** 成败由验证信号判定（loop：存在 PASS/ALL_TESTS_PASSED 步；answered 亦计入成功） */
  success?: boolean;
  /** 回合停止原因（单层终止语义） */
  stopReason?: TurnStopReason;
  /**
   * aborted 时本步已流出的模型正文（部分结果）。
   * 宿主（sseInteractive/Repl）据此落带 partialText 的 aborted turn。
   */
  partialText?: string;
  /** 单 rollout 全部失败时保留的最后错误（空批保护） */
  lastError?: string;
  /** 是否高纪律/验证密集目标 */
  isStrongTarget?: boolean;
  benchmarkType?: string;
  taskStyle?: string;
  estimatedUsedTokens?: number;
}

/** 空批保护：全部 rollout 失败时的合成失败轨迹（绝不返回 undefined）。 */
export function syntheticFailureTrajectory(lastError?: string): Trajectory {
  return {
    id: 'rollout-all-failed',
    steps: [],
    success: false,
    stopReason: 'aborted',
    lastError,
  };
}
