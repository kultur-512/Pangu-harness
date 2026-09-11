# 交接声明 — R4/R5 挂载收口（wangzuo1 → 各分支）

- **日期**：2026-09-09
- **发起分支**：wangzuo1（王佐）
- **commit**：见本批提交（0.7.5）
- **性质**：常规（加性：新增 CLI 子命令 + 新增方法；不改既有签名）

## 我暴露的接口（别人依赖）
- `src/cli/MemoryCommand.ts` → `runMemoryCommand(['events', ...], workspace)`：
  新增 `events` 子命令。参数 `--session <id> | --kind <k> | --task <id> | --topic <t> | --limit N | --stats`。
  **缺省 session = 最近一个 rollout 会话**（`listRecent(1)`）——评测/脚本场景请显式传 `--session`，避免取到无关会话。
  只读；空会话返回提示串（不抛）。
- `src/memory/taskState.ts` → `TaskStateStore.record*`（9/14 评审清单第 4 项 `TaskState.record*` 补齐）：
  - `recordDecision(taskId, what, why?, refs?)`
  - `recordRisk(taskId, risk, mitigation?)`
  - `recordOpenQuestion(taskId, question)`（status 恒 'open'）
  - `recordMilestone(taskId, title, done?, evidence?)`
  - `recordVerified(taskId, what, how?, command?, evidenceEventIds?)`
  - `setNextStep(taskId, nextStep)`（传空串 = 清空，不留过期值）
  - `setCurrentGoal(taskId, currentGoal)`
  - 全部返回更新后的 `TaskState`；**对不存在任务抛 `task not found`**；全部走 `update()` → version+1。
- `src/memory/events.ts` → `MemoryEventStore.listTopics(): string[]`：别名（= `topicStats().map(t => t.topic)`），
  对齐 9/14 清单签名 `MemoryEvent/listTopics`。

## 写路径纪律（与既有合同一致，勿违反）
- **用户/CLI 的显式语义** → 用 `record*`（或 `update()`）；**事件流折叠** → 用 `applyEvents()`。两者不混用。
- `record*` 不猜自然语言轨迹；`memory_injected` 不进 `STATE_KINDS`（TaskState = 控制面，注入层分离）。

## 依赖我的人需要知道
- 赵天昂 `/task` CLI：`record*` 可直接用于 `/task decide`（= `recordDecision`）/ `/task risks` 展示 / `/task next`（= `setNextStep`）；
  与先前 3.1 结论不冲突——`/task decide` 走 `update` 家族（`record*` 即其封装），不走 `applyEvents`。
- 王浩宇 R6 runner：`/memory events` 缺省 session 行为见上（评测传显式 `--session`）；`--stats` 可用于快速核对事件落盘。

## 各分支需要做什么
- 无强制动作（加性）。基准验证：`npx tsc --noEmit` EXIT=0 + `npm test` 758 例（757 pass + 1 skip）。

## 阻塞我
- 无。等 Leader B2 评审合入。
