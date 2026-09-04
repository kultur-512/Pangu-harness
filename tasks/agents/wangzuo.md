# Agent 注册卡 — wangzuo

- 控制人: 王佐
- 拼音:   wangzuo
- agent-id: <待填写>
- 注册日期: 2026-09-04
- 工作分支: wangzuo1
- 角色:  **Main-A（中坚）**
- 任务线: P0 AgentEvent + TaskState + 状态机

## 工作内容（按 U1-U9 矩阵）

- U1 `MemoryEventStore`：在现有 rolloutStore JSONL 之上扩展 schema（追加 `taskId / kind / refs`）。
- U1 `TaskState` 持久化 + `/task status|risks|next|decide` CLI。
- U2 `EventExtractor`：trajectory → 增量 `AgentEvent`，保留原始轨迹。
- U3 TaskState 注入 PromptBuilder L1：`[原始需求] → [记忆卡] → [事件摘要] → [当前任务]`。
- U4 `/task` CLI 集成 + `EventStore` 落盘验证；U5 `tests/memory/EventStore.test.ts` + `tests/repl/TaskState.test.ts` 绿。
- U6 M3 集成（trajectory → AgentEvent → Projection 落盘）；U7 事件流人工验收；U8 演示数据。

## 接口协调

- 与翟苑皓（U1）协调 `AgentEvent` / `TaskState` 类型定义。
- 与王浩宇（U1）协调 `MemoryEventStore` schema。
- 与赵天昂（U1）协调 `Assertion` 与 TaskState 的 evidenceEventIds 关联。

## 备注

- 分工矩阵见 `WORK-PLAN-2DAY-UNITS.md`；技术路线见 `docs/panshalach/ROADMAP-NEXT.md` P0.1/P0.2。
