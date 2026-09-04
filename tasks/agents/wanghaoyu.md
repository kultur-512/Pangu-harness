# Agent 注册卡 — wanghaoyu

- 控制人: 王浩宇
- 拼音:   wanghaoyu
- agent-id: <待填写>
- 注册日期: 2026-09-04
- 工作分支: feature/wanghaoyu
- 角色:  **Doer（实干）**
- 任务块: W2 — P2 记忆写入闭环 + markUsed + P6 eval runner 骨架

## 工作内容

- `src/memory/RefinedMemoryStore.ts`：新增 `markUsed`（注释兑现）。
- `src/PanshalachChaser.ts`：落定路径调 `refine({trajectory, taskStyle, attemptCount, userFeedback})` + `save(cards)`；返回 `refined: { added, merged }`。
- `src/cli/repl/PromptBuilder.ts`：注入前 markUsed。
- `src/server/runAgentTask.ts` + `src/cli/repl/sseInteractive.ts`：`done` 事件下发 `refined`。
- `scripts/eval/{run-eval,smoke-eval}.mjs` 骨架：A/B/C 三档 + T1-T5 task 注册表。
- m1-acceptance.mjs 升级到真 openPangu 路径。

## 备注

- 阶段交付见 `WORK-PLAN-MAIN-LEARN.md` §5.2
- 与翟源昊（W1）协调 `ModelClientOutput` 接口签名（W1.1 接口契约 PR）
