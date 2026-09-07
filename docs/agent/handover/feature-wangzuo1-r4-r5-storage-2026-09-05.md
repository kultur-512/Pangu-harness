# 交接声明 — R4/R5 存储层（wangzuo1 → 各分支）

- **日期**：2026-09-05
- **发起分支**：wangzuo1（王佐）
- **commit**：7b946f0（R4）/ c7a1eca（R5）/ 96b08d1（v0.6.5）
- **性质**：常规（新增模块；types.ts 加可选字段，向后兼容）

## 我暴露的接口（别人依赖）
- `src/memory/events.ts`（R4）：`MemoryEventStore`（new MemoryEventStore(sessionId)）——`query({taskId,kind,topic,sinceTs,untilTs,limit})` / `latest(n)` / `countByKind(kind)` / `activeTaskIds()` / `topicStats()` / `taskSummaries()`。只读、有界（MAX_QUERY_EVENTS=5000）、容错。在 rolloutStore `appendAgentEvent`/`readAgentEvents` 之上实现，**勿自行读写 JSONL**。
- `src/memory/taskState.ts`（R5）：`TaskStateStore`（new TaskStateStore(workspaceRoot)）——`get(taskId)` / `create(taskId, requirement)` / `update(taskId, fn, expectedVersion?)`（乐观锁）/ `applyEvents(taskId, events, expectedVersion?)`（幂等）；纯函数 `rebuildFromEvents(taskId, events)` / `foldEvent(state, event)`。`originalRequirement` 不可漂移（改则抛）；原子写盘（tmp→rename）；load 容错返回空。
- **types.ts**：`TaskState` 增可选 `foldedEventIds?: string[]`（幂等记账；旧数据无此字段亦兼容）。

## 依赖我的人需要知道
- 赵天昂 `/task` CLI：`TaskStateStore.load().tasks[taskId]` 即台账全量；展示"未完成/未知"由 CLI 侧判断（本层不含 UNKNOWN 态）。
- 任务落定接线（王浩宇 R1 / 王佐 U2）：产出 `AgentEvent` 用 `rolloutStore.appendAgentEvent`；事件查询用本层 MemoryEventStore；台账折叠用 `rebuildFromEvents` 或 `store.applyEvents`。

## 各分支需要做什么
- 无强制动作（纯新增 + 可选字段）。若 tsc 报 taskState/events 缺失，`git fetch origin` + rebase 到含 7b946f0 的分支即可。基准验证：`npx tsc --noEmit` EXIT=0 + 557 测试（556 pass + 1 skip）。

## 阻塞我
- 无。
