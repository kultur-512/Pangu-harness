# Agent 注册卡 — zhaotianang

- 控制人: 赵天昂
- 拼音:   zhaotianang
- agent-id: <待填写>
- 注册日期: 2026-09-04
- 工作分支: zhaotianang1
- 角色:  **Main-B（中坚）**
- 任务线: P0 ContextSnapshot + MemoryProjection + 多级摘要

## 工作内容（按 U1-U9 矩阵）

- U1 `TaskState` CLI 落地（`/task status/risk/decide`）。
- U2 `Assertion` schema（scope/confidence/validFrom/validUntil/evidenceEventIds/provenance）。
- U3 `MemoryProjection` 加载：`RefinedMemoryStore.loadFiltered` 改读 Projection 卡片，保留兼容 API。
- U4 `compactService` 三级摘要（以事件 + 状态为投影源）。
- U5 `tests/memory/Projection.test.ts` + `tests/repl/ContextSnapshot.test.ts` 绿。
- U6 M4 集成（ContextCompiler + ContextSnapshot 落盘）；U7 注入预算 + 资源消耗实测 + ARCHITECTURE.md §5 填表；U8 演示数据 + DEPLOY-CN.md + SUBMISSION.md。

## 接口协调

- 与翟苑皓（U1）协调 `Assertion` 类型定义。
- 与王浩宇（U1）协调 `ContextCompiler` / `ContextSnapshot` 的装配接口。
- 与王佐（U1）协调 TaskState 与 Projection 的派生关系。

## 备注

- 分工矩阵见 `WORK-PLAN-2DAY-UNITS.md`；技术路线见 `docs/panshalach/ROADMAP-NEXT.md` P0.3/P2/P3。
