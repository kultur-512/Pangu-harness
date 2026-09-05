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
        // 打分器已归档（archive/2026-09-05-scoring/）：调用方（Chaser）必须给出
        // 验证锚定的 score（成功=100/未成功=0）；缺分兜底为 0（不猜）。
        if (traj.score === undefined || traj.score === null) {
          traj.score = 0;
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

