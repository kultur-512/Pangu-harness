# 0.7 终止语义重构 + 判官摘除 + 意图分类 + AbortSignal 贯穿（方案）

> 目标版本 **0.7.0** · 范围：修正"简单请求被重复十几次、905s 不收敛、Ctrl+C 停不下来、纯问答显示失败"的系统性问题。
> 状态：**已执行**（0.7.0，commit 106dae6；验收见 CHANGELOG「0.7.0」段——545 例 544+1skip+0 fail，2026-09-05）。下文"方案（planned）"为立项时点口径，保留作历史凭证。所有改动点均已对当时 HEAD `8fad5e8` 逐行核实。

---

## 1. 问题与根因（已核实，非推断）

用户在 0.6.5 交互 REPL 实测（2026-09-05）：输入 `1`、`你好，回答我你是谁` 任务被重复执行十几次不收敛；任务运行中按 Ctrl+C 无法中止，网关侧仍持续 POST 完整 prompt。

### R1. 循环缺少真正的终止判定
`src/loop/VerifyCritiqueLoop.ts:395-402`：仅当某一步 **未解析出任何工具调用** 才 `done=true`。只要弱模型把正文写成伪工具调用（实测出现 `read_file -path P:\MY_codes`、`edit_file -replace ...`），`UniversalToolCallAdapter` 的宽松解析（`src/adapter/UniversalToolCallAdapter.ts:205-244` loose-plain 分支把 `Read(...)`/`invoke tool ... with ...` 都算调用）就会得到 `toolCalls.length>0` → 永不自然停，直到 `maxSteps` 或连错保护。high 档 `maxSteps=20`（`src/tiers/TierConfig.ts:111-126`）。

### R2. 判官把失败回合续跑（唯一的外层续跑源）
`src/loop/continuationJudge.ts:39-74 runWithVerificationJudge`：对"出现过工具调用但未验证通过"的回合注入 `【验证未通过——继续任务】` 有界续跑 ≤2 次。每次续跑调用 `loop.run()` 都是新的一轮（`VerifyCritiqueLoop` 实例被复用、历史在 loop 内累积 → prompt 滚雪球）。最坏 **20 步 × 3 轮 ≈ 60 次**全量模型生成+执行。
`maxRollouts` 六档已全为 1（`TierConfig.ts`），判官是**唯一**外层续跑源——摘除它即可把上界压回单次 `maxSteps`。

### R3. prompt 自相矛盾，诱导弱模型产出伪工具调用
`src/reasoning/StructuredReasoner.ts:150-153` 身份块说"对话——直接简短回应，不调工具"，但 `buildToolCallFormatEnforcementPrompt`（`:305-329`）说"**每一步你必须输出恰好一个工具调用块……禁止只描述计划而不输出工具调用块**"，且 0.6.5 起**任何档位首轮必注入**（`PanshalachChaser.ts:176-181`、`VerifyCritiqueLoop.ts:248-250`）。两个指令对 1B 弱模型直接冲突 → 弱模型倾向输出伪调用而非 end_turn。工具 schema（`toolSchemas()`，`VerifyCritiqueLoop.ts:271-274`）也随每次请求下发，进一步把问答往"工具"引导。

### R4. Ctrl+C 没有真实中止（AbortSignal 在 runAgentTask 边界断裂）
- `src/server/runAgentTask.ts:134-141`：`ctx.signal?.aborted` 只在 `onStep` 里丢事件。
- `PanshalachChaser.solveIssue` 的 config（`src/PanshalachChaser.ts:85-93`）**不接收 signal**。
- `createEngineAdapter`（`PanshalachChaser.ts:298-308`）因此不传 `signal` → adapter `ctx.signal=undefined`（`src/tools/engineAdapter.ts:120-125`）→ executor 的 abort 监听（`src/tools/executor.ts:49-55`）永不触发；`bash.ts` 也只看自己的超时 timer。
- 最耗时的**模型 `complete()`/`streamChat()`** 完全无视外部 abort：`fetchWithTimeout`（`src/model/openai-compatible.ts:158-170`）只建内部 controller；`streamChat` 读循环（`:446-497`）无 abort 检查。
- UI 层 `Promise.race`（`src/cli/repl/sseInteractive.ts:704-707`；`src/cli/repl/Repl.ts:472`）只是**提前拿回提示符**，底层 `solveIssue` 仍在后台继续调模型跑完整循环 → 网关持续刷 POST（用户实测）。代码注释自述 "The engine cannot be hard-killed mid-step today"（`sseInteractive.ts:595`）。

### R5. `[最终预算 0%]` 恒 0（误导读数）
`estimatedUsedTokens` 声明后从未累加（`src/PanshalachChaser.ts:185-190`），`budgetReport`/`usageRatio`/softLimit 全空转；`Session.addTurn` 也按 0 累计（`src/cli/repl/Session.ts:46-48`）；`/usage` 与 TopBar 读数失真。

### R6. 纯问答被显示为失败
回合成功语义只认验证信号：`end_turn` 无工具 → `no-verification`（`src/cli/repl/types.ts:243`）；各调用方按 `result.success` 显示"未通过验证"（`RunCommand.ts:92/103`、`Repl.ts:483/494`、`runAgentTask` → `sseInteractive.ts:743/856/951`），用户看不到模型答复正文（模型回答被吞，只留一个失败标签）。

### R7. 记忆/compact 会把纯闲聊写成"成功卡"
`RefinedMemoryStore.refine` 正向卡以 `input.trajectory?.success === true` 为信号（`src/memory/RefinedMemoryStore.ts:130`）；`compactService` 补漏提炼按 `turn.result?.success === true` 过滤（`src/cli/repl/compactService.ts:123-129`）。若 R6 把纯文本答复判为成功（CC 式 natural-stop-is-success），这两处会为闲聊注入 success 卡 → **必须同步收紧信号源**。

---

## 2. 决策（用户已裁决）

| 项 | 裁决 | 落点 |
|---|---|---|
| 判官 | **一并完整清理** | continuationJudge.ts 归档 `archive/2026-09-05-removals/`；删测试；类型/文档同步 |
| TestTimeOrchestrator | **顺带移除**（runMultiple 已恒单次，count/sort/预算裁剪全死路径） | 单 rollout 直接 loop.run 一次；空批保护并入 chaser |
| end_turn 纯文本 | **CC 式自然停即成功**：有正文答复且无工具活动 → answered（计入成功） | 见 §4 三态 |
| 意图门槛 | **入口轻量意图分类** | 新增 `src/cli/taskIntent.ts` |
| 文件宾语"hello.txt" | **AI 先文件搜索；搜寻不到询问用户具体用意** | 新增 `search` 意图（受限只读搜索 + 找不到即问） |
| 对话路径注入 | **按意图分支注入**（问答不再灌格式教学/工具 schema） | PromptBuilder/StructuredReasoner 分支 |
| AbortSignal 贯穿 | **纳入本次** | §6 |
| 交付 | **文档先行 + 随后实现** | 本文档为方案；实现另起 |

---

## 3. 判官摘除 + Orchestrator 移除（波及面清单）

### 3.1 删除/归档
| 文件 | 动作 | 说明 |
|---|---|---|
| `src/loop/continuationJudge.ts` | → `archive/2026-09-05-removals/continuationJudge.ts`（头部保留"已摘除"说明） | 与既有 #1-#7 归档同目录 |
| `src/loop/ContinuationJudge.test.ts` | 删除 | 4 例随机制摘除 |
| `src/orchestration/TestTimeOrchestrator.ts` | → `archive/2026-09-05-removals/TestTimeOrchestrator.archived.ts` | `TrajectoryRecorder`/`runMultiple`/预算裁剪/空批合并全随档 |
| `tests/orchestration/EmptyBatch.test.ts` | 删除 | 空批保护语义并入 chaser（§3.3） |
| `tests/orchestration/TestTimeOrchestrator.test.ts` | 删除（并行/预算用例已无生产面）；`withWriteLock` 两例迁至 executor/engineAdapter 测试 | 守卫写互斥不丢 |

### 3.2 PanshalachChaser.solveIssue 收敛
- 删除 `runWithVerificationJudge` import 与包装（现 `src/PanshalachChaser.ts:13,322-330,352-353,379`）。
- 改为 **一次 `loop.run(basePrompt + tag)`**；`tag`（`[Rollout: rollout-0]` + 高强度格式提醒）保留，`rolloutId='rollout-0'` 固定（事件/AgentTree 仍按 id 路由）。
- `loop.run` 已返回 `{ success, steps, stopReason }`：
  - `traj.success = loopResult.success`
  - `traj.stopReason`：见 §4（completed / answered / max-steps / consecutive-failures / no-verification / aborted）
  - 删除 `continueCount` 写入与 `degradation` 事件（`verification-continue xN`）
- 空批保护：`loop.run` 直接 throw/异常时，chaser 捕获并产出 `syntheticFailure`（id `rollout-all-failed`、`success:false`、`lastError`），行为与旧 orchestrator 一致（不抛给上层）。
- `Trajectory` 类型：从 `orchestration/TestTimeOrchestrator.ts` 迁移到一个中性位置（建议 `src/loop/trajectory.ts` 或并入 `VerifyCritiqueLoop` 导出），字段保留 `id/steps/success/stopReason/lastError/isStrongTarget/taskStyle/estimatedUsedTokens`，**删除 `continueCount`**。
- `RefinedMemoryStore.ts:10` 改 import 新 Trajectory 位置（避免对 archive 的引用）。

### 3.3 调用点契约不变
`solveIssue` 的返回形状 `{ success, bestTrajectory, totalRollouts, budgetReport, tierConfig, message }` **保持不变**（调用方 RunCommand / SimulateCommand / Repl / runAgentTask 无需改签名）。仅 `result.success` 语义扩展（§4）。

### 3.4 保留不动（避免扩散）
- `AgentTree` / `/agents` / `rollout-*` 显示层事件路由保留（fixed rollout-0 即可；注释"high+ 并行"字样同步为"单 rollout"，`sseInteractive.ts:328`、`src/cli/repl/AgentTree.ts:4-7`、`commands/AgentsCommand.ts:68`）。
- `rolloutStore.ts`（会话事件账本）与 rollout 术语在此指**会话 JSONL**，与"Test-Time rollout"不同概念，不动。

### 3.5 文档同步
- `CHANGELOG.md` 0.6.4 段补注"判官机制已于 0.7 摘除（0.6.4 的双层终止收缩为单层）"；新增 0.7 段（§9）。
- `docs/panshalach/ROADMAP-NEXT.md:53`（R0 验收行）、`:25`"已摘除"清单追加判官与 TestTimeOrchestrator。
- `docs/agent/logs/zhaiyuanhao1/zhaiyuanhao1-2026-09-05.md:111-133`（R0 落地记录段）追加摘除说明。
- `docs/panshalach/ARCHITECTURE.md:41,44,125,163`、`docs/panshalach/README.md:27`：执行循环层描述去掉 TestTimeOrchestrator / 多 rollout / "early-stop 预算裁剪"，改为"单 loop.run + 终止语义"。

---

## 4. 回合结局三态（信号收敛核心）

`TurnStopReason`（`src/cli/repl/types.ts:237-243`）重定义（**移除 `verification-failed-continue`**）：

| stopReason | 语义 | success | UI 文案 | 记忆 refine 信号 |
|---|---|---|---|---|
| `completed` | 轨迹含**真实验证 PASS**（现存 `VerifyCritiqueLoop` 判定） | true | 已通过验证 | **喂 success 卡** |
| `answered`（**新增**） | end_turn（无工具调用）且**有面向用户正文答复** | true | 已回复 + 显示正文 | 不喂 success 卡 |
| `max-steps` | 步数耗尽 | false | 未通过验证 | — |
| `consecutive-failures` | 连错保护 | false | 未通过验证 | — |
| `no-verification` | end_turn 但**无正文无工具**（空白/空转） | false | 未通过验证 | — |
| `aborted` | 用户/信号中止 | false | 已中断 | — |

> 关键收紧：`refine` 正向信号 **不再用 `trajectory.success`**（那是"验证通过 OR answered"的并集），改用 **`stopReason === 'completed'`**。CC 语义下"自然停即成功"只体现在 **UI 与 turn 记录**层面（answered 显示已回复、可重放），**不进记忆成功卡**，避免纯闲聊污染记忆与 compact 补漏。

### 4.1 end_turn 判定"是否有面向用户正文"（实现要点）
在 `VerifyCritiqueLoop.run` 的 end_turn 分支（`:395-402`）需拿到该步模型输出中**剥离结构块后**的正文：
```
function hasUserFacingText(rawContent): boolean {
  // 剥掉 thinking/plan/verify/critique/format_check/iron_law_check 及工具块后 trim 非空
  const stripped = rawContent
    .replace(/<(thinking|plan|verify|critique|format_check|iron_law_check)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<>[\s\S]*?<\/>/gi, '')
    .trim();
  return stripped.length > 0;
}
```
- 判定为 answered 时 `stopReason = 'answered'`（否则保持 `no-verification`）。
- `success` 末尾计算改为三态：`PASS 出现过 → completed`；否则若有 answered 步 → answered；否则按 stopReason。

### 4.2 各消费点文案/字段同步（planned）
| 位置 | 现状 | 改后 |
|---|---|---|
| `Repl.ts:483` 显示 | `success ? 已通过验证 : 未通过验证` | 按 stopReason：completed→已通过验证；answered→已回复；aborted→已中断；其余→未通过验证 |
| `Repl.ts:494` turn summary | 同上 | 同步 |
| `RunCommand.ts:92/103` | 同上 | 同步 |
| `sseInteractive.ts:736-743,856,951-957` | `success ? 完成（已通过验证） : 任务未通过验证` | 同步；answered 显示"已回复"并把模型正文（结果文本）呈现给用户 |
| `runAgentTask.ts` | `success: !!result.success` + result 事件 | 透传 `stopReason`（result 事件负载加 `stopReason`） |
| `PromptBuilder.getRecentContext`（`:607-609`） | `✓/✗` | answered 用 `✓`（用户已获答复）但 summary 注明"已回复"，供记忆区分 |

---

## 5. 意图分类 + PromptBuilder 分支注入

### 5.1 新增 `src/cli/taskIntent.ts`（纯函数，无 IO）
```ts
export type TaskIntent = 'execution' | 'search' | 'chat' | 'meta';
export function classifyTaskIntent(input: string): TaskIntent
```
规则（先到先得，越靠前越强）：
1. **meta**：`run`/`simulate`/`r ` 前缀（REPL 已预处理）或 `PANSHA_INTENT_GATE=0`（逃生门，直接 execution 兜底）。
2. **execution**：命中任一强工程触发词/模式——
   - 明确命令/工具/构建/测试/修改：`read|write|edit|bash|run|git|npm|npx|tsc|node|python|pytest|构建|编译|测试|运行|修复|删除|创建|重构|重构`；含 `run `、含 `测试通过` 等；
   - 含绝对/相对路径且**带操作动词**（"改 `src/a.ts` 的 X"）；
   - 引用了**不存在的抽象**（如"把 X 修一下"且 X 在上下文是工程实体）——执行层按现逻辑处理。
3. **search**（用户裁决的新意图）：**无操作动词**但含**文件后缀/path token**的短输入，如 `hello.txt`、`src/foo.ts`、`那个配置在哪`。→ 走受限只读搜索（见 5.3）。
4. **chat**：问候/自我介绍/纯问句/情绪/无工程宾语（`1`、`你好`、`你是谁`、`回答我你是谁`、`谢谢`）。

单测计划：`tests/cli/taskIntent.test.ts`，覆盖上表 + 反例（`清理`不等于`删除`、`/usr/local/bin` 不触发 search、否定语境"不要读 file.txt"归 chat/search 需再判）。

### 5.2 PromptBuilder.buildForTask 按 intent 分支注入
`buildForTask(issue, opts?: { intent?: TaskIntent })`：
- **execution**：现状全部注入（tier 契约/铁律/格式教学/负向工具清单/记忆/项目验证块/工具 schema）。
- **chat**：**只注入** 身份 + 任务文本 + "简洁直接回答，不调用工具"指令。**不注入** L0 硬约束/tier XML/格式教学/负向清单/tools schema/记忆卡（避免把问答导向工具）。单次 complete 后直接返回 answered（见 5.4）。
- **search**：注入"先只读搜索（glob/read_file/grep）；**未找到文件则停止并询问用户具体用意**；禁止写/bash"。
- `meta`：不进 agent。

实现位置：`PromptBuilder.buildForTask` 前面按 intent 短路/追加不同块；`StructuredReasoner` 增一个 `buildChatDirective()`/`buildSearchDirective()`（现 `buildReasoningPrompt` 的 identity 保留）。测试：`tests/repl/PromptBuilder.test.ts` 增 chat/search 分支用例（chat 不含 `max_tool_calls_per_step` 与格式教学；search 含"未找到请询问"且不含 write 示例）。

### 5.3 search 的执行形态（受限 loop）
- 复用 VerifyCritiqueLoop，但 `maxSteps` 收紧（如 `min(3, tierMax)`），工具集只在**读侧**（`read_file/glob/grep` 注册；write/edit/bash 不注册或 approval 恒拒）。
- loop prompt 注入 5.2 search 指令：搜到 → 呈现结果并 end_turn（answered）；未搜到 → end_turn 带"未找到 <目标>，请告知具体用途"（answered）。
- **不写文件、不改文件、不猜意图**——符合用户裁决。

### 5.4 chat 单次路径（不进 loop）
在任务入口（RunCommand / Repl.executeTask / runAgentTask 共享路径，建议收敛到一个 `runTask` helper 或 chaser 内部分支）：
1. `classifyTaskIntent(input)`。
2. `chat` → 用 `PromptBuilder` chat prompt 直接 `client.complete` 一次；把正文作为 result 文本返回，`success=true`、`stopReason='answered'`、steps=[]（或单条 text step）。避免弱模型在工具 schema 下空转（R1 的伪工具路径整体绕开）。
3. `search`/`execution` → 进 loop（search 用受限 loop）。

> 注意：PromptBuilder 目前被 RunCommand/SimulateCommand/Repl/runAgentTask 各自 new 并调用（`buildForTask` 调用点见 §3.2 同表）。分支需在**共享 helper** 内做一次，避免四个入口各自复制判断——对应 ROADMAP-NEXT §3.1"R1 单一 finalizeTask 服务"同一纪律。

---

## 6. AbortSignal 贯穿（真正 Ctrl+C）

逐层改动（planned）：
| 层 | 现状 | 改动 |
|---|---|---|
| `sseInteractive.ts` `runTaskViaSse` | `controller.abort()` 后 Promise.race 提前返回，底层照跑（`sseInteractive.ts:595-599,704-707`） | abort 时除 race 外**真正取消底层**：把 `controller.signal` 传进 `runAgentTask`（已传，见 :657）并在 solveIssue 内生效；abort 后**等待**底层 promise settle（短暂窗口），期间 onEvent 静默丢弃 |
| `Repl.ts:executeTask` | 同上（:408-411 只 race） | 同步：abort 时 reject 并 `controller.abort()`；`currentAbort` 里对底层调用 `abortController.abort()` |
| `runAgentTask.ts` | `ctx.signal` 只喂 onEvent（:134-141） | **把 `signal` 透传给 `chaser.solveIssue` config** |
| `PanshalachChaser.solveIssue` | config 无 signal | 增 `signal?: AbortSignal`，下传 loop 与 `createEngineAdapter({ signal })`（adapter/executor 已支持，见下） |
| `VerifyCritiqueLoop.run` | `modelClient.complete(prompt, {tools?})`（:274）无 signal | 增 `signal` 到 options；模型调用带 `opts.signal`；每步开头与读流中检查 `signal.aborted` → `stopReason='aborted'` 并返回 |
| `openai-compatible.ts` `fetchWithTimeout`（:158-170） | 只建内部 controller | 支持外部 signal：合并——外部 abort 时 `controller.abort()`；外部已 abort 则立即 abort |
| `openai-compatible.ts` `streamChat`（:386-516） | 读循环无 abort 检查 | 循环内检查 `opts.signal?.aborted` → break 并抛 `TASK_ABORTED`（让上层 race/捕获真正中断） |
| `engineAdapter` | `createEngineAdapter({signal})` 由 chaser 建（:298-308）但没传 | chaser 把 `config.signal` 传进 `createEngineAdapter({ signal })` → `ctx.signal`（engineAdapter.ts:120-125）→ executor `withTimeout`（executor.ts:131）与 bash abort 生效 |
| `executor.ts` `withTimeout`（:41-66） | 已支持 signal | 无需改（信号到达即生效） |
| `bash.ts` | 只看 timeout timer | 可选增强：监听 `ctx.signal` abort → 同 timer 的 tree-kill 路径（本轮做最小：executor 层 abort 已能切走 in-flight，bash 子进程强杀并入 0.7.1 或本轮一并做，实现阶段定） |
| `agentServer.ts`（:176-191） | `req.on('close')→abortController.abort()` | 透传生效后自动受益（无需改） |

**残余风险（如实声明）**：fetch 已发出后 abort 只能中断读取/连接，服务端生成可能仍在进行（无 stream 关闭语义时网关侧可能继续算完）；`streamChat` 抛 `TASK_ABORTED` 由调用方捕获归为 aborted。bash 子进程在仅 executor 层 abort 时会返回 `✗ aborted`，但子进程本身可能仍在后台——若本轮不并入强杀，需在文档与 CHANGELOG 如实标注"bash 子进程强杀待 0.7.1"。

---

## 7. 预算真实累计（顺带修复 R5）

- `PanshalachChaser.solveIssue`：在每次模型调用后累加 `estimatedUsedTokens += estTokens(prompt) + estTokens(response)`（复用 `src/cli/repl/PromptBuilder.ts` 的 `estTokens`，抽到公共工具或就地实现；1B 网关通常无 usage 字段，用长度估算并标注"估算"）。
- 达到 tier 软限（`budgetTokens` 的 70%/90%）时触发既有 `softLimit`/`degradation` 事件与步数减半逻辑（现因恒 0 从未触发，`PanshalachChaser.ts:192-213,395-404` 已有骨架）——实现后 `[最终预算 X%]` 与 `/usage` 读数不再恒 0。
- `Session.addTurn`/compactService 已按 `budgetReport.estimatedUsedTokens` 累计（`Session.ts:46-48`），自动受益。

---

## 8. 测试计划（planned，实现阶段执行并记录真实输出）

**删除**：`tests/loop/ContinuationJudge.test.ts`（4 例）。
**改写**：
- `tests/loop/TwoLayerTermination.test.ts` → 更名/收敛为 `tests/loop/Termination.test.ts`：
  - end_turn 无工具**有正文** → `stopReason='answered'`、`success=true`（1 例，替换原 no-verification 断言）。
  - end_turn 无工具**无正文**（如只有 thinking 或空）→ `no-verification`、`success=false`。
  - PASS evidence + end_turn → `completed`（保留）。
  - 连错 / max-steps 用例保留。
- `tests/repl/ContextMemoryV3.test.ts` / `PromptBuilder.test.ts` / `compactService.test.ts` 中 `summary:'score=NN'` 语义字段不改（`summary` 仍是自由字符串，兼容），但 **refine 信号收紧后**需改 `RefinedMemoryStore.test.ts:218-222` 的正向卡用例：`trajectory.success=true` 不再等价于喂卡，改为 **`trajectory.stopReason==='completed'` 才喂**；`attemptCount===1 + 用户正向反馈` 仍喂（用户显式反馈不依赖验证）。
- `tests/repl/runAgentTaskSession.test.ts`：fake client 返回纯文本 → 断言 `stopReason` 语义/`result` 事件带 stopReason（如适用）。

**新增**：
- `tests/cli/taskIntent.test.ts`（execution/search/chat/meta 分类 + 逃生门 + 反例）。
- `tests/loop/Termination.test.ts` 的 answered/no-verification 边界。
- `tests/model/openai-compatible.abort.test.ts`：外部 signal abort 传播（fetch 层 + streamChat 层，用本地可控假服务）。
- chaser 级：判官摘除后**单次调用**断言（loop.run 只被调一次）；chat 单次路径 returns answered。
- memory/compact：answered（非 completed）turn **不产生** success 卡（refine 信号 + compact 补漏各一例）。

**验证命令（实现阶段执行，结果原样记录，禁止预填 PASS）**：
- `npx tsc --noEmit`
- `node --test --test-concurrency=1`（Windows 高并发偶发进程级崩溃假象——沿用 0.6.5 CHANGELOG 备注，单文件可复跑）
- 真实 REPL 手测（用户执行）：`1`、`你好，回答我你是谁` → 单次/极少次出正文并显示；运行中 Ctrl+C → 任务真正停（网关不再刷 POST）；`hello.txt` → 先搜索、搜不到询问；执行类任务（写文件/跑测试）仍走完整验证闭环。

---

## 9. CHANGELOG 0.7.0 段（草稿，实现时按真实结果回填）

```
## 0.7.0（终止语义重构：判官摘除 + 意图分类 + AbortSignal 贯穿）

**问题（实测复现）**：简单输入（"1"/"你好"）被重复执行十几次不收敛；Ctrl+C 停不下来；纯问答显示失败。

- 判官摘除（0.6.4 双层终止收缩为单层）：continuationJudge.ts 归档 archive/2026-09-05-removals/；
  TurnStopReason 移除 verification-failed-continue；Trajectory 移除 continueCount；回合上界从 ~20 步×3 轮压回单次 maxSteps
- TestTimeOrchestrator 移除（runMultiple 已恒单次）：单 rollout 直接 loop.run；空批保护并入 chaser
- 回合三态：completed（真实验证 PASS）/ answered（end_turn 有正文答复，计入成功并显示正文）/ failed 系（max-steps/consecutive-failures/no-verification/aborted）
- 记忆信号收紧：refine/compact 成功卡信号从 trajectory.success 改为 stopReason==='completed'——纯问答/闲聊不再产生 success 卡
- 意图分类（src/cli/taskIntent.ts）：execution / search（文件宾语→先搜索搜不到询问）/ chat（单次回答不走 agent 循环）/ meta；PromptBuilder 按意图分支注入（chat 不灌格式教学与工具 schema）
- AbortSignal 贯穿：solveIssue→loop→modelClient(complete/streamChat)→engineAdapter/executor；Ctrl+C 现在真正中止任务并停网关请求
- 预算累计修复：estimatedUsedTokens 按每次模型调用累加（此前恒 0 → [最终预算 0%] 误导）
- 验证：<实现后回填真实命令输出，标 measured/planned>
```

---

## 10. 关键文件改动清单（实现顺序建议）

1. 类型层：`types.ts` TurnStopReason + Trajectory 迁移（新增 `src/loop/trajectory.ts`）。
2. loop 层：`VerifyCritiqueLoop.ts`（answered/no-verification 判定、signal）。
3. chaser 层：`PanshalachChaser.ts`（去判官/去 orchestrator、空批保护、预算累计、signal 透传、intent 路由）。
4. intent 层：新增 `src/cli/taskIntent.ts`；`PromptBuilder.ts` + `StructuredReasoner.ts` 分支。
5. 工具/模型：`engineAdapter.ts`（signal）、`executor.ts`（如需）、`bash.ts`（可选强杀）、`openai-compatible.ts`（外部 signal 合并 + streamChat abort）。
6. 服务/UI：`runAgentTask.ts`（signal + stopReason 透传）、`Repl.ts`、`RunCommand.ts`、`SimulateCommand.ts`（intent/文案）、`sseInteractive.ts`（UI 文案 + 显示正文）。
7. 记忆/compact：`RefinedMemoryStore.ts`（信号改 `stopReason==='completed'`）、`compactService.ts:123-129`（同收紧）。
8. 测试 + 归档 + CHANGELOG/ROADMAP/ARCHITECTURE/日志同步。

**实现中禁止把未执行的验证写成 PASS**；每完成一层跑 `npx tsc --noEmit` + 相关单测并原样记录。
