# 归档：轨迹打分器（TrajectoryScorer + Chaser 内联评分块）

- **归档日期**：2026-09-05
- **归档决定**：产品主（记忆管理为重点的 harness，除去对性能/叙事有影响的功能）
- **归档内容**：
  1. `TrajectoryScorer` 七因子过程纪律打分器（原 `src/orchestration/TestTimeOrchestrator.ts:61-127`）→ 本目录 `TrajectoryScorer.archived.ts`；
  2. `PanshalachChaser` 内联启发式评分块（`88 / 35+步数×2` + 强档格式加分/早过加分）→ 直接移除。
- **替代语义**：`score = result.success ? 100 : 0`（验证锚定两值）。

## 为什么归档（三理由）

1. **度量的不是结果**：七因子全部是过程指标（验证密度、`<>` 格式纯度、批判长度、思考长度），分数高不代表任务做对——不能作为命题评测证据（EVALUATION.md 的 A/B/C 依赖任务级脚本断言）。
2. **污染记忆系统**：数值 score 经 `Turn.summary(score=NN)` 流入 `refine()`（≥85 触发 success 卡）与 compact 补漏，产出零信息量卡片（"已验证可行的做法：score=90"），且所有 90 分任务按 hash 撞进同一张卡、count 无界增长。
3. **benchmark 叙事残留**：与"记忆作为上下文管家"主线无关；强档格式加分是旧模型工具协议时代的产物。

## 行为变化（对下游的不变式）

| 消费点 | 旧 | 新 | 影响 |
|---|---|---|---|
| success 闸门（`best.score >= 80`） | success→88 过闸；failure 30~80 分——**步数 ≥23 的失败轨迹也能过闸（潜在 bug）** | success→100 过闸；failure→0 不过闸 | 修复上述潜在 bug；正常成败判定不变 |
| 记忆 success 卡阈值（`>=85`） | 88≥85 触发 | 100≥85 触发 | 行为不变 |
| compact 补漏（正则抽 `score=(\d+)`，≥85） | score=88 | score=100 | 触发行为不变（卡片内容零信息量问题仍在，独立改进项） |
| orchestrator 早停（`score >= 92`） | 成功 88 分不停、靠多 rollout | 成功 100 分即停 | **token 节省**（首个成功 rollout 后不再空转） |
| budget 聚合裁剪（按 score 排序） | 88/30-80 排序 | 100/0 排序 | 成功轨迹优先保留，语义更正确 |

## 恢复方法

1. 把 `TrajectoryScorer.archived.ts` 的类体复制回 `src/orchestration/TestTimeOrchestrator.ts`；
2. 恢复 run() 兜底 `traj.score ??= TrajectoryScorer.score(traj)`；
3. Chaser 内联块按 git 历史（`7a90b4a` 版本的 `src/PanshalachChaser.ts:505-512`）恢复；
4. 跑 `npm test` + `npx tsc --noEmit`。

## 未随归档的相邻机制（待产品主裁决，见探测报告）

- critique 自我批判（每 N 步一次**额外模型调用**，token 成本）；
- 多 rollout best-of-N（`maxRollouts`，token 成本最大户）；
- `BenchmarkProfiles`（swe/terminal/automation 任务风格头注入）。

## 追记（2026-09-05 晚）：score 字段整体移除

两值化（100/0）只是过渡——产品主随后裁决 **score 概念彻底退出**：
- `Trajectory.score` → `Trajectory.success?`；orchestrator 排序/早停/预算裁剪按 success；
- `solveIssue`/`RunResult`/result 事件/SSE done 事件/全部 UI 显示移除 score；
- 记忆正向信号：`trajectory.success`（验证通过）或正向反馈；`POSITIVE_SCORE_THRESHOLD` 删除；
- compact 补漏信号源 = `result.success`，success 卡 evidence = 该轮任务摘要（零信息量卡与高分 hash 撞卡问题一并消除）。
本文档的"两值化"描述仅作历史记录；当前语义以 CHANGELOG 0.6.3 为准。
