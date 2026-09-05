# Changelog

## 0.7.0 (终止语义重构：判官摘除 + 意图分类 + AbortSignal 贯穿)

产品主实测复现的系统性问题修复：简单输入（"1"/"你好，回答我你是谁"）被重复执行十几次、单任务跑 905s 不收敛；运行中 Ctrl+C 停不下来（网关侧仍持续 POST）；纯问答显示"任务未通过验证"且看不到模型答复。方案文档：`docs/panshalach/FIX-0.7-TERMINATION.md`。

**判官摘除（0.6.4 双层终止收缩为单层）**
- `continuationJudge.ts` 归档至 `archive/2026-09-05-removals/`（判官是唯一外层续跑源——`maxRollouts` 已全档为 1）；回合上界从 ~20 步×3 轮压回单次 `maxSteps`
- `TurnStopReason` 移除 `verification-failed-continue`；`Trajectory` 移除 `continueCount`
- **TestTimeOrchestrator 一并移除**（runMultiple 恒单次后 count/sort/预算裁剪全为死路径）：`Trajectory` 类型迁至 `src/loop/trajectory.ts`，chaser 单次直调 `loop.run()`，空批保护（合成失败轨迹 + lastError）并入 chaser

**回合三态（CC 式自然停即成功）**
- `answered`（新增）：end_turn 无工具调用且**有面向用户正文**（剥结构块后非空）→ `success=true`，UI 显示"已回复"并把模型正文呈现给用户（此前纯问答被标失败且答复被吞）
- `no-verification`：end_turn 但无正文无工具（空白/空转）→ 仍失败
- `completed`：轨迹含真实验证 PASS（保留）
- **记忆信号收紧**：`refine`/compact 补漏的 success 卡信号从 `trajectory.success` 改为 `stopReason==='completed'`——纯问答/闲聊不再产生 success 卡（UI 成功 ≠ 记忆成功）

**意图分类（`src/cli/taskIntent.ts`，纯函数）**
- 四类：`execution`（工程动词/工具/命令/@path）/ `search`（文件后缀无动词——**先只读搜索，搜不到询问用户具体用意**，≤3 步、强制 readonly、禁写禁 bash）/ `chat`（问候/自我询问——单次 complete 直接回答，不进 agent 循环、不灌格式教学与工具 schema）/ `meta`
- `PANSHA_INTENT_GATE=0` 逃生门（全量按 execution 兜底）
- Prompt 组装按意图分支：`StructuredReasoner.buildChatDirective`/`buildSearchDirective` 与执行路径的格式教学彻底分离——消除"对话不调工具"与"每步必须输出工具块"的指令冲突（弱模型伪工具调用空转的直接诱因）

**AbortSignal 贯穿（真正的 Ctrl+C）**
- `solveIssue → VerifyCritiqueLoop → modelClient.complete(opts.signal) → openai-compatible fetchWithTimeout（外部 signal 合并进内部 controller）/ streamChat 读循环（abort 即抛 TASK_ABORTED）→ engineAdapter/executor`
- `runAgentTask` 把 `ctx.signal` 透传给 solveIssue（此前只用于丢事件——signal 到 runAgentTask 边界就断了）；UI 层 abort 后**等待底层 settle**，不再"UI 返回但网关继续刷 POST"
- loop 每步开头 + 模型调用返回后检查 signal → `stopReason='aborted'`
- 已知边界：fetch 发出后 abort 中断的是读取/连接，网关侧生成可能仍在后台算完（无 stream 关闭语义时）；bash 子进程强杀待后续版本

**预算累计修复**
- `estimatedUsedTokens` 按每次模型调用累加（prompt+响应长度估算；此前声明后从未累加 → `[最终预算 0%]` 恒 0 误导）

**文档/测试**
- 新增 `docs/panshalach/FIX-0.7-TERMINATION.md`（方案）；`tests/loop/Termination.test.ts`（6 例：answered/no-verification/completed/max-steps/consecutive-failures/aborted）、`tests/cli/taskIntent.test.ts`（7 例）、`tests/tools/withWriteLock.test.ts`（写互斥从 orchestrator 测试迁出保留）
- 删除 `ContinuationJudge.test.ts`/`TwoLayerTermination.test.ts`/orchestration 两测试；记忆测试正向卡用例随信号源更新（`stopReason='completed'`）
- 验证（2026-09-05，Windows/Node 22）：`npx tsc --noEmit` 干净（EXIT=0）；`node --test --import tsx --test-concurrency=4`（显式 glob 全目录）**545 例：544 pass + 1 skip + 0 fail**；`node verify-panshalach-cleanup.mjs` **OVERALL CLEANUP STATUS (static checks): PASS**（收尾复验 2026-09-05：三项命令原样重跑，结果与上述一致）
- 待实测（用户侧，需真实端点；负责人：翟苑皓 F6）：REPL 输入 `1`/`你好，回答我你是谁` → 单次出正文；运行中 Ctrl+C → 任务真停、网关停 POST；`hello.txt` → 先只读搜索、搜不到询问具体用意

## 0.6.5 (部署落地：全局唤起 + 原生 function calling 请求侧 + 写工具全档位 + CC 风格提示词)

产品主"部署后无法唤起"排查引出的全链路修复（本地 LM Studio openPangu-Embedded 实测驱动）：

**部署与配置**
- **全局部署**：`npm link` 生成 zhulong/panshalach bin（此前从未安装；旧名 `zorge` 孤儿 junction 指向无关项目，已清理）
- **配置播种缺口**：`session.model` 此前只认 `PANSHA_MODEL` env，配置文件的 `model` 字段从未生效（不带 env 必报"未配置可用的模型客户端"）。新增 `modelSeed.ts`：`applyConfigModel` 在 env 缺席时从配置兜底播种，接入 runOneShot / startRepl / sseInteractive / classicRepl 全部入口
- **ConfigManager 加载顺序修正**：原实现用户级 `~/.panshalach/config.json` 覆盖项目级 `.panshalach.json`（与注释意图相反）→ 改为项目级覆盖用户级；用户级目录支持 `PANSHA_USER_CONFIG_DIR` 重定向（测试隔离）
- **审批通道**：`--approval <readonly|default|full>` flag 与 `PANSHA_APPROVAL` env——headless/一次性执行此前锁死 readonly，写文件必然被拒

**原生 function calling（P1.1 请求侧闭环）**
- `CompleteOptions.tools`（OpenAI function schema）→ openai-compatible 客户端 `stream:false/true` 两条请求路径透传 `tools + tool_choice:auto`；抓包代理实证 6 schema 随每次请求下发
- `EngineAdapter.toolSchemas()`：内置 6 工具 + MCP 的 schema 导出（参数键与各实现严格一致）；VerifyCritiqueLoop 真实引擎自动携带，mock/旧引擎不受影响
- 响应侧 `tool_calls` 透传此前已就绪（0.6.x），至此请求-响应闭环

**工具与提示词**
- **写工具全档位注册**（产品主裁决）：write_file/edit_file 不再限于 high+，quick/standard 同样注册；安全性由审批门禁 + RBW 兜底，不靠隐藏工具（实测：隐藏工具 + 教学示例含 write_file → UNKNOWN_TOOL 空转烧满步数）
- **格式教学具体化**：`buildToolCallFormatEnforcementPrompt(toolNames?)` 按实际可用工具动态生成 few-shot 示例（抽象 `paramName1` 模板对小模型无效，实测改进后模型产出标准 `<> <write_file>` 调用）；任何档位首轮必注入
- **身份提示 CC 化**（参考 claude-code-2.1.88 / harness-engineering 调研）：双职责定义（对话 vs 执行）+ 意图门槛（模糊输入先澄清不调工具）+ 歧义不往高风险方向解读 + 简洁回答风格；效果待 7B+ 模型验证（1B 分不清示例与指令）

**验证边界（如实记录）**：openpangu-embedded-1b-i1 的 chat template 不支持 tool use（`tool_choice:required` 亦无法诱导 tool_calls）；文本协议 + few-shot 下可完成简单写文件任务（hello.txt 实测落盘、RBW/UNKNOWN_TOOL 反馈回路工作），但成功率与示例遵循度受 1B 能力限制。端到端验收建议使用支持 tool use / 指令遵循更强的模型（openPangu 7B+）。

全套 545 例通过（另：node --test 全量高并发在 Windows 下有进程级崩溃假象，单文件或 `--test-concurrency=4` 均绿）。

## 0.6.4 (R0：双层终止语义 + 三先决修复)

产品主批准的 R0 落地（对抗清单 #1/#6/T-22 + 终止语义双层化）：
- **契约 v3.1**：`TurnStopReason`（completed / verification-failed-continue / max-steps / consecutive-failures / aborted / no-verification）；`Trajectory` 增 `stopReason/continueCount/lastError`
- **双层终止**：loop 层 end_turn（无工具调用）即自然停——PASS 字符串降级为 evidence（计入 trajectory.success 但不再直接终止）；`consecutive-failures`/`max-steps` 保留对应 stopReason。闲聊类任务 1 步即停（实测 nihao 40s→3s）
- **外置判官**：新增 `src/loop/continuationJudge.ts`（CC Stop-Hook 等价）——turn 结束时若未验证完成且轨迹出现过工具调用，注入"验证未通过：原因，继续"有界续跑（≤2 次）；纯文本回合不判官
- **#1 修复**：`withRetry`（429/5xx/网络错误，Retry-After 头优先，±25% jitter，≤3 次）+ `EMPTY_RESPONSE` 可重试（耗尽返回空）+ reasoning_content 兜底（openPangu-Embedded 实测偶发 200 空 content）+ orchestrator 空批合成失败轨迹（不再返回 undefined 导致 TypeError）
- **#6 修复**：count 翻倍——createOrUpdateCard/addRemember 改脱离缓存克隆（count 预解析）、createPositiveCard 同 id 预解析、mergeAndCap 同 id 整卡替换（R1 写闭环前置）
- **T-22 修复**：`ProviderRegistry.createClientSync` 透传 streamChat（生产不再恒非流式）
- **registry 模型名前缀剥离**：`createClientSync` 兜底取 `config.model` 时原样发送 `openpangu:xxx` 路由串 → 网关 400（本地 LM Studio 实测发现并修复）
- **reasoning_content 兜底**：非流式响应 content 空但 reasoning_content 非空时采用之（openPangu-Embedded 实测偶发 200 空 content）
- 新增测试 14 例（judge/双层终止/retry/空批/count 回归），全套 542 例

## 0.6.3 (score 字段整体移除：成败唯一由验证信号判定)

承接 0.6.1/0.6.2 的打分器归档，`score` 概念彻底退出：
- `Trajectory.score` → `Trajectory.success?`（验证信号标注）；orchestrator 排序/早停/预算裁剪改按 success；`setScore`→`setSuccess`
- `solveIssue` 返回值移除 `score`（REFACTOR-ASSESSMENT §4 禁区二次申报）；`RunResult`/result 事件/SSE `done` 事件/CLI 与 SSE 显示全部去 score
- `Turn.result.summary` 从 `score=NN` 改为验证结果短文本（"已通过验证"/"未通过验证"）
- 记忆正向信号：`refine()` 由 `score≥85` 改为 **trajectory.success（验证通过）或正向反馈**；`POSITIVE_SCORE_THRESHOLD` 删除
- compact 补漏：信号源从"summary 正则抽 score≥85"改为 **result.success**；success 卡 evidence 改为该轮任务摘要（修复零信息量卡 + 高分 hash 撞卡问题）
- 前端 demo 得分显示改验证状态；测试随语义更新（525 例全绿）

## 0.6.2 (性能叙事装置摘除：单 rollout、去 critique/静态分析/锚点/风格头/FailureMemory 轨道)

产品主裁决（2026-09-05，探测报告 7 项）落地，全部归档至 `archive/2026-09-05-removals/`：
- **#1 全单次**：`maxRollouts` 六档收敛为 1（max 3→1、ex 4→1、pangu 5→1），`parallelRollouts` 显示口径同步 1；chaser 移除显式并行
- **#2 critique 摘除**：VerifyCritiqueLoop 不再发起自我批判模型调用（打分器归档后其打分激励已消失）；`LoopStep.critique` 恒 undefined；`decideShouldCritique` 移除；`buildCritiquePrompt`/上下文装配保留为休眠代码；critique 事件不再发射；TierConfig 删除 `critiqueFrequency`
- **#3 任务前仓库扫描+锚点注入摘除**：RepoExplorer.explore / AnchorMemory / ContextManager 从 chaser 移除并归档（`RepoExplorer.archived.ts`/`ContextManager.archived.ts`）——"仓库我知道什么"由记忆注入承担
- **#4 静态分析预跑摘除**：chaser 不再起跑即执行 tsc/eslint（`/review` 命令与 Reviewer 本体保留）
- **#5 任务风格头摘除**：`getPromptHeader`/`getVerificationHint` 删除，`scoringHints` 死配置删除（BenchmarkProfiles 保留 get/verifyFirstBias 供档位判断）；StructuredReasoner/PromptBuilder 档位契约去 Critique 行
- **#6 FailureMemory 轨道摘除**：chaser/loop/engineAdapter 全链不再注入/记录；FailureMemory.ts 保留（UserConfirmation/MemoryCommand 兼容）；失败信号唯一归口 = RefinedMemoryStore.refine 任务落定提炼
- **#7 解析恒走三路**：`useUniversal` 恒真，OpenAI JSON/文本/`<>` XML 容错探测统一；strictStructured 仅影响 XML 探测深度；`StrictStructuredToolAdapter` 独占路径退场（类与测试保留）
- 测试：删除 2 个 critique 装配用例（随机制归档）、改写 UNKNOWN_TOOL 用例（引导保留、不记录）；527 例全绿

## 0.6.1 (打分器摘除归档：记忆主线去性能叙事残留)

- **归档** `TrajectoryScorer` 七因子过程纪律打分器 + Chaser 内联启发式评分（88/35+2N/格式/早过加分）→ `archive/2026-09-05-scoring/`（含恢复说明）
- `score` 语义收敛为验证锚定两值：成功=100 / 未成功=0；下游不变式全部保持：success 闸门（≥80）、记忆 success 卡阈值（≥85）、compact 补漏（正则 score 抽取）行为不变
- 顺带修复：旧failure 分 `max(30, 35+步数×2)` 使 ≥23 步失败轨迹也能过 80 闸门的潜在 bug
- orchestrator 早停（≥92）现于首个成功 rollout 即停（token 节省）；缺分兜底 0（不猜）
- 文档：ARCHITECTURE 执行链路描述、REFACTOR-ASSESSMENT §4 禁区注记同步

## 0.6.0 (全面改名：烛龙 Zhulong / 盤沙拉克 Panshalach)

### 模型接入：tool_calls 透传 + 多模型源（2026-09-04 df7a119）
- `openai-compatible.complete` 返回 `string | {content, raw, toolCalls, detectedFormat:'openai-json'}`；SSE `delta.tool_calls` 按 index 增量拼装（修复 `[DONE]` 早退跳过拼装）；支持 `providers.<name>.headers`
- chaser 流式 wrapper 聚合 toolCalls chunk 后返回结构化对象；`VerifyCritiqueLoop` 的 `preParsedToolCalls` 消费通道零改动
- env 三件套泛化 `PANSHA_<PROV>_API_KEY/_BASE_URL/_MODEL`（`SCNET_API_KEY/SCNET_KEY` 保留为 scnet 历史别名，行为不变）；`getModelContextLength` 跨 provider；裸名路由泛化
- 新增 `providers.<name>.apiKeyCmd`（借鉴 claude-code apiKeyHelper：stdout 首行作密钥，成功缓存，显式 apiKey 优先）
- 删除死代码：`ScnetClient.ts`/`UniversalMaoyulinClient.ts`/`maoyulin-client.cjs`/`probe-scnet-real.mjs`（内含硬编码密钥，git 历史仍在，**需服务侧轮换**）/`probe-maoyulin-models.cjs`；`verify-scnet.mjs` 改配置驱动任意 provider
- 接口契约 v2 类型：`AgentEvent`/`Assertion`/`TaskState`/`SourceRef`（`src/cli/repl/types.ts`）；rolloutStore 增 `agent` 事件 schema

### 记忆与上下文 v3（2026-09-04 bf5f4a7，两轮对抗批判收敛）
- 修复衰减锚：`calculateEffectiveWeight` 取 `max(lastSeen, lastUsedAt)`（旧 `??` 短路使复发卡的 lastSeen 刷新对衰减不可见）
- `markUsed` 二态化：`markInjected`（注入纯记账，不影响衰减/count）/ `markVerified`（原位刷新 lastUsedAt+count+1，直写持久化）；markCited 推迟（[M1] 卡号引用协议已就位）
- `loadFiltered` 过滤 `archived` 卡（merge 软删真正退出注入）
- PromptBuilder：记忆卡注入带 `[M1]` 连续编号（顺序==lastInjectedCardIds，跨 L1/溢出块单一序列）；修复 `getRecentContext` "score=score=NN" 双前缀
- compact：`CompactResult` 增 `generation(turnCount,lastTurnId)`/`coveredTurnIds`/`summarySource`/`syntheticTurn`；apply 按覆盖账本安全合并（修复快照→apply 间新增轮静默丢失）；血统断开（rewind）拒绝 apply；摘要来源显式化
- rolloutStore：新增 `compact`（自足标记，replayInto 消费后 resume 无模型重建压缩态）与 `context`（逐任务注入审计：promptHash/injectedCardIds）事件；`readAgentEvents`/`readContextSnapshots` 有界读取；`listRecent` 单文件扫描上限
- `runAgentTask`：逐任务 ContextSnapshot + `memory_injected` 事件 + markInjected 双账本对齐（best-effort）
- 新增测试：`tests/memory/MemoryMark.test.ts`、`tests/repl/ContextMemoryV3.test.ts`、`tests/repl/ModelProviderEnv.test.ts`（全套 529 例）

### 文档（2026-09-04 6b7cb5e）
- `docs/panshalach/SUBMISSION.md` 国创赛项目书骨架（≤1000 字概述占位 + 大纲 + 创新点按"claim 指向已落地工件"表述）
- `docs/panshalach/EVALUATION.md`：C 档口径对齐（语义检索单列 C4 消融档）；记忆卡利用率口径二选一写死；测试数以 `npm test` 实际值为准
- `tasks/context-memory-proposals-2026-09-04.md`：两方案 + 两轮 3 视角对抗批判 + 终稿裁决 + 已知遗留 + 评测防线留档

### 模型层去模型品牌特化（openPangu 泛化）
- `src/cli/repl/ModelProvider.ts`：删除 bare `glm`/`glm5` magic shorthand、`_pickBestGLMModel` 及 `listModels` 里 `glm` 伪入口；泛化为 `_pickBestProviderModel(providerName)`（取指定 provider 模型列表第一个可用）；`getEffectiveModel` 对 `provider:model` / `provider:` / 裸 provider 名做通用解析
- `src/cli/repl/commands/ModelCommand.ts`：description/usage/提示文案去旧品牌特化（保留 `/model list` 与 scnet 密钥引导，scnet 作为合法 OpenAI 兼容 provider）
- 测试与脚本：`tests/repl/*` 示例模型名改中性（`openPangu-7B` 等）；旧 brand 专属验证脚本删除；`scripts/sandbox-test-runner.ts` 等脚本旧品牌注释清理

### 命名体系（用户指示）
- **外部产品名**（用户/市场看到）：**烛龙**（Zhulong）—— CLI 启动、欢迎语、模型身份串、对外文档标题
- **内部项目代号**（代码/存储/包名/env）：**盤沙拉克**（Panshalach）—— package name、类名、存储目录、`.env` 前缀
- **最高档位**：原 `zorge` 档位 id 改名为 `pangu`（呼应 openPangu），旧值 `zorge` 保留为 alias（TIER_ALIASES 兼容既有会话/配置）

### 全面改名落地
- 类/文件：`src/ZorgeChaser.ts` → `src/PanshalachChaser.ts`；UI 组件 `ZorgeApp.tsx` → `PanshaApp.tsx`；`src/Glm53SweProChaser.ts` 兼容别名 stub（早期模型试点时期的遗留）同步指向 `PanshalachChaser`
- bin：`{ zhulong, panshalach, zorge }` 三个别名指向 `dist/cli.js`；外部默认走 `zhulong`，旧别名保留
- 存储：`.zorge.json`→`.panshalach.json`；`.zorge-memory.json`→`.panshalach-memory.json`；`~/.zorge/`→`~/.panshalach/`（含 sessions/rollouts/file-history/skills）
- env：`ZORGE_*`→`PANSHA_*`（含 `PANSHA_HEADLESS/PANSHA_MODEL/PANSHA_SERVE_TOKEN/PANSHA_CTX_WINDOW/PANSHA_EXEC/PANSHA_SMOKE/PANSHA_SKILLS_USER/PANSHA_USE_LEGACY_PARSER`）
- 题面渲染：welcome `Zhulong Interactive Shell（烛龙）` + 提示符 `Zhulong [tier]` + 身份串"你是烛龙（Zhulong）…" + SSE log `[zhulong]` + MemoryManager 标题

### 文档同步
- 根 README、CHANGELOG、REFACTOR-ASSESSMENT 重写为双名体系
- docs/panshalach/* 六份命题交付文档（README/ARCHITECTURE/MEMORY-DESIGN/EVALUATION/USER-GUIDE/ROADMAP）标题与品牌段对齐"烛龙（Zhulong）· 内部代号 Panshalach"
- 配置示例 `.panshalach.json.example` 命名/路径同步

### 迁移
- 写出 `scripts/migrate-panshalach.mjs`（一次性）：读旧 `.zorge.json`/`.zorge-memory.json`/`~/.zorge/{sessions,rollouts,file-history,skills}` → 写入新 `~/.panshalach/...`（仅当目标不存在，避免覆盖）
- 用户首次升级运行：`node scripts/migrate-panshalach.mjs`

### 说明
- 类名 `PanshalachChaser` / bin `panshalach` / `ZORGE_*`→`PANSHA_*` / `Zorge`→`Panshalach` 全部由批量脚本一次完成（见 scripts/rename-panshalach-bulk.mjs 留档，可作后续一致性核验脚本）
- 兼容别名：`zorge` bin 与 TIER_ALIASES `zorge→pangu` 保留；`Glm53SweProChaser` 兼容 stub 与 `scripts/test-glm-shorthand.mjs` 已删除。
- 命题提交物 1/2 见 docs/panshalach/ARCHITECTURE.md 与 EVALUATION.md。

## 0.5.0 (Panshalach 命题化重构)

### 品牌与命题定位
- 上一阶段：项目对外品牌 Panshalach（package name/bin `panshalach`；保留 `zorge` bin 与内部存储名作为兼容别名）
- 定位改为：基于 openPangu 的记忆增强长程上下文智能体（软件工程长期维护场景），贴华为 openPangu 命题
- 可见层文案更名：欢迎语/提示符/模型身份串（你是 Panshalach…）/SSE server 文案/memory 管理器标题/pangu 档位描述/`/init` 文档指针

### 文档重建
- 新增 [REFACTOR-ASSESSMENT.md](REFACTOR-ASSESSMENT.md)：现有代码逐模块对照 openPangu 命题的重构评估与 P1–P6 改造路径
- 新增 docs/panshalach/ 命题文档集：README / ARCHITECTURE（提交物 1 雏形）/ MEMORY-DESIGN / EVALUATION（提交物 2 骨架，待真实 openPangu 数据）/ USER-GUIDE / ROADMAP
- **物理清理**旧 Panshalach/早期模型试点/30-rounds 文档（docs/ 下全部规划/复盘/归档）与过时流程元数据（docs/agents、.agents）
- `.panshalach.json.example` 改为 openPangu provider 示例

### 说明
- 内部存储名 `.panshalach.json` / `.panshalach-memory.json` / `~/.panshalach/` / `PANSHA_*` / `PanshalachChaser` 本轮保留（会话资产兼容），收敛计划见 docs/panshalach/ROADMAP.md P6
- openPangu 记忆写闭环 / 事件记忆 / 任务状态机 / 语义检索 / 真机评测 为 P1–P7 后续里程碑（见 ROADMAP）

## 0.4.0 (dogfooding 战役)

### 新增
- --headless 逃生口（PANSHA_HEADLESS=1 / pangu --headless：非 TTY 真实执行，SMOKE 仍最高优先）
- maxHunks 参数（diff 工具：ctx 不计 + 全替换豁免）

### 修复
- computeLineDiff contextLines=0 泄漏折叠标记
- looksBinary off-by-one 边界（31 vs 32）
- stringWidth ZWSP/ZWNJ/word-joiner 宽度（1 → 0）

### 测试
- 二进制边界测试（0x1F/0x20、0x08/0x09）+ 回归守卫
- --headless 4 用例；基线 303 → 309

### 工程
- dogfooding 实战检验（T1-T7，8 条短板；报告已随旧文档清理归档，历史见 git）
- 杂项清理（.sandbox-test/、根目录 test-*.mjs、probe-*.cjs 移出追踪；probe 保留于 scripts/ 且密钥剥离）

### 修复（短木板 #9）
- 负向工具清单注入（`<negative_tool_list>`：iron_law_check/thinking/plan/critique 声明非工具）
- UNKNOWN_TOOL 运行时护栏（TOOL_FORMAT_ERROR 记账 + 意图引导 + 连续 3 次硬停）
