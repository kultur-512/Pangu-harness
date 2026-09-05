// ============================================================
// 已归档（2026-09-05）：TrajectoryScorer —— 七因子过程纪律打分器
// ============================================================
// 归档原因（产品主指示：记忆管理为重点的 harness 除去对性能/叙事有影响的
// 功能）：
//   1. 本打分器度量的是"过程纪律"（验证密度/格式纯度/批判深度/思考长度），
//      不度量结果正确性——score 无法作为评测证据；
//   2. 数值 score 流入记忆系统后生成零信息量的成功卡
//      （"已验证可行的做法：score=90"，且所有 90 分任务 hash 撞进同一张卡）；
//   3. benchmark 时代残留，与"记忆作为上下文管家"主线无关。
//
// 替代语义（PanshalachChaser 内联）：score = result.success ? 100 : 0
//   （验证锚定两值；记忆 success 阈值 85 / success 闸门 80 行为不变）。
//
// 恢复方法：把本文件类体复制回 src/orchestration/TestTimeOrchestrator.ts，
// 并恢复 run() 中 `traj.score ??= TrajectoryScorer.score(traj)` 兜底；
// Chaser 内联块按 git 历史（7a90b4a 之后一版）恢复。
// 原始出处：commit 7a90b4a 的 src/orchestration/TestTimeOrchestrator.ts:61-127。

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

