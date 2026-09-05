# Agent 注册卡 — zhaotianang

- 控制人: 赵天昂
- 拼音:   zhaotianang
- agent-id: <待填写>
- 注册日期: 2026-09-04
- 工作分支: zhaotianang1
- 角色:  **Main-B（中坚）**
- 任务线: TaskState CLI + 评测基建（R6）+ 多级摘要（R8）+ 语义检索 C4（R7）

## 工作内容（对齐 ROADMAP-NEXT §3 R 编号，2026-09-05 修订）

- U1 评测基建骨架先行（R6，无依赖）：`scripts/eval/` 目录 + run-eval/results schema 骨架 + T1-T5 fixture 占位。
- U2-U3 `TaskState` CLI（`/task status/risks/next/decide`，`src/cli/repl/commands/TaskCommand.ts`）——依赖王佐 U1-U2 的 taskState.ts（可先按 types.ts 契约 + stub store 开工）；随后继续 R6 fixture 实体化。
- U4 `compactService` 多级摘要 L1/L2（前置王浩宇 R3 Turn 结构化；generation/coveredTurnIds 沿用 v3 账本）。
- U5-U6 R7 语义检索 C4（`src/memory/embed.ts` n-gram v0，只跑 7B × T2/T3，正负结果都进 EVALUATION.md）；R6 真实 openPangu 跑分。
- U7 注入预算 + 资源消耗实测 + ARCHITECTURE.md §5 填表；U8 演示数据 + DEPLOY-CN.md + SUBMISSION.md 定稿。

## 接口协调

- 与王佐协调 TaskState（他落 taskState.ts 折叠/持久化，你落 CLI）。
- 与王浩宇协调 R3 Turn 结构化字段（L1 envelope 的输入）与 eval runner 接口。

## 备注

- ContextSnapshot 按任务落盘已由 Leader 提前落地（rollout `context` 事件，bf5f4a7）——不必重做。
- 分工矩阵见 `WORK-PLAN-2DAY-UNITS.md`；技术路线与 R 编号见 `docs/panshalach/ROADMAP-NEXT.md` §3。
