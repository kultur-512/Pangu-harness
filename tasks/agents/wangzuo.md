# Agent 注册卡 — wangzuo

- 控制人: 王佐
- 拼音:   wangzuo
- agent-id: <待填写>
- 注册日期: 2026-09-04
- 工作分支: wangzuo1
- 角色:  **Main-A（中坚）**
- 任务线: R4 MemoryEventStore 查询层 + R5 TaskState（类型契约已由 Leader 定稿 types.ts）

## 工作内容（按 U1-U9 矩阵）

- U1 `MemoryEventStore` 查询层（`src/memory/events.ts`）：**schema 已由 Leader 落**（rolloutStore `agent` 事件 + `appendAgentEvent`/`readAgentEvents`，df7a119）——你做 kind/topic/session 查询（有界）。
- U1 `TaskState` 持久化 + `/task status|risks|next|decide` CLI。
- U2 事件写入点接线（R4）：**只允许显式写入点**（任务落定/审批/验证/用户声明）产 `AgentEvent`——按对抗评审裁决禁止 NLP 抽取 trajectory。
- U3 TaskState 注入 PromptBuilder（槽位：env/feature 之后、recent-context 之前——KV-cache 前缀稳定，勿重排既有块）。
- U4 `/task` CLI 集成 + `EventStore` 落盘验证；U5 `tests/memory/EventStore.test.ts` + `tests/repl/TaskState.test.ts` 绿。
- U6 集成验证（事件流落盘 + TaskState 注入 + refine 闭环串联）；U7 事件流人工验收 + replay 展示；U8 演示数据。

## 接口协调

- ~~与翟苑皓（U1）协调 `AgentEvent` / `TaskState` 类型~~ ✅ 已定稿（types.ts，df7a119）。
- 与赵天昂分工：你落 `taskState.ts` 折叠/持久化，他落 `/task` CLI（依赖你的 U1-U2 交付）。
- 与王浩宇（R1）协调任务落定 hook：refine 与 AgentEvent 写入同点串联。

## 备注

- 分工矩阵见 `WORK-PLAN-2DAY-UNITS.md`；技术路线见 `docs/panshalach/ROADMAP-NEXT.md` P0.1/P0.2。
