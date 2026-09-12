# PLAN-0.8 迭代设计：换地基（协议重构 + TurnController + 执行层强化）

> **执行状态：立项中**——M1 第 1 步（行为锁定测试 `tests/repl/turn/TurnBehavior.lock.test.ts`，455 行）已落地（commit df6e39f"步进调整"）；第 2 步四模块搬家（`src/cli/repl/turn/` 目录尚不存在）与 M1-PROTOCOL/M2 待执行。

> 依据：`docs/panshalach/GAP-MATRIX-0.8.md`（CC 15 维 × hermes 11 机制交叉对比）。
> 版本目标：v0.8.0。设计纪律：**换地基、保语义**——S 级架构重构与三态终止语义/意图分类/记忆二态/R6 评测契约互不侵犯。
> 交付约束：9/24 前完成本方案的 M1+M2（核心地基）；M3 为带宽余量。分支 `zhaiyuanhao1`，与 R6 评测域（`scripts/eval/`）零交集。

## 0. 为什么现在动（GAP-MATRIX 核心结论）

三方对比收敛出一个判断：**烛龙全部 S 级差距共享同一个根——上下文协议**。单 prompt 字符串拼接（`complete(prompt: string)` 单入口、`messages` 恒为单 user 消息、历史以 `[历史执行记录]` 文本回灌）锁死了 KV 前缀缓存、tool role 通道、跨任务连续会话、分段 prompt 缓存四条路；而 2115 行的 sseInteractive 巨函数与文本协议互为因果。hermes 第二轮调研同时给出三项不依赖架构重构的执行层增量（分段并行/卡死硬闸/结果落盘）。0.8 = **一次地基手术（M1）+ 一批执行层增量（M2）**，预期总改动 **~3000 行 src + ~1200 行测试**。

## 1. 硬边界（不可侵犯的既有语义）

1. **三态终止语义 + error**：`TurnStopReason`（completed/answered/max-steps/consecutive-failures/aborted/no-verification/error）语义不变——0.8 只换"轮次怎么发给模型"，不换"任务怎么结束"。
2. **意图分类与 prompt 分支**：chat 单次直答 / search 只读 ≤3 步 / execution 全循环 / `PANSHA_INTENT_GATE=0` 逃生门——0.8 让三条路走 messages 通道，但分类规则与行为不变。
3. **R6 评测契约**：`PANSHA_NO_MEMORY=1` 零注入（`PromptBuilder.ts:481`）、`injectedCardIds` 审计、A/B/C 消融口径——0.8 改完后 prompt-diff 展品脚本必须仍能产出 diff。
4. **记忆信号**：success 卡只认 `stopReason==='completed'`；`finalizeTaskMemory` 单一落定点。
5. **审批与安全**：三档审批 + 会话 allowlist + pathGuard 双重包含检查 + fileHistory 写前快照——0.8 新增并行执行时安全门禁**只能收紧不能放宽**。
6. **队友契约**：王佐 R4/R5（events/taskState）、王浩宇 R3（Turn.result 结构化）与 eval 域不动。

## 2. M1 —— 地基手术（S 级，两步串行）

### M1-TurnController：sseInteractive 拆分（先行，~600 行 src + ~400 行测试）

**现状**：`sseInteractive.ts` 2115 行，`startSseInteractive` 内嵌 20 个闭包函数共享巨状态（session/ctxUsedChars/ctxWindowTokens/bridge），`runTaskViaSse` 单函数 ~725 行。协议重构无处可落。

**目标结构**（新增 `src/cli/repl/turn/` 目录）：

```
src/cli/repl/turn/
  TurnContext.ts      — 巨状态显式化：{ session, ctxUsedChars, ctxWindowTokens,
                        bridge, lineUi, queue, ... } 单一可传递对象（约 80 行）
  TurnController.ts   — runTaskViaSse 主体迁出：任务提交/审批桥/事件渲染分发/
                        中断/排队 drain/turn 落盘（约 400 行，逻辑不动只搬家）
  TurnRenderer.ts     — mapSseToBridge + renderSseEvent + nextStepHint + banner
                        等纯渲染助手（约 350 行）
  CommandRouter.ts    — handleLocalCommand + 命令注册派发（约 200 行）
sseInteractive.ts     — 收缩为"会话壳"：启动/降级/ink UI/信号处理/接线（≤400 行）
```

**拆分纪律**：
- **测试先行**：先为 `runTaskViaSse` 的关键行为补集成级断言（turn 落盘形状/aborted partialText/answered 正文呈现/queue drain 中断），锁定现行为后再搬家；每搬一个模块跑全量。
- **零行为变更**：本步是纯机械搬家 + 状态显式化，diff 审查标准是"行为逐字节等价"。
- `buildQuickHelpLines`/`buildBanner`/`LINE_COMMANDS` 等已导出纯函数的导出面不变（测试在用）。

### M1-PROTOCOL：消息数组通道（~900 行 src + ~500 行测试）

**现状**：`ModelClient.complete(prompt: string)`（`types.ts:326`）；`openai-compatible.ts:243-253` messages 恒单 user；`VerifyCritiqueLoop.ts:609` buildHistoryPrompt 文本拼接；工具结果以文本 `Result: ...` 回灌。

**目标**（**加性接口，旧通道保留为降级路径**）：

```ts
// types.ts 新增（加性，不破坏 ModelClient 旧签名）
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role==='tool' 时：对应的工具调用 id（原生 FC 网关） */
  toolCallId?: string;
  name?: string;               // 工具名（文本协议网关的降级标注）
}
export interface ModelClient {
  complete(prompt: string, opts?: CompleteOptions): Promise<string | ModelClientOutput>;  // 保留
  /** 0.8 新通道：实现方支持 messages 时优先走此路径 */
  chat?(messages: ChatMessage[], opts?: CompleteOptions): Promise<string | ModelClientOutput>;
  streamChat?(prompt: string, opts?: CompleteOptions): AsyncIterable<ModelStreamChunk>;    // 保留
  streamChatMessages?(messages: ChatMessage[], opts?: CompleteOptions): AsyncIterable<ModelStreamChunk>; // 0.8 新
}
```

**关键设计裁决**：
1. **双通道而非替换**：`complete(prompt)` 保留——chat 意图直答、无 messages 能力的 provider（自定义网关/mock）走旧路；`openai-compatible` 实现 `chat()`，把 `messages` 原样进请求体（`{role, content}` 数组 + system 首位 + tool 结果按网关能力选 `role:'tool'` 或文本降级标注 `【工具 X 结果】`）。
2. **loop 内部双轨**：`VerifyCritiqueLoop` 新增 `this.messages: ChatMessage[]`——step 历史同时维护 messages 栈（system 段一次、每步 assistant(含工具调用) + tool 结果各一），`buildHistoryPrompt()` 文本版**保留**（`PANSHA_MESSAGES_MODE=off` 或 provider 无 chat() 时走旧路）。两条轨共享同一 `steps` 数据源，渲染函数分开。
3. **PromptBuilder 拆三段**（hermes 2.4 对齐）：`buildForTask` 拆出 `buildStableSegment()`（身份+L0+tier 契约+negative list——任务间不变）、`buildVolatileSegment()`（记忆卡+ENV+最近上下文+当前任务——每任务变）。messages 路径下 stable 段 = `role:'system'` 首消息（**任务间字节级相同 → 网关前缀缓存可命中**），volatile 段 = 首条 user 消息。
4. **跨任务连续会话（CC #2）最小版**：M1 先做"任务内 messages 栈"；跨任务（上一任务的 assistant 回合延续到下一任务）登记为 M3，因为跨任务 messages 的持久化形状需要与 rollout jsonl 账本对齐（王佐 R4 事件层），避免 0.8 与 R4 撞车。
5. **流式**：`streamChatMessages` 同构（SSE 读循环复用，仅请求体不同）。
6. **工具 schema 注入不变**：`CompleteOptions.tools` 透传逻辑原样搬到 chat()。

**测试**：
- messages 组装单测（system 首位/tool id 配对/文本降级标注）
- 双通道选择逻辑（provider 有 chat() → chat()；否则 complete()，行为等价）
- `PANSHA_MESSAGES_MODE=off` 回归 = 0.7.4 逐字节等价
- 三态终止语义全量回归（Termination/ErrorSemantics 等 716 例基线不动）
- prompt-diff 脚本在 messages 模式下仍可产出 A/B diff

## 3. M2 —— 执行层强化（hermes 高价值机制，可并行推进）

### M2-1 工具并行分段调度（~250 行 + ~150 测试）【hermes 2.1】
- `engineAdapter.execute(calls)` 改分段：连续 read/glob/grep 段并发（`Promise.all`），遇 write/edit/bash/MCP 进 barrier 串行段（barrier 原语 = 现有 `withWriteLock` promise 链）。
- 分段规则保守起步：**只读三件套并发，其余一律串行**；段间顺序执行、结果按原始顺序回填（LoopStep.verificationResult 顺序不变——三态语义无感）。
- 批次超时 420s（对齐 hermes 默认），超时按现 aborted/error 语义落。
- 事件：`onStep` 事件补 `parallel: { reads: n }` 字段（加性）。

### M2-2 卡死检测硬闸（~80 行 + ~100 测试）【hermes 2.2】
- 新增 `src/loop/guardrails.ts`：`ToolCallGuardrailController`——
  - `exactFailureBlockAfter=5`：同工具+同参数（JSON 序列化哈希）连续失败 5 次 → before_call 阻断并注入"该调用已连续失败 N 次，请改变方法或 end_turn"；
  - `sameToolFailureHaltAfter=8`：同工具失败 8 次 → 强制终局 `stopReason='consecutive-failures'`（复用现有终态，不加新枚举）；
  - `noProgressBlockAfter=5`：幂等工具（read/glob/grep）同参数同结果重复 5 次 → 同上阻断。
- 接入点：`VerifyCritiqueLoop` 执行前（解析后、execute 前），与现有 `maxConsecutiveFailures` 并行（互不替代）。
- 这是 0.6.5"伪工具调用 905s 空转"家族的最后一道栅栏：maxSteps 是钝刀，硬闸是精准止血。

### M2-3 工具结果落盘 + 回读（~200 行 + ~120 测试）【hermes 2.3】
- 现状：`TOOL_OUTPUT_CAP=20000` 尾截断，中段永久丢失。
- 改为三层：①工具内 cap 保留（20K）；②超 cap 时完整输出写 `<workspace>/.panshalach/scratch/tool-<seq>.txt`（pathGuard 约束内，会话 gitignore），上下文内替换为"头 1500 + 尾 500 + `<persisted-output path="...">` 预览"；③模型可用 read_file 按需回读（offset 续读已支持）。
- `read_file` 结果永不落盘（防落盘→再读→再落盘死循环，对齐 hermes PINNED_THRESHOLDS）。
- scratch 目录进 `.gitignore` + `/undo` 范围外（合成产物非工程变更）。

### M2-4 真实 usage 计量（~120 行 + ~80 测试）【CC #13】
- `openai-compatible` doComplete/streamChatMessages 解析 `json.usage.{prompt_tokens,completion_tokens,total_tokens}`（网关普遍返回；无则 null）。
- `CompleteOptions` 增加性 `onUsage?: (u: {prompt?: number; completion?: number}) => void`；loop 每步回调累计。
- `PanshalachChaser.estimatedUsedTokens` 优先真实 usage 累计，`len/4` 降级为 usage 缺失时的 fallback（预算百分比口径不变，`/usage` 显示"实测/估算"标记）。
- **R6 收益**：eval results schema 的 `prompt.estimatedTokens` 从此可填真值（schema 加性字段，不改既有字段语义——与王浩宇协调点）。

### M2-5 错误分类器 + overflow→auto-compact（~200 行 + ~120 测试）【hermes 2.6 + CC #15】
- `src/model/errorClassify.ts`：`classifyApiError(e) → 'rate_limit'|'server'|'timeout'|'context_overflow'|'auth'|'billing'|'network'|'unknown'`；auth/billing 类 `retryable=false` 快速失败（不再白吃 5 次退避）。
- `context_overflow` 判定：status 400 + body 含 `context length`/`maximum context`/`too many tokens` 类模式（多网关方言白名单）。
- 联动：loop 捕获 overflow → 触发 compactService auto-compact（现 `shouldAutoCompact` 阈值 0.85 之外的新触发源"强制档"）→ 压缩后重试本步（每任务最多 1 次，防循环）。
- 0.7.4 的 error 终态语义不变：overflow 重试仍失败 → 落 error。

### M2-6 敏感路径写保护（~40 行 + ~60 测试）【hermes 2.5a】
- `src/tools/sensitivePaths.ts`：`.ssh/**`、`.aws/**`、`.kube/**`、`.git-credentials`、`.netrc`、`id_rsa*`、`.env*`（工作区内相对路径匹配）。
- 接入 `engineAdapter` 写门禁：write/edit 对敏感路径**全档位拒绝**（readonly/default/full 一律拒，审批确认不可越过——比 hermes 更严，竞赛场景安全性优先）。
- `/undo` 对敏感路径的还原同样拒绝（防绕过）。

### M2-7 Turn.role 字段 + 会话角色标注（~100 行 + ~80 测试）【不对称压缩前置】
- `Turn` 加性 `role?: 'user' | 'assistant'`（现有 turns 迁移：task/multiline → user，其余按现状推断）。
- **本步只落字段与迁移**，不对称压缩本体（compactService 分区改造）留 R8——但字段就位后，`compactStrategies` 摘要 prompt 加"用户指令原文逐字保留"约束（~10 行）即可吃到 80% 收益。

## 4. M3 —— 带宽余量（按 9/24 时间盒动态取舍）

| 项 | 量级 | 取舍判据 |
|---|---|---|
| Plan mode ExitPlanMode 确认卡 + 计划评审往返 | ~250 行 | UI 层收益，与 R6 无关——评测后就绪则做 |
| MCP SSE/HTTP 传输 | ~350 行 | 竞赛演示用 stdio 已够；SSE 视演示需求 |
| Skills 渐进披露（按需加载）+ 自定义斜杠命令 | ~400 行 | 收益中等 |
| 跨任务连续 messages 会话（rollout 对齐） | ~400 行 | **需与王佐 R4 事件层联合设计**，0.9 候选 |
| @path 内容引用（@file 即注入内容块） | ~120 行 | 演示观感项 |
| Hooks 总线（PreToolUse/PostToolUse/Stop） | ~500 行 | 生态项，9/24 后 |

## 5. 实施顺序与并行切分

```
第 1 步  M1-TurnController 测试先行（行为锁定）          ── 串行，阻塞一切
第 2 步  M1-TurnController 搬家（四模块）               ── 串行
第 3 步  M1-PROTOCOL（chat()/streamChatMessages + loop 双轨
         + PromptBuilder 三段拆分）                     ── 串行（依赖第 2 步的落点）
   ║ 以下 M2 各项互相独立，第 3 步期间即可并行开工 ║
第 4 步  M2-1 并行分段 ∥ M2-2 硬闸 ∥ M2-3 落盘
         ∥ M2-4 usage ∥ M2-5 错误分类 ∥ M2-6 敏感路径 ∥ M2-7 role
第 5 步  回归门（§6）→ CHANGELOG/文档 → 合并窗口
```

- M2 各项与 M1-PROTOCOL 的文件交集只有 `engineAdapter.ts`（M2-1/M2-6）与 `VerifyCritiqueLoop.ts`（M2-2/M2-5）——**若并行则 M2-1/M2-2/M2-5/M2-6 串行化处理这两个文件，或以小步 rebase 消化**。
- 每步完成即跑全量（基线 716 例只增不减）。

## 6. 验收门（全部真实执行并记录）

1. `npx tsc --noEmit` EXIT=0。
2. 全量 `node --test --import tsx --test-concurrency=4` ≥ 716 + 新增（预估 +60~80 例）全绿。
3. `PANSHA_MESSAGES_MODE=off` 回归：`buildForTask` 产物与 0.7.4 **逐字节等价**（专门 diff 测试）。
4. `PANSHA_NO_MEMORY=1` 零注入契约不破坏（现有集成测试继续绿）。
5. 三态终止语义回归：Termination/ErrorSemantics/Resilience073/realEngineLoop 全绿。
6. `verify-panshalach-cleanup.mjs`（R6 continueCount 项除外）+ `check-protected-files.mjs` PASS。
7. prompt-diff 展品脚本在 messages 模式下可产出 A/B diff（R6 兼容证明）。
8. 真机复测（控制人）：`1`/`你好`/Ctrl+C/`hello.txt` 四路径 + 新增长任务（大 grep 输出 → 落盘回读可见）+ 并行读工具观感（同回合多 read 耗时下降）。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 拆分搬家引入行为漂移 | 测试先行锁定（第 1 步）；每模块搬家后全量回归；diff 审查"行为逐字节等价" |
| messages 通道被弱模型滥用（1B 不认 tool role） | 双通道降级：文本协议网关自动回落旧格式；`PANSHA_MESSAGES_MODE=off` 逃生门；三路解析器保留 |
| 并行读放大网关 429 | 分段并发上限起步=3（<hermes 的 8）；withRetry 已有退避；段超时 420s |
| 硬闸误伤合法重试 | 只在"同参数+失败"与"幂等同结果"两类确凿模式上触发；阈值 5/8 保守；阻断信息明确告知模型换方法 |
| 与 R6/王佐 R4 撞车 | eval 域零交集；跨任务 messages 推迟 M3 并标注 R4 联合设计 |
| 9/24 时间盒溢出 | M1+M2-2/M2-6 为最小不可分割集（地基+止血）；M2 其余按带宽裁剪；M3 全部可弃 |

## 8. 版本口径

- M1+M2 全量落地 → **v0.8.0**；仅 M1 落地 → v0.7.5（协议地基先行，执行层增量随后）。
- CHANGELOG 申报 REFACTOR-ASSESSMENT §4 ⑧（`Turn.role`/`ChatMessage`/`ModelClient.chat` 均为加性契约变更）。
