# 烛龙 × Claude Code × hermes 交叉对比矩阵（GAP-MATRIX · 2026-09-06，面向 0.8 立项）

> 性质：三方交叉对比调研 + 0.8 迭代设计输入。**纯调研**，本文档不宣告任何代码已改。
> 参照系：Claude Code（CC）2.x 公开可观察行为与架构惯例；hermes-agent（NousResearch，Python，v0.19.0，PyPI wheel 直读）。
> 本仓库基线：v0.7.4（HEAD=1c36a00），src 113 文件 / 21242 行，tests 85 文件（基线 716 例全绿）。
> 证据口径：本地 `file:line` 均来自真实读码；hermes `file:line` 来自 PyPI wheel 解包实读；CC 侧为公开行为对照（无源码行号）。
> 关联文档：`HERMES-ALIGN-0.7.4.md`（上下文管理五项已判定）、`ALIGNMENT-REVIEW-0.7.3.md`（五报告共识：三大 L 级结构性差距）、`UI-UX-REVAMP-0.7.1.md`（UI 层已对齐，不再重复）。

## 0. 级别定义

| 级别 | 含义 | 判定标准 |
|---|---|---|
| **S** | 分水岭级 | 决定 agent 能力上限的架构差距——不补齐，其它优化存在天花板 |
| **A** | 显著能力差距 | 真实影响任务吞吐/可靠性/成本 |
| **B** | 工程质量差距 | 机制已有雏形，成熟度/覆盖面不足 |
| **C** | 打磨差距 | 补齐收益局部、不改变能力面 |

---

## 1. CC 15 维度对比（烛龙现状 vs CC）

### 1.1 上下文协议 【S】
- **烛龙**：`src/model/openai-compatible.ts:243-253` `complete(prompt: string)` 单入口，`messages` 恒为 `[{role:'user', content: prompt}]`；`src/loop/VerifyCritiqueLoop.ts:224` 历史以文本 `[历史执行记录]` 拼接（`buildHistoryPrompt` :609-676）；无 `system` role 通道（身份行拼进 user 正文，`PromptBuilder.ts:215`）；无 prompt caching（全仓无 cache_control）；工具结果以文本历史回传（:653 `Result: ...`）。
- **CC**：`messages[]` 数组 + `system` role + `tool_result` blocks + prompt caching（KV 前缀缓存）。
- **差距实质**：每轮重拼整段文本、无结构化会话栈 → 无 KV 缓存收益、无分角色通道。**一切上层优化的地基**。

### 1.2 多轮会话内 agent 循环 【S】
- **烛龙**：每任务独立 loop（`PanshalachChaser.ts:372` 每次 `new VerifyCritiqueLoop`；`runAgentTask.ts:105` 每任务 new chaser）；跨任务靠 `PromptBuilder.ts:383` `getRecentContext(3)` 文本注入最近 3 轮摘要。
- **CC**：同一 `messages[]` 连续 append 跨任务，天然携带完整上下文。
- **差距实质**：任务与任务之间是"摘要接力"，不是"同一对话的延续"。

### 1.3 Subagent / Task 工具 【S】
- **烛龙**：全仓 grep 零命中（`AgentTree.ts` 只是 rollout 树渲染，`AgentsCommand.ts:68` 自述"当前引擎无并行"）。
- **CC**：Task tool + 并行 subagent + Explore/Plan agent 类型。
- **差距实质**：任务可分解规模 = 1；无并行探索能力。

### 1.4 Hooks 总线 【S】
- **烛龙**：grep 零命中（无 PreToolUse/PostToolUse/Stop 生命周期钩子）。
- **CC**：PreToolUse/PostToolUse/Stop/Notification 钩子可拦截/改写/阻断。
- **差距实质**：策略注入、工具级拦截、生态定制能力为零。

### 1.5 后台任务 / 并行工具执行 【A】
- **烛龙**：`engineAdapter.ts:581-583` 同回合多工具 `for...of` 逐个 await（串行）；`withWriteLock`（:33-40）只串行 write/edit；`bash.ts` spawn 同步等待 close、无后台 shell。
- **CC**：后台 shell + 同回合并行工具调用 + 并行 subagent。

### 1.6 Plan mode 【B】
- **烛龙**：`ModeRing.ts` plan 为四态环之一；`engineAdapter.ts:426-434` plan 时写/bash 拒绝；`PromptBuilder.ts:280-286` 注入 `<plan_mode>`；`ModeRing.ts:6-7` 自注"无 ExitPlanMode 确认卡——documented CC difference"。
- **CC**：只读探索 → 产出计划 → ExitPlanMode 确认卡 → 执行。

### 1.7 检查点/回滚粒度 【B】
- **烛龙**：`fileHistory.ts:83-110` 每次写前快照；`/undo` 单文件（`latestCheckpoint`）；`/rewind` 按回合（`rewindToTurn`）；bash 副作用明确排除。
- **CC**：/rewind 回合级 + 会话联动；覆盖更广。

### 1.8 上下文压缩 【B】
- **烛龙**：`compactService.ts:19-20` `KEEP_RECENT=6` 单次 batch 摘要；`shouldAutoCompact`（:193-195）ctxRatio≥0.85 且 turns>12；血统账本 generation/coveredTurnIds 已有；无不对称保留（用户原文同池被摘要）。
- **CC**：rolling 微压缩 + 阈值触发 + 不对称保留（用户原文/固定头永不摘要）。
- **衔接**：与 HERMES-ALIGN §2 结论一致——不对称保留是唯一有真实语义价值的一项，需 Turn 角色字段为前置。

### 1.9 @path 文件引用协议 【C】
- **烛龙**：`types.ts:416-461` `expandAtPaths` 只做路径解析 + workspace 前缀检查 + 展开提示，**不读文件内容注入**。
- **CC**：@file 即把文件内容作为上下文块引用进对话。

### 1.10 MCP 支持 【B】
- **烛龙**：`mcpClient.ts` 手写 JSON-RPC stdio 客户端（30s 超时、MCP_SERVER_DOWN 暴露）；`mcp_<server>_<tool>` 命名空间进审批门禁；仅 stdio 传输、配置仅 command/args/env 三字段。
- **CC**：stdio + SSE/HTTP 多传输、生态丰富。

### 1.11 Skills / 自定义命令 【B】
- **烛龙**：`skillsLoader.ts` 目录约定 + frontmatter + trigger 命中 + 最多注入 3 个（`PromptBuilder.ts:309-325`）；无自定义斜杠命令体系；技能整篇注入（非渐进披露）。

### 1.12 输出样式/流式 【B】
- **烛龙**：`streamChat`（`openai-compatible.ts:441-596`）SSE token 级 thinking/text/toolCalls 齐全；chaser 转发 `thinking.delta/message.delta`（`PanshalachChaser.ts:294-330`）；**工具输出不流式**（执行完一次性回传）。

### 1.13 Token 计量与成本 【A】
- **烛龙**：`PanshalachChaser.ts:386-387` `Math.ceil(len/4)` 字符估算；**网关返回的 `usage` 字段完全未解析**（openai-compatible.ts grep 零命中）；CJK 场景 len/4 系统性偏低。
- **CC**：真实 `usage.prompt_tokens/completion_tokens` 消费 + 成本展示。

### 1.14 项目记忆注入（CLAUDE.md 类） 【C】
- **烛龙**：`projectInstructions.ts:20-65` 只读 `.panshalach/AGENTS.md` 的"验证命令"一节（MAX_BLOCK_CHARS=1200）；无分层加载。
- **CC**：CLAUDE.md 用户/项目/子目录三级分层加载。

### 1.15 错误恢复/自愈架构 【A】
- **烛龙**：`withRetry` 5 次指数退避 + Retry-After + jitter（`openai-compatible.ts:130-176`）已扎实；truncated 禁判 answered + 精简提示续跑（0.7.3）；工具错误回灌 ✓（verificationResult 进 history，步骤级文本回灌）。**缺**：API 溢出→自动 compact 联动；无错误分类分层（auth/billing 类快速失败 vs 瞬态重试）。
- **CC**：API retry + overflow 自动 compact + 错误回灌自愈全链。

### 1.16 汇总表

| # | 维度 | 级别 | 一句话差距 | 补齐量级 |
|---|---|---|---|---|
| 1 | 上下文协议 | **S** | 单 prompt 字符串 vs messages 数组 + system/tool role + KV 缓存 | ~800-1500 行（协议重构 + 全调用点） |
| 2 | 多轮会话循环 | **S** | 任务间摘要接力 vs 同一数组连续 append | ~300-600（随 #1 摊销） |
| 3 | Subagent/Task | **S** | 完全无 | ~1500+（新工具+调度+渲染） |
| 4 | Hooks 总线 | **S** | 无生命周期钩子 | ~400-800 |
| 5 | 后台/并行工具 | **A** | 同回合多工具全串行、无后台 shell | ~200-400 |
| 13 | Token 计量 | **A** | len/4 估算、usage 字段未解析 | ~100-200 |
| 15 | 错误恢复 | **A** | 缺溢出→自动 compact 联动 + 错误分类分层 | ~150-300 |
| 6 | Plan mode | B | 缺 ExitPlanMode 确认卡与计划评审往返 | ~150-300 |
| 7 | 检查点/回滚 | B | /undo 单文件、/rewind 回合已完备；缺 bash 副作用 | ~100-200 |
| 8 | 上下文压缩 | B | 单次 batch vs rolling + 不对称保留 | ~200-400（前置 Turn.role） |
| 10 | MCP | B | 有 stdio，缺 SSE/HTTP 传输 | ~300-500 |
| 11 | Skills/命令 | B | 无自定义斜杠命令、无渐进披露 | ~300-500 |
| 12 | 输出流式 | B | 工具输出不流式 | ~150-250 |
| 9 | @path 引用 | C | 只校验路径不读内容 | ~100-150 |
| 14 | 项目记忆分层 | C | 只读 AGENTS.md 一节 | ~100-200 |

---

## 2. hermes 执行层机制对照（HERMES-ALIGN 五项之外的第二轮）

> 信息源：PyPI wheel `hermes-agent==0.19.0`（pip download 实拉解包，`agent/` + `tools/` 全量读码）。

### 2.1 工具并行：线程池 + 分段调度 【移植价值：高】
- **hermes**：`agent/tool_executor.py:327` `execute_tool_calls_concurrent`——DaemonThreadPoolExecutor，`_MAX_TOOL_WORKERS=8`（:73），批次超时 420s（:76）；**分段调度** `execute_tool_calls_segmented`（:1742）把混合批次切成"parallel-safe 连续段 + barrier 串行段"：只读/无交叠路径写并发，写与有交叠的段顺序执行，结果按原始顺序回填。
- **烛龙**：`engineAdapter.ts:528-583` `for...of` 全串行；`withWriteLock`（:33-40）进程级写互斥 promise 链已就位——**恰好是分段调度的 barrier 原语**。
- **移植性**：直接移植（改造成本中等）。读并发 + 写 barrier，零架构增量。

### 2.2 循环卡死检测：重复失败/无进展硬闸 【移植价值：高】
- **hermes**：`agent/tool_guardrails.py` `ToolCallGuardrailController`——`exact_failure_block_after=5`（同参数完全相同调用连续失败 5 次阻断）、`same_tool_failure_halt_after=8`（同工具失败 8 次停）、`no_progress_block_after=5`（幂等工具同结果重复=无进展）（:64-83），`before_call` 阻断而非事后掐。
- **烛龙**：只有 `maxConsecutiveFailures`（按信号 FAIL/ERROR 计数，`VerifyCritiqueLoop.ts:527-532`）+ `unknownToolStreak≥3` 提示（`engineAdapter.ts:408-410`）。**无"同参数重复失败""幂等无进展"检测**——0.6.5 时代实测的"伪工具调用空转 905s"家族问题在此仍有残余暴露面（模型换参数重试永不收敛时只能靠 maxSteps 硬停）。
- **移植性**：直接移植（低成本高价值，~80 行）。

### 2.3 工具结果三层防溢出 【移植价值：中】
- **hermes**：`tools/tool_result_storage.py` 三层——①工具内自截断；②`maybe_persist_tool_result`（:144）超阈值完整输出落盘 `/tmp/hermes-results/{tool_use_id}.txt`，上下文替换为 `<persisted-output>` 预览 + 路径（模型可用 read 工具按需回读）；③`enforce_turn_budget`（:203）单轮全部结果超 200K 时逐次落盘最大的。`read_file` 阈值钉死 inf 防"落盘→再读→再落盘"死循环（`budget_config.py:10-12`）。
- **烛龙**：只有一层——`TOOL_OUTPUT_CAP=20000` 尾截断（`tools/types.ts:42-51`）+ 历史 head 2500/tail 800 修剪。被截掉的中段**永久丢失**，模型无法回看。
- **移植性**：需改造（烛龙 read_file 有 offset 续读，落盘后回读路径天然成立）。长任务 grep/bash 大输出场景收益直接。

### 2.4 system prompt stable/volatile 分段（prompt-cache 友好） 【移植价值：中】
- **hermes**：`agent/system_prompt.py:147` 三段有序——`stable`（身份/工具指引）/`context`（AGENTS.md/调用方注入）/`volatile`（记忆快照/时间戳）；`build_system_prompt`（:527）会话内单次渲染缓存（:159-164 注释明写"为保上游 prompt cache 命中"）。
- **烛龙**：`buildForTask`（`PromptBuilder.ts:199`）每次全量重拼——L0/tier 契约/negative list（稳定块）与记忆卡/ENV/最近上下文（易变块）在同一次拼接里，**每任务字节级都变**，任何网关侧前缀缓存都无法命中。
- **移植性**：需改造，且**必须与消息数组协议（CC 维度 #1）一起做**——文本拼接模式下分段缓存收益为零；messages 化之后 stable 段置顶 + volatile 段追加，前缀缓存才能命中。

### 2.5 审批 smart 档（辅助 LLM 裁判）+ 敏感路径写保护 【移植价值：中】
- **hermes**：`tools/approval.py:2560` `_smart_approve`——辅助 LLM 剥注释防注入后 XML 判定 approve/deny/escalate；`agent/file_safety.py:28-61` 敏感路径写保护清单（`.ssh/id_rsa`/`.git-credentials`/`.netrc` + `.aws/`/`.kube/` 前缀）。
- **烛龙**：三档 readonly/default/full + 会话 allowlist + `'a'`（`approval.ts:48-83`）；pathGuard 工作区边界已有，但**无敏感路径清单**（工作区内 `.ssh/` 之类不在防护之列）。
- **移植性**：敏感路径清单直接移植（~40 行，零争议）；smart LLM 裁判对 1B 弱模型误判危险命令有真实价值但引入第二模型调用，缓一步。

### 2.6 错误分类器 + 分层重试 【移植价值：中】
- **hermes**：`agent/error_classifier.py`（1698 行）把错误分为 rate_limit/server_error/timeout/**context_overflow**/auth/billing/format_error，非瞬态类 `retryable=False` 快速失败。
- **烛龙**：`withRetry` 只按 status 集合 + 空响应 + 传输类判断；auth/预算类错误也白吃 5 次退避；无 context_overflow 专用通道（超窗错误目前表现为普通 400）。
- **移植性**：需改造。`context_overflow → 触发 auto-compact → 重试`的联动（CC 维度 #15 缺口）可一并闭环。

### 2.7 工具注册表 check_fn TTL 探测缓存 【移植价值：低】
- **hermes**：`tools/registry.py:143-147` 可用性探测 30s TTL + 60s 失败宽限（防瞬时抖动误判）。
- **烛龙**：工具为进程内实现无探测面；MCP 工具有 30s 请求超时但无可用性缓存。暂无必要。

### 2.8 subagent 委派（leaf/orchestrator 角色 + 深度上限） 【移植价值：低（架构级）】
- **hermes**：`tools/delegate_tool.py`——`MAX_DEPTH=1` 扁平默认、`_DEFAULT_MAX_CONCURRENT_CHILDREN=3`（:119）、子代理审批默认自动拒绝危险命令（:75）、interrupt/list 管理。
- **烛龙**：无。与 CC 维度 #3 同源，属架构级新增；hermes 的三约束（角色继承/深度上限/子代理审批默认拒绝）是未来多 agent 时的安全骨架参考。

### 2.9 plan/执行两阶段 【不适用（方向相反）】
- hermes 无 plan mode（grep 零命中）；烛龙已有 planMode 门禁。hermes 的 `verification_stop.py`（回合尾验证证据不足→合成 nudge 续一轮）与烛龙 0.7.3 的"answered 空转防呆"同类——烛龙反向领先。

### 2.10 file-backed 主动记忆 tool 【移植价值：中（需权衡）】
- **hermes**：`tools/memory_tool.py` MemoryStore 双 store 文件持久化（memory 2200 字符/user 1375 字符上限）+ 文件锁 + 外部漂移检测；模型可随时主动存取记忆。
- **烛龙**：记忆是"任务落定提炼"模型（refine→save），无模型主动 tool 调用入口。新增主动记忆 tool 与既有提炼模型是两条写入源，需 R1 合同纪律（单一落定点）评审后再定——**宁缺毋滥**。

### 2.11 汇总表

| # | 机制 | 移植价值 | 烛龙改动量级 | 何时 |
|---|---|---|---|---|
| 2.1 | 工具并行分段调度 | **高** | 中（~250 行） | 0.8 |
| 2.2 | 卡死检测硬闸（重复失败/无进展） | **高** | 低（~80 行） | 0.8 |
| 2.3 | 工具结果落盘 + 回读 | 中 | 中（~200 行） | 0.8 |
| 2.4 | stable/volatile prompt 分段缓存 | 中 | 中（~150 行，**依赖 messages 协议**） | 0.8（随 S1） |
| 2.5a | 敏感路径写保护清单 | 中 | 低（~40 行） | 0.8 |
| 2.5b | smart LLM 审批裁判 | 中 | 中 | 0.8+（缓） |
| 2.6 | 错误分类器 + overflow→auto-compact | 中 | 中（~200 行） | 0.8 |
| 2.7 | check_fn TTL 探测 | 低 | — | 不立项 |
| 2.8 | subagent 委派 | 低（架构级） | 大 | 0.9+ |
| 2.9 | plan 两阶段 | 不适用（烛龙领先） | — | — |
| 2.10 | 主动记忆 tool | 中（需权衡） | 中 | 评测后定 |

---

## 3. 交叉结论：差距的本质收敛为"一条协议 + 三件配套"

三方对比互证后的核心判断：

1. **一切 S 级差距共享同一个根：上下文协议。** CC 的 messages 数组是 KV 前缀缓存、tool_result 通道、跨任务连续会话、微压缩、分段 prompt 缓存（hermes 2.4）的**共同地基**。烛龙 2115 行 sseInteractive 巨函数与"文本拼接协议"互为因果——文本协议让巨函数合理化，巨函数反过来锁死协议演进。**先动协议，其余项的成本全部下降。**
2. **hermes 用 Python 做到了"单 agent 把执行层做扎实"**：分段并行、卡死硬闸、结果落盘——三项都不依赖多 agent 架构，是烛龙在**不引入 S 级重构**前提下就能拿到的真实能力增量。
3. **烛龙反向领先面（不应为了"对齐"而丢）**：回合三态终止语义 + error 分离、意图分类前置、记忆卡二态语义、compact 血统账本、真实验证信号入册、fileHistory 写前快照。hermes 无 plan mode、无记忆卡提炼模型；CC 的 rewIND 粒度优势在 0.7.x 已被追平大半。0.8 的正确姿势是**换地基、保语义**。
4. **竞赛约束**：9/24 交付、R6 评测主线（A/B/C 消融 + PANSHA_NO_MEMORY 契约 `PromptBuilder.ts:481`）、三队友分支待合入。0.8 的改动量要求"大"，但**不能破坏评测契约与三态语义**——这是设计的硬边界。

---

## 4. 0.8 立项输入（详见 PLAN-0.8 文档）

| 候选 | 来源 | 级别 | 一句话 |
|---|---|---|---|
| 消息数组协议重构（messages 通道 + system role + tool role + history 前缀化） | CC #1/#2 + hermes 2.4 | **S** | 分水岭；KV 缓存/工具通道/跨任务会话的地基 |
| TurnController 拆分（sseInteractive 2115 行 → 会话壳 + TurnController + 渲染器） | CC 结构 + ROADMAP §3.2 | **S** | 协议重构的物理前提（无处可落→先腾地方） |
| 工具并行分段调度（读并发 + 写 barrier） | hermes 2.1 | **A** | withWriteLock 已是 barrier 原语，零架构增量 |
| 卡死检测硬闸 | hermes 2.2 | **A** | 同参数重复失败/幂等无进展 before_call 阻断 |
| 工具结果落盘 + 回读 | hermes 2.3 | A | 20K 尾截断 → 预览+落盘+回读三层 |
| 真实 usage 计量 | CC #13 | A | 解析网关 usage 字段，len/4 降级为 fallback |
| 错误分类器 + overflow→auto-compact | CC #15 + hermes 2.6 | A | 超窗自动压缩重试闭环 |
| 敏感路径写保护清单 | hermes 2.5a | B | ~40 行零争议 |
| Turn.role 字段 + 不对称压缩 | CC #8 + hermes 2.4 关联 | B | 0.8 至少落 role 字段（不对称保留随之解锁） |
| Plan mode 确认卡 | CC #6 | B | ExitPlanMode 确认卡 + 计划评审往返 |
| MCP SSE/HTTP 传输 / Skills 渐进披露 / 自定义斜杠命令 | CC #10/#11 | B | 视 0.8 带宽 |
