
## 晚间批次（U1-Leader 提前开工）

### 想做什么（目的）
- 落 U1-Leader 任务：接口契约 v2 + tool_calls 透传 + 多模型源可用（模型接入 handover 迭代 1/2），为 4 主力并行解依赖。

### 打算怎么改（动作）
- 改：src/cli/repl/types.ts（接口契约 v2：AgentEvent/Assertion/TaskState/SourceRef + ModelStreamChunk 扩 toolCalls + ProviderConfig 扩 apiKeyCmd/headers）
- 改：src/model/openai-compatible.ts（P1.1 tool_calls 结构化返回 + SSE delta.tool_calls 拼装 + [DONE] break-outer 修复 + 自定义头）
- 改：src/PanshalachChaser.ts（流式 wrapper 聚合 toolCalls chunk → 结构化对象返回）
- 改：src/model/ProviderRegistry.ts（去 ScnetClient 死 import；apiKeyCmd execFileSync+缓存；headers 透传；_resolveApiKey）
- 改：src/cli/repl/ModelProvider.ts（P1.2：_applyEnvInjection 三件套泛化；SCNET_* 历史别名；_extractProviderKeyFromFile 扫全部 provider；getModelContextLength 跨 provider；裸名路由泛化；_createScnetClient→_createProviderClient）
- 改：src/cli/repl/rolloutStore.ts（schema 扩 'agent' 事件 + appendAgentEvent/readAgentEvents）
- 删：src/model/UniversalMaoyulinClient.ts、src/model/maoyulin-client.cjs、src/model/ScnetClient.ts、scripts/probe-scnet-real.mjs（含硬编码密钥，已提醒服务侧轮换）、scripts/probe-maoyulin-models.cjs
- 改：scripts/verify-scnet.mjs（改配置驱动任意 provider）；tests 'maoyulin' 字面量中性化
- 新增：tests/repl/ModelProviderEnv.test.ts、docs/panshalach/SUBMISSION.md（骨架）

### 实际干了什么（事实）
- npx tsc --noEmit → EXIT=0
- 定向测试：tests/model/* + ModelProviderEnv + ModelProvider + ModelCommandKeyLeak → 44/44 pass（含新 12 例）
- 发现并修复：streamChat [DONE] 早退跳过 tool_calls 拼装（break outer 修复，回归覆盖）

### 卡点 / 需要别人决定（接口争议）
- 王浩宇：ModelClientOutput 契约已落（types.ts:209 不变，toolCalls 元素为内部 ToolCall 形状），ContextCompiler 可开工
- 王佐：rolloutStore 已扩 'agent' 事件 + readAgentEvents，MemoryEventStore 直接在其上实现
- 赵天昂：Assertion/TaskState 类型已定稿（types.ts），/task 命令可引用

### TODO（明天 / 下一轮）
- [ ] 迭代 3（env 块 + /model list 通用化）排 U3-U4
- [ ] 上下文/记忆两方案对抗批判（进行中）

## 深夜批次（上下文/记忆 v3 迭代 + 模型接入 handover 迭代1/2）

### 想做什么（目的）
- 按两轮对抗批判收敛的综合方案 v3 迭代上下文/记忆系统；同时把模型接入 handover 的迭代 1/2 落码，解除王浩宇依赖。

### 打算怎么改（动作）
- 已完成（见上方"晚间批次"）：契约 v2 types/rolloutStore、tool_calls 透传、env 三件套、apiKeyCmd、死代码 5 文件、verify-scnet 配置驱动、SUBMISSION 骨架。
- 本批：衰减锚 max 修复、markInjected/markVerified 二态、archived 过滤、[M1] 编号、score=score 修复、compact generation/coveredTurnIds/summarySource/safe-merge + N1 血统拒绝 + N4 兜底账本、rollout compact/context 事件 + replay 消费、runAgentTask 注入审计接线、回归测试 12 条、EVALUATION/SUBMISSION 口径对齐。

### 实际干了什么（事实）
- 两轮 3 视角对抗批判（工程/架构/命题）共 6 份报告，NO-GO 4 条全部修复
- npx tsc --noEmit → EXIT=0；npm test → 529 例（528 pass + 1 skip + 0 fail）；verify-panshalach-cleanup PASS
- 修复既有 bug 3 个：compact apply 新增轮静默丢失（F5）、resume 丢压缩态（F6）、getRecentContext 双 score 前缀

### 卡点 / 需要别人决定（接口争议）
- 王浩宇：Turn.result 结构化最小集（半天）+ sseInteractive ctxUsedChars 累加一行修，请认领
- 王佐：T4 评分 rubric 一页 + TaskState 最小集（requirement/decisions/nextStep）
- kultur：probe-scnet-real.mjs 的密钥已随死代码删除，但 git 历史仍在，**服务侧轮换仍需处理**

### TODO（明天 / 下一轮）
- [ ] U4 前把评测防线（prompt-diff 展品脚本、T1 9-runs 设计、A 档窗口溢出设计）写进评测任务卡
