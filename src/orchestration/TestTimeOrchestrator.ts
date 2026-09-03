// Test-Time Compute + Trajectory System (GLM-5.x Strong Engineering Agent)
// Multi-rollout with GLM-optimized scoring + multi-task-style support:
// - Heavy reward for correct strict GLM <> format (when targeting strong/high-rigor mode)
// - Task-style-specific verification density, early verification, state consistency (swe / terminal / automation)
// - Penalties for RBW (SWE), no-check-after-command (terminal), no-effect-verification (automation)
// 
// 设计目标：强化真实工程能力（日常高强度编码），而非功利刷 benchmark。

import { BenchmarkProfiles, BenchmarkType } from '../benchmarks/BenchmarkProfiles.js';

export interface TrajectoryStep {
  stepNumber: number;
  thought: string;
  plan: string;
  action: any;
  result: string;
  critique?: string;
  detectedFormat?: string;
  /** GLM Iron Law compliance signals */
  didRealVerification?: boolean;
  readBeforeWriteViolation?: boolean;
  /** 多任务风格额外信号（由 VerifyCritiqueLoop 填充） */
  terminalNoCheck?: boolean;
  automationNoEffectCheck?: boolean;
}

export interface Trajectory {
  id: string;
  steps: TrajectoryStep[];
  finalPatch?: string;
  score: number;
  isGlmTarget?: boolean;     // legacy-ish flag: whether this trajectory targeted strong/high-rigor mode (heavy verification, iron laws, strict format)
  benchmarkType?: string;    // legacy alias for taskStyle
  taskStyle?: string;        // e.g. 'terminal', 'automation', 'swe' (preferred public name)
  estimatedUsedTokens?: number; // D-parallel: per-rollout token spend for budget aggregation
}

export class TrajectoryRecorder {
  private trajectories = new Map<string, Trajectory>();

  create(id: string, isGlmTarget = false, benchmarkType?: string, taskStyle?: string): Trajectory {
    const t: Trajectory = { id, steps: [], score: 0, isGlmTarget, benchmarkType, taskStyle: taskStyle ?? benchmarkType };
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
   * GLM-5.x 极致强化打分
   * 核心指标：
   * - 真实验证次数（最高权重）
   * - 严格 <> 格式纯度
   * - 早验证 + 深度批评
   * - 严重惩罚无验证就宣称成功的行为
   */
  static score(trajectory: Trajectory): number {
    let score = 0;
    // isStrongTarget: indicates the trajectory was run under strong/high-rigor mode (heavy verification, iron laws, strict format expectations).
    // Legacy field name isGlmTarget is still populated for backward compat with existing consumers.
    const isStrongTarget = !!trajectory.isGlmTarget;
    const taskStyle = (trajectory.taskStyle ?? trajectory.benchmarkType) as BenchmarkType | undefined;
    const profile = BenchmarkProfiles.get(taskStyle);

    const v = profile.scoringHints.verificationWeight;
    const f = profile.scoringHints.formatWeight;
    const early = profile.scoringHints.earlyVerifyBonus;
    const state = profile.scoringHints.stateConsistencyBonus;

    // 1. 真实验证次数（按任务风格权重缩放，强力模式下给予更高权重）
    // 改进：去除过于宽泛的 includes('ok') / includes('success')，要求明确的验证信号
    const verifiedSteps = trajectory.steps.filter(s =>
      s.result.includes('ALL_TESTS_PASSED') ||
      s.result.includes('VERIFICATION: PASS') ||
      s.result.includes('PASS') ||
      s.result.toLowerCase().includes('all tests passed') ||
      s.result.toLowerCase().includes('verification: pass')
    ).length;

    score += verifiedSteps * (isStrongTarget ? 32 * v : 24 * v);

    if (trajectory.steps.length > 0) {
      const density = verifiedSteps / trajectory.steps.length;
      score += Math.round(density * 20 * (isStrongTarget ? v : 0.8));
    }

    // 2. 早验证奖励（按任务风格调整；强力模式奖励更激进）
    // 改进：要求明确的验证信号，而非模糊的 includes('pass')
    const firstVerificationStep = trajectory.steps.findIndex(s =>
      s.result.includes('ALL_TESTS_PASSED') ||
      s.result.includes('VERIFICATION: PASS') ||
      s.result.includes('PASS') ||
      s.didRealVerification === true
    );
    if (firstVerificationStep >= 0) {
      const earlyBonus = isStrongTarget
        ? Math.max(0, 18 - firstVerificationStep * 2.5) * early
        : Math.max(0, 10 - firstVerificationStep * 1.5) * early;
      score += earlyBonus;
    }

    // 3. 格式纯度 + Read-Before-Write + 多任务风格违规（强力模式对格式和铁律违规惩罚更重）
    let perfectFormat = 0;
    let badFormat = 0;
    let rbwViolations = 0;
    let terminalNoCheck = 0;
    let automationNoEffect = 0;

    for (const step of trajectory.steps) {
      const hasAction = Array.isArray(step.action) && step.action.length > 0;
      if (!hasAction) continue;

      const fmt = String(step.detectedFormat || '').toLowerCase();
      // 改进：空字符串不应被自动判定为 perfectFormat（之前会导致强力模式格式分恒正）
      // 只有明确识别为 strict / glm-xml 的才算完美格式
      if (fmt.includes('strict') || fmt.includes('glm-xml')) {
        perfectFormat++;
      } else if (fmt.includes('loose') || fmt.includes('plain') || fmt.includes('invoke')) {
        badFormat++;
      } else if (fmt === '' || fmt === 'unknown') {
        // 未检测到格式：中性，不加分也不扣分
      }

      if (step.readBeforeWriteViolation) rbwViolations++;
      if (step.terminalNoCheck) terminalNoCheck++;
      if (step.automationNoEffectCheck) automationNoEffect++;
    }

    score += perfectFormat * 14 * f;
    score -= badFormat * 22 * f;

    // RBW 惩罚：SWE/强力模式重，其它轻
    if (profile.type === 'swe' || (isStrongTarget && profile.defaultStrictIronLaws)) {
      score -= rbwViolations * 25;
    } else {
      score -= rbwViolations * 12;
    }

    // Terminal 风格专用惩罚
    if (profile.type === 'terminal-bench-3') {
      score -= terminalNoCheck * 20 * state;
    }

    // Automation 风格专用惩罚
    if (profile.type === 'automation-bench') {
      score -= automationNoEffect * 18 * state;
    }

    // 4. 深度批评（强力模式对长而有深度的 critique 奖励更高）
    const deepCritiques = trajectory.steps.filter(s =>
      s.critique && s.critique.length > 160
    ).length;
    score += deepCritiques * (isStrongTarget ? 16 : 12);

    // 5. 严重惩罚：大量步骤但几乎无验证（强力模式惩罚更严厉）
    const totalSteps = trajectory.steps.length;
    if (verifiedSteps === 0 && totalSteps >= 4) {
      score -= isStrongTarget ? 35 : 20;
    }
    if (verifiedSteps <= 1 && totalSteps >= 8) {
      score -= isStrongTarget ? 20 : 10;
    }

    // 6. 长度惩罚（强力模式对冗长轨迹惩罚更明显）
    score -= Math.max(0, totalSteps - 9) * (isStrongTarget ? 5 : 3.5);

    // 7. 思考深度
    const deepThoughts = trajectory.steps.filter(s => s.thought && s.thought.length > 320).length;
    score += deepThoughts * 6;

    // 8. 状态/效果验证奖励（Terminal & Automation 更看重）
    if (profile.type === 'automation-bench' || profile.type === 'terminal-bench-3') {
      const stateChecks = trajectory.steps.filter(s =>
        (s.result || '').toLowerCase().includes('state') ||
        (s.result || '').toLowerCase().includes('effect') ||
        (s.result || '').toLowerCase().includes('check') ||
        (s.result || '').toLowerCase().includes('verify') ||
        (s.result || '').toLowerCase().includes('ok')
      ).length;
      score += Math.round(stateChecks * 3 * state);
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }
}

export class TestTimeOrchestrator {
  private recorder = new TrajectoryRecorder();

  async runMultiple(
    runOne: (rolloutId: string) => Promise<Trajectory>,
    count: number = 5,
    budget: { maxTokens?: number } = {},
    options: { isGlmTarget?: boolean; benchmarkType?: string; taskStyle?: string; parallel?: boolean } = {}
  ): Promise<Trajectory> {
    // D-parallel: quick/standard stay SERIAL (cost-sensitive — the tier policy
    // is enforced by the caller passing a single count); high+ tiers run all
    // rollouts in PARALLEL via Promise.allSettled (a single failure never
    // drags the batch), with budget aggregation (Σ estimated tokens → soft
    // limit → early stop) and write-mutex serialization for shared-workspace
    // mutations (enforced by engineAdapter; read/bash stay parallel).
    const isStrongTarget = !!options.isGlmTarget;
    const taskStyle = options.taskStyle ?? options.benchmarkType;
    const parallel = (options as any).parallel === true;

    const run = async (i: number): Promise<Trajectory | null> => {
      const id = `rollout-${i}`;
      this.recorder.create(id, isStrongTarget, taskStyle, taskStyle);
      try {
        const traj = await runOne(id);
        traj.isGlmTarget = isStrongTarget;
        traj.benchmarkType = taskStyle;
        traj.taskStyle = taskStyle;
        // D-parallel (declared tweak): a caller-provided score is respected
        // (ZorgeChaser computes a richer verification-aware score); the
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

