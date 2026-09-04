# Agent 注册卡 — wangzuo

- 控制人: 王祚
- 拼音:   wangzuo
- agent-id: <待填写>
- 注册日期: 2026-09-04
- 工作分支: feature/wangzuo
- 角色:  **Main-A（中坚）**
- 任务块: W3 — P3 事件记忆 + 任务状态机

## 工作内容

- `src/memory/events.ts`：`MemoryEvent` 接口 + `MemoryEventStore`（jsonl append/query）。
- `src/memory/taskState.ts`：`TaskState` 接口 + 持久化。
- `src/memory/eventExtractor.ts`：从 trajectory 抽事件。
- `src/cli/repl/FeatureTracker.ts`：演进（保留 `FeatureItem`，新增 `TaskState`）。
- `src/cli/repl/PromptBuilder.ts`：注入顺序 `TaskState → 卡 → Event → 当前任务`。
- 新增 CLI 命令 `/task status|risks|next|decide`（`src/cli/repl/commands/TaskCommand.ts`）。

## 备注

- 阶段交付见 `WORK-PLAN-MAIN-LEARN.md` §5.3
- 与王浩宇（W2）协调 `MemoryEventStore.append` 接受 `kind/topic/summary/refs/sessionId`（W1.1 接口契约 PR）
- 与翟源昊（W1）协调 `MemoryEvent` 注入 PromptBuilder 的预算/token 排序
