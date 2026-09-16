# Panshalach 架构设计文档（命题提交物 1 · 雏形）

> 华为命题：基于 openPangu 系列模型，构建具备长程上下文管理能力的记忆增强智能体。
> 本文档对应命题交付要求：**最终系统架构 / 记忆模块设计 / 训练方案 / 推理流程 / 资源消耗 / 核心创新点**。
> 状态：架构以现有可运行工程为基（自动化测试以 `npm test` 实际输出为准，当前基线 1446 例），标注"已实现 / 规划"；真机 openPangu 验证数据见 [EVALUATION.md](EVALUATION.md)。版本基线 **v0.8.8**。

---

## 0. 摘要

Panshalach（外部产品名 **烛龙 Zhulong**）是一个 **记忆增强的通用智能体**：以 openPangu-1B/7B/7B-VL（昇腾/本机 OpenAI 兼容端点）为推理底座，把传统 agent 的"一次性对话窗口"升级为四层记忆保持体系——

1. **会话内状态**（回合轨迹 / 验证信号，实时纠偏）；
2. **结构化记忆卡**（跨会话提炼的教训/经验/偏好，分档注入、验证保鲜与合并）；
3. **上下文压缩与会话资产**（长会话可 resume/branch，压缩带血统账本，压缩时补漏提炼成功卡）；
4. **事件记忆 + 任务状态**（已落地）：语义化业务事件流（R4 `memory/events.ts`）与跨多轮任务状态机（R5 `memory/taskState.ts`），直击"中期遗忘 / 上下文断裂"。

0.8 周期完成"换地基"：上下文协议从单 prompt 字符串升级为 **messages 双通道 + stable/volatile 三段 prompt**（前缀缓存友好），交互层从 2115 行巨函数拆为 turn 四模块并补齐 Claude Code 级交互手感，执行层七项强化（并行分段/卡死硬闸/结果落盘/usage 计量/错误分类/敏感路径/角色字段）全部落地。

在真实业务场景"软件工程长期维护"上，它表现为：早期需求约束在多轮演进后仍被遵守、跨文件修改不丢失关联、中断后能准确续接进度。

---

## 1. 系统分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│ 交互/服务层（0.8 拆分 + CC 级手感）                                  │
│   sseInteractive 会话壳 → turn/ 四模块：                            │
│     TurnContext(巨状态) · TurnController(任务/审批/中断/drain)      │
│     TurnRenderer(事件渲染+CC视觉纯函数) · CommandRouter(命令派发)    │
│     + SlashMenu(斜杠即时菜单状态机)                                 │
│   交互手感：/ 即时菜单(过滤/↑↓/分组/滚动) · shift+tab 档位环专属色    │
│     · /model 菜单化(编号直达) · /tier 思考强度滑杆(←→/Enter/Esc)    │
│   REPL（行模式/富 TTY） · SSE 服务（/api/run） · one-shot CLI      │
│   会话资产：rollout jsonl(resume/branch/undo/rewind) · usage      │
├──────────────────────────────────────────────────────────────────┤
│ 提示工程层 (PromptBuilder 三段拆分 · M1-PROTOCOL)                   │
│   stable 段：身份(通用智能体) → L0硬约束(≤3) → tier契约 → 负向清单   │
│     ——任务间字节级相同 → messages 模式置 system 首消息               │
│     （网关前缀缓存可命中）                                          │
│   volatile 段：L1记忆注入 → 环境增量 → 最近上下文 → 当前任务          │
│   （注入去重 / token 预算 / 档位差异化 / 参照文件过滤 /             │
│     injectedCardIds 逐任务注入审计）                                │
├──────────────────────────────────────────────────────────────────┤
│ 记忆增强层                                                        │
│   记忆卡 store（failure/success/preference + 类别分档 + 四段衰减    │
│     + 验证保鲜 markVerified + 合并 + count 封顶）                   │
│   会话资产/事件日志(rollout jsonl → 事件记忆 R4)                    │
│   任务状态跟踪(TaskState R5)                                       │
│   语义检索[embed v0 已落(单测在库), L1 注入融合待接]                │
├──────────────────────────────────────────────────────────────────┤
│ 执行循环层 (taskIntent → solveIssue → VerifyCritiqueLoop)          │
│   意图分类：chat 单次直答(通用画像有问必答) / search 只读≤3步        │
│     / task 全循环；PANSHA_INTENT_GATE=0 逃生门                     │
│   chat 直答三级回落：streamChatMessages → chat → complete          │
│   messages 双轨：ChatMessage 栈（system 首位/tool role 配对）       │
│     ⇄ 文本协议降级；PANSHA_MESSAGES_MODE=off 逃生门                │
│   单次 loop.run；回合七态: completed/answered/max-steps/           │
│     consecutive-failures/aborted/no-verification/error            │
│   卡死硬闸 guardrails：同参失败5次阻断/同工具8次强制终局/幂等无进展5次│
│   AbortSignal 贯穿 / budget 按真实 usage 累计 / think 标签剥离      │
├──────────────────────────────────────────────────────────────────┤
│ 工具引擎层                                                        │
│   read_file glob grep bash write_file edit_file diff             │
│   读并发+写 barrier 分段调度（只读三件套 Promise.all）              │
│   大输出三层防溢出：20K 截断 → scratch 落盘 → persisted-output      │
│     预览 + read_file 按需回读                                      │
│   （LCS diff + 原子写 + RBW 护栏 + 脱敏 + 敏感路径全档位写保护）     │
│   审批：readonly/default/full + allowlist + MCP stdio             │
├──────────────────────────────────────────────────────────────────┤
│ 模型接入层                                                        │
│   ProviderRegistry(openai-compatible) → openPangu                │
│   双通道：chat()/streamChatMessages()（messages 数组）             │
│     ⇄ complete()/streamChat()（文本协议降级）                       │
│   原生 tool_calls 透传 + usage 解析(真实token计量)                 │
│   withRetry 5次指数退避 + 错误八类分类(errorClassify：              │
│     context_overflow→强制compact重试；auth/billing 快速失败)       │
└──────────────────────────────────────────────────────────────────┘
          ▼ 推理底座
   openPangu-1B / 7B / 7B-VL
   （昇腾 MindIE / vLLM-ascend · 本机 OpenAI 兼容端点 · 麒麟/其他国产 OS）
```

**各层职责一句话**
- 交互层：turn 四模块 + CC 级手感——任务提交/渲染/命令派发分离，斜杠菜单/档位环/滑杆全键盘可达。
- 模型接入层：把"用什么模型、走什么通道"与上层解耦——messages 与文本双通道自适应（1B/7B 小模型不认 tool role 自动回落），openPangu 可替换，无需动记忆/循环。
- 工具引擎层：真实执行 + 审批 + 护栏 = agent 的"手"；大输出落盘回读保证长任务信息不丢。
- 执行循环层：单次 loop.run + 回合七态 + 卡死硬闸；每步产出轨迹/验证信号（长程记忆的素材）。
- 记忆增强层：agent 的"长期记忆"——跨会话经验、压缩摘要、事件、状态外置到 prompt 预算。
- 提示工程层：stable/volatile 三段拆分——稳定契约置顶命中前缀缓存，记忆注入按预算闸门进 volatile 段。

---

## 2. 记忆模块设计（重点）

### 2.1 记忆卡 schema（已实现，`src/memory/RefinedMemoryCard.ts`）

| 字段 | 含义 | 作用 |
|---|---|---|
| `kind` | failure / success / preference | 注入标签（[失败教训]/[成功经验]/[用户偏好]）与衰减基线 |
| `category` | FailureCategory（幻觉/验证/RBW/命令失败/状态不符…） | 失败模式归因（success/preference 用 OTHER） |
| `memoryCategory` | architecture / failure / implementation / insight / general | 分类半衰期（arch 365d > impl/insight 180d > failure/general 90d） |
| `summary` | 一句话建设性摘要 | 注入文本（截 120 字符） |
| `weight/count` | 基础权重 / 触发次数 | 合并去重与升权；count≥2 → 半衰期×count |
| `lastSeen/firstSeen/lastUsedAt` | 时间戳 | 四段阶梯衰减（1/0.7/0.4/0.1） |
| `applicableTiers` | 适用档位 | 卡级档位门禁（空=全档可见） |
| `referencedFiles` | 相关文件路径 | **P2-D 参照文件交集过滤**：只加载"本任务将触碰文件"相关的卡，命中为空回退全量 |
| `pinned / status / mergedFrom` | 冻结衰减 / 软删除 / 合并溯源 | 偏好 pin、同主题合并可回滚 |

容量：单类 ≤10、总 ≤200；默认落盘 `<workspace>/.panshalach-memory.json`（内部名，见 ROADMAP P6 迁移）。注入时经 8 槽投影缓存（任务内快照冻结、写入失效重建）。

### 2.2 记忆写入（提炼 → 保存）
- **信号源 B（回合闭环）**：任务落定后把 `bestTrajectory` + `attemptCount` + 用户反馈交给 `RefinedMemoryStore.refine()`（失败信号抽教训卡；`stopReason==='completed'`（真实验证通过）或正向反馈 → success 卡），`save()` 合并去重写盘。落定点为 `finalizeTaskMemory` 单一收口（runAgentTask result 前，覆盖 SSE/server/headless，Repl 三口经 U5 接线）。**0.8.1 三缺陷治理**（对抗性审计驱动）：①产卡携带任务信息（通用卡曾零信息 → 对后续任务无检索价值）；②markVerified 断链接通（injectedCardIds ∩ 任务真实写集判保鲜）；③count 封顶 `min(count,3)`（防"永生卡"霸榜）。
- **信号源 C（压缩补漏）**：`compactService` 把被移除轮次中**验证成功**的信号确定性补提为 success 卡，evidence 取该轮任务摘要（hash 去重，防双重计数）。
- **用户显式**：`/memory remember [--pin]` / forget / import / export / clear / merge。

### 2.3 记忆读取与注入（loadFiltered，已实现）
1. 归一化旧卡（无 kind 默认 failure，无 memoryCategory 默认 general）。
2. 过滤：任务风格匹配 → tier 可见性（architecture 始终可见；quick 仅 failure；standard 加 implementation；high 加 insight；max/ex/pangu 全量）。
3. **参照文件交集过滤**（提供 currentWorkspaceFiles 时）：只保留 referencedFiles 与当前相关文件有交集的卡；空则回退全量（不"无卡可用"）。
4. 有效权重：kind 基线（preference 0.6 / 其余 1.0）· pin 冻结 · 分类半衰期×count · 4 段因子；`effective < 0.3` 丢弃。
5. 相关性：任务关键词命中 summary +1（cap 3）；排序 = 0.7×权重 + 0.3×相关性，再按 count。
6. 数量：档位 3/6/8/10；preference 保留 1 席位。L1 之外 standard/high 可探索期自动拉取 ≤5 张、预算 ≤700 token（ghost 提示余量去 `/memory` 看）。

### 2.4 已知差距与补齐路线（开放项，详见 ROADMAP-NEXT §B/C 与 MEMORY-DESIGN.md §7）
| 缺口 | 状态 |
|---|---|
| 语义检索仅 2-gram 词袋 v0（embed.ts 已落，含单测） | L1 注入融合未接线（→ 国产向量库/openPangu embedding 可插拔，R7/C4） |
| 压缩为单次摘要（非多级滚动） | R8：Turn.role 字段已就位，不对称分区压缩本体待做 |
| messages 分段未接 classic 直调路径 | 文本协议降级语义（非缺陷）；接线后 classic 与主线一致 |
| 记忆审计 #4-#13 剩余项 | 见 ROADMAP-NEXT §B2 |

---

## 3. 推理流程（回合 → 注入 → 执行 → 验证 → 提炼写回）

```
用户输入 / 任务队列
  │
  ▼ 交互层（line 模式：斜杠即时菜单 → 本地命令 / 任务提交；
    运行中提交自动入队 drain，drain 深度护栏 8 层止损）
  ▼ 意图分类（src/cli/taskIntent.ts；PANSHA_INTENT_GATE=0 逃生门）
    chat（问候/问答/知识/创作）→ 单次直答（三级回落 streamChatMessages→
        chat→complete；通用画像有问必答；think 标签网关剥离）→ answered
    search（文件宾语无动词）→ 受限只读循环：≤3 步、强制 readonly、禁写
        禁 bash；搜到报告位置与概要，搜不到询问用户具体用意
    task/execution → 完整验证循环（↓ 主路径）
    meta（/命令）→ 不进 agent
  │（task/execution 主路径）
  ▼ PromptBuilder.buildForTask = stable 段 + volatile 段
    stable：身份(通用智能体)+L0+tier契约+负向清单（任务间字节级相同）
    volatile：L1 记忆注入(参照文件/关键词/tier 过滤+预算，注入审计
    injectedCardIds) · 项目验证块 · 最近上下文(3轮含答案摘要) · 当前任务
    messages 模式：stable → system 首消息（前缀缓存命中），
    volatile → 首条 user；文本模式：两段拼接单 prompt
  │
  ▼ PanshalachChaser.solveIssue（单次 loop.run）
    VerifyCritiqueLoop 迭代（messages 双轨与文本双轨共享 steps 数据源）：
        思维链(think/plan/verify) → 工具调用(三路自适应解析)
        → 卡死硬闸检查(guardrails before_call) → 分段调度执行
        （只读三件套并发 + 写 barrier 串行；大输出落盘 scratch 回读）
        → 真实执行+审批 → 验证信号(PASS/FAIL)
        网关错误 → errorClassify 八类：overflow→强制 compact 后重试
        （每任务 1 次）；auth/billing 快速失败；其余 withRetry 退避
        终止（单层）：PASS+end_turn → completed / end_turn 有正文 →
        answered / 空白空转 → no-verification / max-steps /
        连错上限(guardrails 同工具 8 次强制终局) / abort / 异常 → error
    budget：estimatedUsedTokens 优先真实 usage 累计（len/4 降级）
  │
  ▼ 任务落定（回合写闭环 · 0.7.2 落地 · 0.8.1 治理）
    refine(信号=stopReason==='completed' + attemptCount + 反馈) → save
    （产卡携带任务信息；纯问答 answered 不产 success 卡）
    markInjected 全量记账；injectedCardIds ∩ 真实写集 → markVerified 保鲜
    会话 addTurn + rollout append（含注入审计 context 事件）
    → 下一回合 L1 注入能读到"上一轮沉淀"
```

**为什么这样能治"中期遗忘"**：关键事实（需求约束/教训/进度/决策）在每轮被**显式外置**进注入预算，不依赖模型把 N 轮前的 token 记住；压缩旧轮时用模型摘要 + 成功信号补漏提炼，把"被挤出窗口"的信息转为结构化卡。

---

## 4. 训练方案

本架构遵循命题"基于 openPangu 基础模型进行技术验证与实现"，**不改基础模型**，采用 **test-time 记忆增强 + 提示/上下文工程**路线（参赛可选路径中的"记忆增强模块/上下文压缩/结构化记忆/事件日志/任务状态管理"组合）：

- 基础模型：openPangu-1B / 7B / 7B-VL（预训练权重，OpenAI 兼容服务化）。
- 无 SFT/LoRA（若后续做，记忆注入样本可微调 memory-usage 偏好；本期不引入以守住零依赖与可复现）。
- "训练"体现为**记忆的归纳**：卡片提炼规则(失败→教训 / 一次通过→成功经验)、衰减与合并、压缩摘要策略——全部确定性、可审计、离线可复现（自动化测试覆盖）。

---

## 5. 资源消耗

| 项 | 数值 | 说明 |
|---|---|---|
| 推理底座显存 | **待赵天昂 U7 实测**（1B / 7B int8 分列） | 端点外置（昇腾 MindIE / vLLM-ascend / 本机 OpenAI 兼容），Agent 侧无模型驻留；经验参考 7B int8 约 7–16GB、1B < 4GB（非实测） |
| Agent 进程内存 | **待赵天昂 U7 实测** | Node ≥18 + TypeScript 产物；`dependencies: {}` 零运行时依赖 |
| 上下文预算 | **待赵天昂 U7 实测**（软窗默认 128K，`PANSHA_CTX_WINDOW`） | compact 触发：ctxRatio≥0.85 且 >12 轮 |
| 记忆/事件文件体积 | **待赵天昂 U7 实测** | 卡 ≤200（单类 ≤10）、rollout jsonl 追加；设计容量 KB 级 |
| 每任务 token | **待赵天昂 U7 实测** | 0.7.0 起回合上界 = 单次 maxSteps（10–40 步/档，判官摘除）；search 意图 ≤3 步；预算软限按模型调用累计 |
| `/usage` 预算读数 | **待赵天昂 U7 实测** | 0.7.0 起 `estimatedUsedTokens` 按每次模型调用真实累加（修复恒 0） |
| 成本核算 | **待赵天昂 U7 实测** | `/usage` 基于配置单价，可选 |

> **回填纪律**：数值列不预填——统一由**赵天昂 U7**（真机 openPangu 实测）回填，结果先入 [EVALUATION.md](EVALUATION.md) §4 再同步本表；"说明"列中的容量上限/软窗阈值为设计契约，不是实测值。

---

## 6. 核心创新点（相对常规长上下文方案）

1. **证据门槛的记忆写入 + 二态使用语义**：记忆写入的唯一门槛是回合真实验证信号（`stopReason==='completed'`，区别于"模型自主决定何时记忆"的 Letta/MemGPT 路线与"对话后即时存储"的 MemoryBank 路线）；`markInjected`（注入仅记账，不保鲜）/`markVerified`（注入卡与任务真实写集交集判定的机器保鲜，修"读即用永不衰减"）——记忆会随真实任务生长，且不把"被看见"误当"被使用"。0.8.1 对抗性审计修复三缺陷（产卡携带任务信息/保鲜断链/count 封顶）后机制完整闭环。
2. **逐任务注入审计**（`ContextSnapshot` + `injectedCardIds` + promptHash）：每次任务把"模型实际看见了哪些记忆"落 rollout `context` 事件——配合 R4 事件溯源全程可重放，记忆价值可查证。
3. **压缩血统账本 + 补漏提炼**（`compactService`）：`generation/coveredTurnIds` 按覆盖账本安全合并（压缩期间新增轮不丢）、rewind 断血统拒绝 apply、被移除轮次的验证成功信号确定性补提为 success 卡——压缩成为记忆沉淀入口而非信息黑洞；overflow 错误触发强制压缩重试（errorClassify 联动）。
4. **stable/volatile 三段 prompt + messages 双通道**（0.8 M1）：稳定契约（身份/硬约束/档位契约）任务间字节级相同 → system 首消息命中网关前缀缓存；易变内容（记忆卡/环境/任务）走 volatile 段。messages 数组与文本协议双通道自适应降级——1B/7B 小模型不认 tool role 自动回落文本标注，`PANSHA_MESSAGES_MODE=off` 逃生门。**面向国产小模型网关的上下文协议工程**（真机 MiniMax-M3/1B 实测驱动）。
5. **执行层可靠性七件套**（0.8 M2）：卡死硬闸（同参失败/幂等无进展 before_call 阻断——治弱模型空转烧步数）、读并发+写 barrier 分段调度、大输出落盘回读三层防溢出、真实 usage 计量、错误八类分类（overflow→强制压缩重试闭环）、敏感路径全档位写保护、drain 深度护栏。
6. **分档记忆注入预算 + 参照文件交集过滤**：六档强度把记忆加载量、衰减、探索深度做成可量化行为契约；只载入"本任务实际触碰文件"相关的卡，命中为空自动回退——精准防上下文污染。
7. **确定性记忆维护**：四段阶梯衰减 × 类别半衰期、同主题 2-gram 合并(原卡归档可回滚)、容量上限、投影缓存快照——离线可测，不依赖 LLM 判断记忆要不要留。
8. **事件日志 + 任务状态 + 会话资产**：追加式语义事件（R4）与跨轮任务状态机（R5）已落地并接线运行时，resume/branch——把"长周期持续跟踪"做成可审计、可续接的资产。
9. **国产软硬件亲和**：模型层为 OpenAI 兼容抽象 → openPangu on 昇腾(MindIE/vLLM-ascend)/本机端点即插即用；三路协议探测 + 双通道降级让模型格式差异不再是接入门槛；提示词身份/工具教学按 1B-7B 小模型实测收敛（情境框架式身份、negative_tool_list 防伪调用）。

---

## 7. 下一步（按 ROADMAP-NEXT.md）

R6 真机消融评测数据回填（A/B/C/C4 消融：`PANSHA_NO_MEMORY=1` 零注入对照）→ R7 语义检索 L1 注入融合 → 0.8 M3 时间盒项（Plan mode 确认卡/跨任务连续 messages 会话/MCP SSE）→ 不对称压缩（Turn.role 字段已就位，分区压缩本体 R8）→ P6 存储名迁移收口。真机评估数据持续回填本文档与 EVALUATION.md。
