# 2026-09-12 过程文档归档

0.8 周期（0.7.4 → 0.8.0-rc）落地后，按"文档与代码对齐 + 简化"整理：以下 14 篇为**迭代过程文档**（设计依据/调研/审查/个人计划），其内容已被实现吸收进活文档（`docs/panshalach/` 下的 ARCHITECTURE / MEMORY-DESIGN / USER-GUIDE / SUBMISSION / ROADMAP-NEXT / CHANGELOG），不再是权威口径。保留供追溯设计缘由与真机实证故事。

| 归档文档 | 原用途 | 现状去向 |
|---|---|---|
| PLAN-0.8-FOUNDATION.md | 0.8 立项设计（M1 协议重构 + M2 执行层强化） | M1/M2 已全部落地 → ARCHITECTURE.md §1/§3；M3 未做项 → ROADMAP-NEXT §3.2 |
| GAP-MATRIX-0.8.md | 烛龙×CC×hermes 交叉对比（0.8 立项输入） | 结论已兑现 → ARCHITECTURE.md §6 创新点与 CHANGELOG 0.8.0-rc 段 |
| HERMES-ALIGN-0.7.4.md | hermes 二次对齐调研 | 已兑现/并入 GAP-MATRIX |
| UI-UX-REVAMP-0.7.1.md | 0.7.1 UI 手感方案 | 已落地 → USER-GUIDE.md |
| REFLECTION-0.7.2.md | 0.7.2 反思迭代方案（意图前移+记忆落定） | 已落地 → USER-GUIDE §5 / MEMORY-DESIGN |
| USABLE-PLAN-0.7.3.md | 0.7.3 基本可用方案 | 已落地 → CHANGELOG 0.7.3 段 |
| ALIGNMENT-REVIEW-0.7.3.md | 命题偏离审查 | 风险已销项 |
| PLAN-0.7.4-FOR-CLAUDECODE.md | 0.7.4 执行计划 | 已落地 → CHANGELOG 0.7.4 段 |
| FIX-0.7-TERMINATION.md | 0.7.0 终止语义重构方案 | 已落地 → ARCHITECTURE §3 |
| CODE-AUDIT-SYNTHESIS-2026-09-10.md | 代码审计综合 | 修复项已入 CHANGELOG 0.8.0-rc |
| CHAT-LINK-ITERATION-0.8.1.md | 对话链路迭代方案 | 已落地（三级回落/think 剥离/错误分类） |
| PROJECT-BRIEF.md | 汇报底稿 | 被 SUBMISSION.md 与根 README 取代 |
| NEXT-STEPS-zhaiyuanhao.md | Leader 下一步计划 | 已完成大半，遗留并入 ROADMAP-NEXT |
| ROADMAP.md | 早期 P0-P7 里程碑 | 被 ROADMAP-NEXT.md 取代（P6 存储名迁移遗留 → ROADMAP-NEXT §3.2） |

## 2026-09-12 二次归档（合并收口后"只留成果与未完成项"整合）

| 归档文档 | 原用途 | 现状去向 |
|---|---|---|
| solution/（10 篇） | 命题方案系列草稿（0.6.x/0.7.x 时代撰写） | 已被 ARCHITECTURE/SUBMISSION 取代；创新点口径以 SUBMISSION.md §3 为准 |
| REFACTOR-ASSESSMENT.md | 0.6.x 时点重构评估 + §4 变更申报累计 | 历史报告；变更申报职责并入 CHANGELOG（各版本段即申报记录） |
| WORK-PLAN-2DAY-UNITS.md | 9/7-9/24 U1-U9 并行计划 | 已执行完毕（合并收口为终点）；当前路线见 ROADMAP-NEXT.md |
