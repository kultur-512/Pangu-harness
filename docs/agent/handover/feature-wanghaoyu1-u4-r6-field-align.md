# 交接声明 — U4/R6 eval runner 字段收敛（run-eval ↔ RESULT_SCHEMA 对齐）

- **日期**：2026-09-07
- **发起分支**：wanghaoyu1（王浩宇）
- **性质**：常规（仅改 `scripts/eval/run-eval.mjs`，不碰 src/ 生产代码，向后兼容）

## 背景
U3 搭好的 R6 eval runner 骨架里，`runOne()` 返回的字段名是 runner 自造方言（`tier/model/timestamp`），与 `scripts/eval/results/schema.mjs` 的 `RESULT_SCHEMA`（`ablation/taskFamily/seed/startedAt/finishedAt`）对不上。导致真实结果通不过 `validateResult()`，注释里自己写了"U4/U6 字段收敛后再接入"。

本次 U4 收敛完成后，run-eval 产出的每条结果都过 `validateResult()`，schema 违规即不写盘 + exit 1。

## 我需要别人确认的接口（resolved: false）
- **TurnStopReason 双向同步**：`types.ts`（0.7 口径，含 `answered`、无 `verification-failed-continue`）与 `schema.mjs`（v3.1 口径，反之）已不一致。schema 注释 L11 写死"双向同步"，实际破了。
  - 提议：以 `types.ts` 0.7 口径为准，schema 侧把 `verification-failed-continue` 换成 `answered`。
  - 赵天昂 d3f8eb8 0.7.4 销项时可以顺手做，或者我下一批做。

## 我已经确认的接口（resolved: true）
- [x] 赵天昂: R6 schema 字段定义（`RESULT_SCHEMA` + `validateResult` + `newResult`）——消费侧对齐无冲突。
- [x] 翟苑皓: R1/R2 契约（`attemptCount` / `refined` 语义）——runner 侧预留字段 + 解析路径，等 harness 侧输出结构化事件后自动生效。

## 我暴露的接口（别人依赖）
- `runOne(fixture, ablation, opts)` 返回值形状：严格对齐 `RESULT_SCHEMA`。
  - 新增字段：`ablation`（替代 `tier`）、`modelId`（替代 `model`）、`taskFamily`、`seed`、`panshalachVersion`、`startedAt`、`finishedAt`、`stopReason`、`attemptCount`、`refined`、`tags`、`lastError`
  - `prompt.hash` 从 8 位截断改为 SHA-256 全 64 位（与 `hashPrompt()` 一致）
  - `artifacts` 字段从 `stdout/stderr/result` 改为 `rolloutJsonl/stdoutTail/traceJson`（对齐 schema 定义）
- `verdictToEvalVerdict(r)`：单 rollout TurnStopReason + tags → R6 评测结论（pass/fail/not_applicable/invalid）的映射函数。汇总统计用这个，不再直接读 r.verdict 当 pass/fail。
- `parseMemory(stdout)`：返回 `{ injectedCardIds, verifiedCardIds, refined }`。优先抓 `memory.finalized` JSON 事件，回退正则文本匹配。

## 阻塞我
- 无。U4 字段收敛已完成。
- 待办（U5+）：
  1. ✅ A 档消融定义修正（9/8：A → `injectMemory:false`（baseline no-memory），B → `injectMemory:true`（memory on），对齐 schema.mjs ABLATIONS 合同；line-defense-failed 判定同步修正为"memory-on 档零注入"）
  2. ✅ fixture × ablation 配对重构（9/8：每个任务跑全部 A/B/C/C4（或 `--tier` 过滤），`--tier` 语义从"过滤 fixture.tier"改为"过滤消融档位"）
  3. ⏳ `attemptCount` 真实值透传（等 harness 侧 headless 模式输出结构化事件）
  4. ✅ Repl/RunCommand 三口接线 finalizeTaskMemory（9/7 RunCommand 已改走 runAgentTask，吃到 finalizeTaskMemory + TaskState 折叠；仅剩 classic Repl.executeTask 直调 solveIssue）

## 各分支需要做什么
- 常规交接，无破坏性变更。
- zhaotianang1：如 d3f8eb8 合 develop，我这边 rebase 后不冲突（schema 只删了 continueCount，我没动那个字段——等等，d3f8eb8 删了 continueCount，runOne 里我也没加 continueCount，应该不冲突）。
- wangzuo1 / zhaiyuanhao1：无交集。

## 门槛复验
- `npx tsc --noEmit` EXIT=0
- `node scripts/eval/smoke-eval.mjs` → 20/20 PASS（A/B/C/C4 × T1-T5）
- `node scripts/eval/run-eval.mjs --mock` → 5/5 pass，0 schema 违规
- mock 结果文件 21 个顶层字段，与 RESULT_SCHEMA 定义完全对应
