// Test-Time Compute + Trajectory System (Panshalach 记忆增强引擎)
// 打分以"长程记忆保持 + 验证密度"为核心，附 RBW 惩罚（通用安全价值）与早验证奖励（轻量）。

import { BenchmarkProfiles, BenchmarkType } from '../benchmarks/BenchmarkProfiles.js';

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
  score: number;
  /** 是否高纪律/验证密集目标 */
  isStrongTarget?: boolean;
  benchmarkType?: string;
  taskStyle?: string;
  estimatedUsedTokens?: number;
}

export class TrajectoryRecorder {
  private trajectories = new Map<string, Trajectory>();

  create(id: string, isStrongTarget = false, benchmarkType?: string, taskStyle?: string): Trajectory {
    const t: Trajectory = { id, steps: [], score: 0, isStrongTarget, benchmarkType, taskStyle: taskStyle ?? benchmarkType };
    this.trajectories.set(id, t);
    return t;
  }

  get(id: string): Trajectory | undefined {
    return this.trajectories.get(id);
  }

  addStep(id: string, step: TrajectoryStep) {
    const t = this.trajectories.get(id);
    if (t) t.steps.push(step);
  }

  setScore(id: string, score: number) {
    const t = this.trajectories.get(id);
    if (t) t.score = score;
  }

  getAll(): Trajectory[] {
    return Array.from(this.trajectories.values());
  }
}

export class TrajectoryScorer {
  /**
   * 长程记忆增强打分
   * 核心指标：
   * - 真实验证次数（最高权重）
   * - 严格 <> 格式纯度
   * - 早验证 + 深度批评
   * - 严重惩罚无验证就宣称成功的行为
   */
  static score(trajectory: Trajectory): number {
    let score = 0;
    // isStrongTarget: 高纪律模式下的验证密度奖励
    const isStrongTarget = !!trajectory.isStrongTarget;
    const taskStyle = (trajectory.taskStyle ?? trajectory.benchmarkType) as BenchmarkType | undefined;
    const profile = BenchmarkProfiles.get(taskStyle);

    const v = profile.scoringHints.verificationWeight;
    const early = profile.scoringHints.earlyVerifyBonus;

    // 1. 真实验证次数（核心指标）
    const verifiedSteps = trajectory.steps.filter(s =>
      s.result.includes('ALL_TESTS_PASSED') ||
      s.result.includes('VERIFICATION: PASS') ||
      s.result.toLowerCase().includes('all tests passed') ||
      s.result.toLowerCase().includes('verification: pass')
    ).length;

    score += verifiedSteps * (isStrongTarget ? 24 * v : 18 * v);

    if (trajectory.steps.length > 0) {
      const density = verifiedSteps / trajectory.steps.length;
      score += Math.round(density * 15 * (isStrongTarget ? v : 0.8));
    }

    // 2. 早验证奖励（轻量）
    const firstVerificationStep = trajectory.steps.findIndex(s =>
      s.result.includes('ALL_TESTS_PASSED') ||
      s.result.includes('VERIFICATION: PASS') ||
      s.didRealVerification === true
    );
    if (firstVerificationStep >= 0) {
      const earlyBonus = isStrongTarget
        ? Math.max(0, 12 - firstVerificationStep * 2) * early
        : Math.max(0, 8 - firstVerificationStep * 1.5) * early;
      score += earlyBonus;
    }

    // 3. RBW 违规惩罚（通用安全，保留）
    let rbwViolations = 0;
    for (const step of trajectory.steps) {
      if (step.readBeforeWriteViolation) rbwViolations++;
    }
    score -= rbwViolations * 12;

    // 4. 深度批评奖励（轻量）
    const deepCritiques = trajectory.steps.filter(s =>
      s.critique && s.critique.length > 160
    ).length;
    score += deepCritiques * (isStrongTarget ? 10 : 8);

    // 5. 严重惩罚：大量步骤几乎无验证
    const totalSteps = trajectory.steps.length;
    if (verifiedSteps === 0 && totalSteps >= 4) {
      score -= isStrongTarget ? 25 : 15;
    }
    if (verifiedSteps <= 1 && totalSteps >= 8) {
      score -= isStrongTarget ? 15 : 8;
    }

    // 6. 长度惩罚（轻量）
    score -= Math.max(0, totalSteps - 9) * (isStrongTarget ? 4 : 3);

    // 7. 思考深度奖励（轻量）
    const deepThoughts = trajectory.steps.filter(s => s.thought && s.thought.length > 320).length;
    score += deepThoughts * 4;

    return Math.max(0, Math.min(100, Math.round(score)));
  }
}

export class TestTimeOrchestrator {
  private recorder = new TrajectoryRecorder();

  async runMultiple(
    runOne: (rolloutId: string) => Promise<Trajectory>,
    count: number = 5,
    budget: { maxTokens?: number } = {},
    options: { isStrongTarget?: boolean; benchmarkType?: string; taskStyle?: string; parallel?: boolean } = {}
  ): Promise<Trajectory> {
    // 并行策略：quick/standard 串行；high+ 档位并行
    const isStrongTarget = !!options.isStrongTarget;
    const taskStyle = options.taskStyle ?? options.benchmarkType;
    const parallel = (options as any).parallel === true;

    const run = async (i: number): Promise<Trajectory | null> => {
      const id = `rollout-${i}`;
      this.recorder.create(id, isStrongTarget, taskStyle, taskStyle);
      try {
        const traj = await runOne(id);
        traj.isStrongTarget = isStrongTarget;
        traj.benchmarkType = taskStyle;
        traj.taskStyle = taskStyle;
        // 调用方提供的分数优先
        // (PanshalachChaser computes a richer verification-aware score); the
        // orchestrator's TrajectoryScorer is the fallback when absent.
        if (traj.score === undefined || traj.score === null) {
          traj.score = TrajectoryScorer.score(traj);
        }
        return traj;
      } catch {
        return null; // single-rollout failure never drags the batch
      }
    };

    if (parallel) {
      const settled = await Promise.allSettled(
        Array.from({ length: count }, (_, i) => run(i))
      );
      const results = settled
        .filter((r): r is PromiseFulfilledResult<Trajectory | null> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((t): t is Trajectory => t !== null);

      // budget aggregation (soft limit): if total spent across the batch
      // exceeds budget.maxTokens, drop the worst-scoring surplus rollouts.
      if (budget.maxTokens && results.length > 1) {
        const totalTokens = results.reduce((a, t) => a + (t.estimatedUsedTokens ?? 0), 0);
        if (totalTokens > budget.maxTokens) {
          results.sort((a, b) => b.score - a.score);
          let acc = 0;
          let keep = results.length;
          for (let i = 0; i < results.length; i++) {
            acc += results[i].estimatedUsedTokens ?? 0;
            if (acc > budget.maxTokens) { keep = i; break; }
          }
          results.length = Math.max(1, keep);
        }
      }

      results.sort((a, b) => b.score - a.score);
      return results[0];
    }

    const results: Trajectory[] = [];
    for (let i = 0; i < count; i++) {
      const traj = await run(i);
      if (!traj) continue;
      results.push(traj);
      if (traj.score >= 92) break;
    }

    results.sort((a, b) => b.score - a.score);
    return results[0];
  }
}

