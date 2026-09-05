# 重构评估报告：贴近华为命题《基于 openPangu 的记忆增强智能体架构设计与优化》

> 项目代号：**Panshalach**（现仓库工程代码名曾为 Panshalach；早期模型试点已完成向 openPangu 的迁移）
> 命题企业：华为技术有限公司 · 国产操作系统软件组
> 命题要点：基于 **openPangu-1B / 7B / 7B-VL** 系列模型，构建具备**长程上下文管理能力**的记忆增强智能体，解决长交互 / 多轮任务 / 长文档 / 持续状态跟踪带来的**中期遗忘**与**上下文断裂**问题；交（1）架构设计文档、（2）效果评估报告（含与无记忆/基线方案对比）。
> 评估基准日：2026-09-03（Git 仅一次初始化提交，分支 `zhaiyuanhao1`；当前可见统计：62 组 `*.test.ts`）。

---

## 1. 命题拆解 → 验收标准

| 命题要求 | 拆成可验收标准 | 现状 |
|---|---|---|
| (1) 必须使用 openPangu 系列作为基础模型 | 模型接入层能切到 openPangu（OpenAI 兼容端点或昇腾部署），并跑真实验证 | ❌ 模型层硬编码绑定早期试点模型/网关（含 magic shorthand、/model list 特化、铁律 prompt 里品牌字样）；❌ 无 openPangu provider 示例与文档 |
| (2) 选一个有价值的长周期任务场景 | 一个业务场景 + 对应的演示/评测任务集 | 场景候选：软件工程长期维护（跨多轮需求演进 / 跨文件长文档分析 / 持续状态跟踪）；资产天然支持（真实 read/write/bash/glob/grep + 验证铁律） |
| (3) 长程上下文管理能力 + 合理基线对比 | 显式的记忆/上下文机制 + 可运行的基线对比评测 | 有记忆卡 / 会话资产 / 压缩雏形，但**缺若干关键长程机制**（见 §3），且无任何基线评测工程 |
| 交付 (1) 架构设计文档 | 分层架构 / 记忆模块设计 / 训练与推理流程 / 资源消耗 / 核心创新点 | 旧文档全为 Panshalach 叙事；需重建 Panshalach 命题文档 |
| 交付 (2) 效果评估报告 | 本方案 vs 无记忆基线对比；长程保持与历史利用能力 | 无。需先建评测方法，再用**真实 openPangu** 填数据 |

---

## 2. 代码资产逐模块对照（现状 → 契合度 → 处置）

> 路径均相对仓库根。下面"契合度"以命题能力为准（不是以工程成熟度为准）。

### 2.1 记忆系统（命题核心，契合度 ★★★★ 骨架）

| 模块/文件 | 能力 | 命题契合点 | 差距 | 处置 |
|---|---|---|---|---|
| `src/memory/RefinedMemoryCard.ts` | 持久卡：`kind(failure/success/preference)`、`category`、`memoryCategory(architecture/failure/implementation/insight/general)`、`summary`、`weight`、`count`、`lastSeen/firstSeen`、`applicableTiers`、`sourceContext`、`decayWeight`、`lastUsedAt`、`pinned`、`status`、`mergedFrom`、`referencedFiles`；容量 每类10/总200、半衰期 30d | 结构化记忆卡 schema 完备，直接是"结构化记忆"技术路线的实体 | 无 | **保留** |
| `src/memory/RefinedMemoryStore.ts` | `refine()`(从轨迹抽失败信号 + 一次通过正向提炼 success)、`save()`(mergeAndCap + gitignore)、`load()`、`loadFiltered()`(tier/style 可见性 + **P2-D 参照文件交集过滤** + 4 段阶梯衰减 + count≥2 升半衰期 + preference seat + keyword relevance 排序)、`loadFilteredCached()`(8 槽投影缓存/30d 阶梯 key/快照冻结)、`refineCompactSignals()`、`remember/forget/clear/import/export`、`mergeSimilarCards()`(2-gram 去重合并) | 记忆卡加载/过滤/衰减/去重/合并基本完备；**参照文件过滤**贴近"任务状态关联" | 见 §3.1（回合写闭环缺失【R1 最紧要】、无语义检索、事件/任务状态运行时未落——二态 markUsed 已落） | **保留 + 演进** |
| `src/memory/FailureMemory.ts` | 进程内失败记忆（文件保留仅为 UserConfirmation/MemoryCommand 兼容） | ~~会话内实时失败反馈~~ | **轨道已摘除（#6，2026-09-05）**：chaser/loop/engineAdapter 不再注入/记录；失败信号唯一归口 = RefinedMemoryStore.refine | 已摘除（归档见 archive/2026-09-05-removals/） |

### 2.2 上下文 / 锚点 / 提示工程（契合度 ★★★★；锚点子系统已摘除 2026-09-05）

| 模块/文件 | 能力 | 处置 |
|---|---|---|
| ~~`src/context/RepoExplorer.ts`~~ | 仓库扫描 + 锚点推荐/注入 | **已摘除归档**（#3，2026-09-05，archive/2026-09-05-removals/）——"仓库我知道什么"由记忆注入承担 |
| ~~`src/context/ContextManager.ts`~~ | 内存锚点+预算估算 | **已摘除归档**（#3）；预算估算由 PromptBuilder 账本 + ContextSnapshot 事件承担 |
| `src/cli/repl/PromptBuilder.ts` | 回合 prompt 最终组装：身份 → L0(≤3) → tier XML 约束 → 档位契约 → 负向工具清单 → 项目验证块 → plan-mode → thinking 阶梯 → **L1 记忆卡注入(去重/截 120/来源标签/按档位 3/6/8/10)** → skills → 当前特性 → ENV 增量 → 最近3轮 → 当前任务 → 压缩 → standard/high 探索自动拉取(预算 700) → injection_summary | **保留**；L1 是"长程记忆注入"主通道；演进点：语义检索替换/辅助子串 keyword、`markUsed` 刷新 |
| `src/reasoning/StructuredReasoner.ts`、`src/benchmarks/BenchmarkProfiles.ts` | 思维链阶梯/铁律头/复盘 prompt；任务风格(swe/terminal/automation) profile | **保留**；去模型品牌措辞泛化为"工程纪律"（见 §4-P4） |

### 2.3 会话资产（契合度 ★★★★，直接支撑"长程上下文"）

| 模块/文件 | 能力 | 处置 |
|---|---|---|
| `src/cli/repl/Session.ts` + `SessionStore.ts` | 会话(轮次/tier/workspace/model/审批)持久化 `~/.panshalach/sessions/` | **保留**（存储名迁移见 §4-P6） |
| `src/cli/repl/rolloutStore.ts` | **追加式 jsonl 事件**(meta/turn/approval/rewind)、崩溃容错 resume、branch 只读分叉 + session tree | **保留**；这就是"事件日志"的技术底座——演进为结构化**事件记忆**（§4-P3） |
| `src/cli/repl/compactService.ts` + `compactStrategies.ts` | **上下文压缩**：移除保留最近6轮、模型摘要(默认≤300字保核心/或主题分组)、失败回退确定性逐轮 brief、后台预压缩 + 原子应用、**compact 补漏提炼** | **保留**；这就是"上下文压缩"路径；演进：滚动多级摘要、压缩后一致性校验 |
| `src/cli/repl/FeatureTracker.ts` | `feature_list.json`：单一 in-progress feature + nextStep + evidence | **保留并演进**：这就是"任务状态管理"雏形 → 多轮任务状态机(进度/约束/已决/待决) |
| usage / approvals / undo / rewind / file-history | 用量、审批、回滚、文件历史 | **保留**（审计与可回滚支撑长周期可靠性） |

### 2.4 执行循环 / 工具引擎（契合度 ★★★★★ 差异化资产）

| 模块/文件 | 能力 | 处置 |
|---|---|---|
| `src/loop/VerifyCritiqueLoop.ts` | 验证密度 / Read-Before-Write / Verify-Before-Claim 铁律 / critique 节奏 / 失败保护 / 每步轨迹 → FailureMemory | **保留**；工具格式强约束泛化（见 §4-P4） |
| `src/tools/*`（readFile/glob/grep/bash/writeFile/editFile/diff/executor/approval/engineAdapter/fileHistory/mcpClient） | 真实工具执行 + 四档审批 + RBW + LCS diff + 原子写 + allowlist + MCP | **保留**；这是"持续任务执行"硬底座 |
| `src/orchestration/TestTimeOrchestrator.ts` + `Trajectory` | 串/并行 rollout、best-of-N、token 预算、early-stop | **保留**；可演进为"记忆增益对照评测驱动器"(同一 rollout 引擎跑 with/without memory) |
| `src/server/`（agentServer/runAgentTask/sse） | SSE 服务化、复用会话跑任务 | **保留**；是"服务化部署 + 前端评测演示"通道 |

### 2.5 模型接入（契合度 ★★，最需改造）

| 文件 | 现状 | 处置 |
|---|---|---|
| `src/model/openai-compatible.ts` | 零依赖 OpenAI 兼容 client（listModels/complete/streamChat） | ✅ **已完成（2026-09-04）**：complete 返回 `string \| {content, raw, toolCalls, detectedFormat:'openai-json'}`，SSE `delta.tool_calls` 增量拼装，支持自定义 headers |
| `src/model/ProviderRegistry.ts` | 多 provider 通用路由(配置驱动，provider:model 均可) + apiKeyCmd/headers/密钥解析 | ✅ **已完成（2026-09-04）**：ScnetClient import 已删；apiKeyCmd（stdout 首行，借鉴 claude-code apiKeyHelper）+ 自定义 headers |
| ~~`src/model/ScnetClient.ts` / `UniversalMaoyulinClient.ts` / `maoyulin-client.cjs`~~ | 死代码（0 调用方） | ✅ **已删除（2026-09-04）**，连同 probe-scnet-real.mjs（内含硬编码密钥，git 历史仍在，需服务侧轮换）与 probe-maoyulin-models.cjs；verify-scnet.mjs 改配置驱动任意 provider |
| `src/cli/repl/ModelProvider.ts` | `PANSHA_MODEL` 注入、SCNET_API_KEY 硬编码、早期试点模型 magic shorthand（已泛化为 `_pickBestProviderModel`）、bare name→scnet 路由（已通用化） | **去模型独占化**：保留通用 `provider:model` 路由（`_pickBestProviderModel`）；新增 openPangu env/key 注入与示例 |
| `src/cli/repl/commands/ModelCommand.ts` | `/model` 深层 scnet 特化(直读 scnet cfg/baseUrl/提示) | `/model list` 改 provider 无关读取(遍历 providers 各调 `/models`)；提示文案不再"只教你配 scnet" |
| `src/adapter/*`（StrictStructuredToolAdapter / UniversalToolCallAdapter / XmlStructuredToolParser / ToolCallFormatDetector / universal-tool-parser.cjs；早期版本以旧类名存在，已完成重命名） | 结构化 `<>` 严格解析、OpenAI JSON tool_calls、松散文本三路解析 + 探测与容错 | **保留为自适应解析链**；这正是"多模型可移植"的关键——openPangu 若输出 JSON tool_calls 已被探测器(confidence .95)覆盖，若输出文本协议走 loose 容错；`<>` 严格路径仅"对支持该格式的高档位模型"开启 |

---

## 3. 现有代码离"长程记忆增强"的缺口（本次重构核心动力）

### 3.1 记忆"写入闭环"缺失（最高优先级）
- `RefinedMemoryStore.refine(input)` 目前在**生产路径没有任何真实调用点**——仅 `tests/` 与 `compactService` 的 `refineCompactSignals()`（score≥85 补漏）。也就是说：每个真实完成的任务回合（REPL `executeTask` / `runAgentTask` / sseInteractive 回合落定）都不会把本次轨迹提炼成记忆卡并写盘。
- 后果：`/memory list` 里除了 `/remember` 偏好与压缩补漏，几乎没有自动沉淀的教训/成功经验——"从经验中学习"停在进程内 FailureMemory 与文档承诺。
- 修复点：任务结束时（拿到 `bestTrajectory`/得分/用户反馈）调 `refine({trajectory, taskStyle, applicableTiers, attemptCount, userFeedback})` → `save()`；配套使用语义已落地为二态 `markInjected`（记账）/ `markVerified`（保鲜，2026-09-04 bf5f4a7），衰减锚已修为 max(lastSeen,lastUsedAt)；markVerified 的验证→cardIds 生产信号源仍待接线。

### 3.2 检索机制单一（无语义检索）
- 仅 summary 子串 keyword(+1 cap 3) 与 `/memory search` 子串过滤；无 embedding / 向量库 / 语义召回。
- 命题点名"向量检索"是可选路径之一。零依赖约束下：字符级 n-gram 词袋向量 + 余弦（纯本地）作为 v0，文档注明可选替换国产向量库 / openPangu embedding。

### 3.3 缺"事件记忆 / 任务状态"两层
- 命题点名"事件日志、任务状态管理"。现有：
  - 事件日志形态 = `rolloutStore` jsonl（回合级审计），但没有按**业务事件语义**（决策/需求/约束/已验证/失败模式/引用文件）抽取的可查询事件流。
  - 任务状态 = `FeatureTracker`（一个 in-progress feature + nextStep），没有多轮跨任务状态机（用户原始需求长期保持、未决项、风险清单、进度里程碑）。
- 这两层正是"持续状态跟踪 + 需求持续跟进"的直接载体，是评估报告里对比"无记忆基线"的加分叙事。

### 3.4 无滚动多级摘要
- 压缩 = 一次 model 摘要 + 保留最近6轮（合成一卡），非"多级滚动（粗→细）"。命题中点名"上下文压缩"；目前策略已可用，演进为层级摘要(长期粗粒度 + 中期结构化 + 短期逐字)会更贴"长程"。

### 3.5 模型层早期试点绑定（阻碍 openPangu 验证）
- 绑定清单：`ModelProvider` 的试点模型 shorthand 与旧选模方法（现已泛化为 `_pickBestProviderModel`）、`getModelContextLength` 只查 scnet、bare-name→scnet 路由、`ModelCommand` 全 scnet 特化文案与直读、`SCNET_API_KEY` env 注入、`StructuredReasoner`/`VerifyCritiqueLoop`/`RepoExplorer` 内旧品牌措辞与旧格式强化方法（现已改名 `buildToolCallFormatEnforcementPrompt`）、旧 adapter 名（现已重命名）、高强度严格解析路径（现为 `strictStructured`）、提示中"标准 `<>` 工具调用格式"纪律。
- 影响：不改造则 openPangu 即便以 provider 接入，"用户可见/模型可见"仍是试点模型血统，无法宣称"基于 openPangu 验证"。

### 3.6 品牌/文档全是试点模型叙事（阻碍命题交付物）
- 大量 src 注释、README、docs 均是早期试点模型 / 30-rounds 复盘。需重建 Panshalach 命题文档并物理清理（本次已执行）。

---

## 4. 贴合盘古的改造路径（分阶段里程碑）

> **2026-09-05 注记（AGENT-CONTRIBUTION §3.1 禁区申报）**：`PanshalachChaser.solveIssue` 返回**形状**未变，但 `score` 语义经产品主批准收敛为验证锚定两值（成功=100/未成功=0），过程纪律打分器（TrajectoryScorer + 内联启发式）归档至 `archive/2026-09-05-scoring/`。success 闸门（≥80）与记忆 success 卡阈值（≥85）行为不变。
>
> **2026-09-05 二次申报**：score 字段已从 `solveIssue` 返回值/`RunResult`/`Trajectory` 中整体移除（0.6.3）——成败唯一由验证信号（`trajectory.success`）判定，记忆正向信号同步切换。
>
> **六次申报累计（0.6.4 R0 / 0.6.5 部署 / 0.7.0 终止语义重构 / 0.7.1 UI 手感 / 0.7.2 反思迭代 / 0.7.3 主链确定性）**：
>
> **① 0.6.4——R0 双层终止 + 三先决修复（commit 3db3422）**
> - 改动摘要：`TurnStopReason` 契约 v3.1（completed/verification-failed-continue/max-steps/consecutive-failures/aborted/no-verification）落 `types.ts`；`Trajectory` 增 `stopReason/continueCount/lastError`；新增外置判官 `src/loop/continuationJudge.ts`（未验证回合有界续跑 ≤2）；loop 层 end_turn 自然停；withRetry（429/5xx）/空批合成失败轨迹/count 翻倍修复/streamChat 透传。
> - 理由：产品主实测弱模型伪工具调用下循环不收敛 + 空响应 TypeError；终止语义需要显式契约承载。
> - 影响面：`src/cli/repl/types.ts`（TurnStopReason/Trajectory 契约，下游全员依赖）、`VerifyCritiqueLoop`、`PanshalachChaser`（solveIssue 返回形状不变）、记忆正向信号、测试 +14 例。
> - 验收证据：CHANGELOG「0.6.4 (R0：双层终止语义 + 三先决修复)」段（全套 542 例）。
>
> **② 0.6.5——部署落地（commit 8fad5e8）**
> - 改动摘要：npm link 全局部署（zhulong/panshalach bin，清理旧 `zorge` 孤儿 junction）；`modelSeed.ts` 配置播种（env 缺席时配置 `model` 字段兜底，接入 runOneShot/startRepl/sseInteractive/classicRepl 全入口）；ConfigManager 加载顺序修正（项目级 `.panshalach.json` 覆盖用户级 `~/.panshalach/config.json`）；`--approval <readonly|default|full>` / `PANSHA_APPROVAL` 审批通道（headless 不再锁死 readonly）；原生 function calling 请求侧（`CompleteOptions.tools` → `tools + tool_choice:auto` 两条请求路径透传 + `EngineAdapter.toolSchemas()`）；写工具全档位注册；格式教学按实际可用工具动态 few-shot；身份提示 CC 风格。
> - 理由：产品主"部署后无法唤起"排查暴露的配置播种/审批/请求侧缺口。
> - 影响面：`ConfigManager`/`modelSeed`（配置契约与加载语义）、四个 CLI 入口、`openai-compatible.ts`（请求参数）、TierConfig 消费面（写工具注册）、提示词层。
> - 验收证据：CHANGELOG「0.6.5 (部署落地：全局唤起 + 原生 function calling 请求侧 + 写工具全档位 + CC 风格提示词)」段（含验证边界如实记录）。
>
> **③ 0.7.0——终止语义重构：判官摘除 + 意图分类 + AbortSignal 贯穿（commit 106dae6）**
> - 改动摘要：continuationJudge 与 TestTimeOrchestrator 摘除归档 `archive/2026-09-05-removals/`（0.6.4 双层终止收缩为**单层**，回合上界 = 单次 maxSteps）；`Trajectory` 迁 `src/loop/trajectory.ts`（删 `continueCount`）；`TurnStopReason` 移除 `verification-failed-continue`、新增 `answered`（回合三态：completed/answered/no-verification）；记忆 refine/compact 成功卡信号收紧为 `stopReason==='completed'`（纯问答不进记忆）；新增 `src/cli/taskIntent.ts` 意图分类（chat 单次直答 / search 只读≤3步 / task 全循环 + `PANSHA_INTENT_GATE=0` 逃生门）；AbortSignal 贯穿 solveIssue→loop→complete/streamChat→engineAdapter/executor（Ctrl+C 真中止）；`estimatedUsedTokens` 按模型调用真实累计（修复恒 0）。
> - 理由：实测复现三症状——简单输入（"1"/"你好"）重复执行十几次 905s 不收敛；Ctrl+C 停不下来（网关持续 POST）；纯问答显示失败且答复被吞。判官是唯一外层续跑源，TestTimeOrchestrator 在恒单 rollout 后 count/sort/预算裁剪全为死路径。
> - 影响面：`src/PanshalachChaser.ts`（solveIssue 主体重写，返回形状不变、success 语义扩展）、`src/cli/repl/types.ts`（TurnStopReason 枚举二次变更——禁区再次触碰）、`src/memory/RefinedMemoryStore.ts`（refine 信号源）、`src/model/openai-compatible.ts`（signal 合并/TASK_ABORTED）、Repl/RunCommand/sseInteractive/runAgentTask（文案与透传）；测试增删改（Termination/taskIntent/withWriteLock 新增，ContinuationJudge/TwoLayerTermination/orchestration 两测试删除）。
> - 验收证据：CHANGELOG「0.7.0 (终止语义重构：判官摘除 + 意图分类 + AbortSignal 贯穿)」段——`npx tsc --noEmit` EXIT=0；`node --test --import tsx --test-concurrency=4` 545 例（544 pass + 1 skip + 0 fail）；`node verify-panshalach-cleanup.mjs` PASS（2026-09-05 收尾复验三项一致）；方案书 `docs/panshalach/FIX-0.7-TERMINATION.md`。
> - 遗留（如实申报）：fetch 发出后 abort 网关侧生成可能仍算完；bash 子进程强杀待 0.7.1；1B 端到端手测待做（`1`/`你好`/Ctrl+C/`hello.txt` 四路径，翟苑皓 F6）——均登记 ROADMAP-NEXT §3.2。
>
> **④ 0.7.1——UI 手感两批次 + backlog C/F/D 组（commits e88048a + 72bdf21）**
> - 改动摘要：批次 A（P0 信任级：Ctrl+C 全链路 / gerund 清行纪律 / 审批三连伤；P1 反馈级：真流式 / 工具实时卡片 / 结束总结块，+25 例 UI 单测）；批次 B（横幅 v2 / Tab 补全 + `?` 快捷面板 / 未知命令模糊建议 / `/help` 26 命令统一 / 模式徽标 + shift+tab / CJK 宽度治理 / 文案中文化 / 情境 tip）；C1-C8 技术债（记忆 200KiB 上限执行 / compact 先写盘 / FeatureTracker 告警 / walkFiles symlink 防御 / appendEvent auditStatus / Reviewer 探测执行两态 / bash abort tree-kill 跨平台归一）；F 组收尾（abort 传播 / answered 断言 / PromptBuilder intent 参数化）+ D1/D3 工程脚本。
> - 理由：REPL 手感病灶（12 项，对标 CC 2.1.88 解剖）+ backlog 审查技术债；方案 `docs/panshalach/UI-UX-REVAMP-0.7.1.md`。
> - 影响面：`sseInteractive.ts` 主体、`approval.ts`/`engineAdapter.ts`（事件透传）、`Reviewer.ts`/`bash.ts`/`walk.ts`/`compactService.ts`/`rolloutStore.ts`/`PromptBuilder.ts`；测试 545 → 625 例。
> - 验收证据：CHANGELOG「0.7.1」段——批次 A 后 570 例（569+1skip+0 fail）、批次 B 后 625 例（624+1skip+0 fail），tsc 干净，cleanup/protected-files PASS。
>
> **⑤ 0.7.2——反思迭代：意图前移接线 + 记忆落定主线版（commit ff6dce9）**
> - 改动摘要：4/4 入口（runAgentTask/Repl/RunCommand/SimulateCommand）在 buildForTask 之前对**原始输入**分类（chat 直答 / search 只读 ≤3 步运行时首次真正可达）；`finalizeTaskMemory` 单一落定点（completed 时 refine→save + injectedCardIds ∩ 轨迹写集 → markVerified，发 `memory.finalized` 事件，失败不影响任务返回）；集成测试 4 例先红后绿；SUBMISSION 定稿 + DEPLOY-CN 新建。
> - 理由：反思 8 维度审查——主线空心化（意图分类运行时未生效、记忆闭环 4 环只真 1 环）；方案 `docs/panshalach/REFLECTION-0.7.2.md`。
> - 影响面：四个任务入口（透传 intent）、`tests/integration/intentAndMemory.test.ts`（新增）；R1/R2 合同的窄口径实现（仅 runAgentTask 路径，Repl 直调三口待统一执行器）。
> - 验收证据：CHANGELOG「0.7.2」段——629 例（628+1skip+0 fail），tsc 干净。
>
> **⑥ 0.7.3——主链确定性（工作区，方案 `docs/panshalach/USABLE-PLAN-0.7.3.md`，13 项三梯队）**
> - 改动摘要：真实成功信号入册（engineAdapter 按 `res.ok`+工具类别确定性追加 `VERIFICATION: PASS/NEUTRAL` 尾标 + classifySignal NEUTRAL→PARTIAL / 裸 `EXIT_CODE:0` 尾部锚定——**completed 真机可达**、记忆闭环激活）；三入口审批/中断透传（`--approval full` one-shot 真实生效、classic 不再假中止）；中断现场落盘（aborted 回合写 session+rollout、保留已流出正文）；answered 空转防呆；窗口预算挂真值（未知回落 32768、`/model list` null 持久化、loop 超 70% 窗口裁中段）；finish_reason=length 防御；首跑报错质量；结果超阈值才剪（4000 阈值，头 2500+尾 800）；withRetry 5 次 + 传输类错误；写集提取修正则（引号内空格/Windows 盘符/tee）；'a' 决策持久化到项目配置；文档清漂 + package.json 0.7.0→0.7.3。
> - 理由：红队可复现探针实测出两个被 629 例绿灯密封的 P0（真实成功被误判失败、completed 真机不可达致记忆闭环死码）+ 文档主验证命令审批断链 + classic 假中止。
> - 契约影响（如实申报）：`Trajectory`/`Turn`/`RunResult`/`ModelClientOutput`/`CommandContext` 增**可选**字段（`partialText`/`truncated`/`approvalBridge`/`signal`/`windowTokens`）——全部加性，旧消费者不受影响；`solveIssue` 返回形状不变；`TurnStopReason` 枚举未变。
> - 验收证据：CHANGELOG「0.7.3」段——`npx tsc --noEmit` EXIT=0；`node --test --import tsx --test-concurrency=4 "tests/**/*.test.ts"` **663 例：662 pass + 1 skip + 0 fail**（2026-09-06，Windows/Node 22）。
> - 遗留（如实申报）：真机四用例待端点（F6，禁止预填 PASS）；Repl 直调三口 finalize 待统一执行器；MCP 工具结果无验证尾标；L 级六项（消息数组协议 / sseInteractive 拆分 / 会话树指针化 / subagent / hooks / 后台 bash）明确不进本轮——均登记 ROADMAP-NEXT §3.2。

> 本期已执行 A/B/C/D（见 REFACTOR 计划）；下述 P1–P6 为后续里程碑。

### P1 — openPangu 泛化接入（代码，边界清晰）
- `.panshalach.json`（内部名暂保留）示例新增：
  ```json
  "providers": {
    "openpangu": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8000/v1",   // 本机/昇腾 vLLM-ascend、MindIE 或 ModelArts 网关
      "apiKey": "EMPTY",                        // 本地网关常为 EMPTY；生产用真实 key
      "models": ["openPangu-1B", "openPangu-7B", "openPangu-7B-VL"],
      "modelContexts": { "openPangu-7B": 8192 }
    }
  }
  ```
  运行 `panshalach` 后 `/model list` 或 `PANSHA_MODEL=openpangu:openPangu-7B`（见下文存储名迁移前兼容名）。
- ✅ **已完成（2026-09-04）** `ModelProvider`：env 三件套 `PANSHA_<PROV>_API_KEY/_BASE_URL/_MODEL`（SCNET_* 为 scnet 历史别名）；bare-name 路由泛化；magic shorthand 已删（17851f9）。
- `ModelCommand`：`/model list` 改为遍历所有已配置 provider，逐个 `listProviderModelsWithContext`；缺省 fallback 优先非 scnet 的第一可用 provider。
- ✅ **已完成（2026-09-04）** `openai-compatible.complete`：解析 `message.tool_calls` 返回结构化输出（detectedFormat:'openai-json'），SSE delta.tool_calls 拼装；文本协议三路解析保留为兜底。`VerifyCritiqueLoop` 消费通道（`preParsedToolCalls`）零改动。
- 措辞泛化：`StructuredReasoner` 的工程纪律头（Read-Before-Write / Verify-Before-Claim / 标准格式 / 零幻觉不变）不绑定任何模型品牌；adapter 作为**严格 XML 解析器**由 tier + 模型能力联合决定（`strictStructured`）。

### P2 — 记忆写入闭环 + 使用语义（本次缺口修复核心）
- 在任务落定点调用 `RefinedMemoryStore` 提炼写盘：
  - REPL `Repl.executeTask` 完成分支；`runAgentTask` 成功/失败后；sseInteractive 回合落定。
  - 输入：`{ trajectory: bestTrajectory, taskStyle, applicableTiers:[tier], attemptCount, userFeedback: 末轮/用户显式反馈 }`。
  - 落盘：`store.refine(...)` → `store.save(cards)` → `invalidateProjection()`。
- ✅ **已完成（2026-09-04 bf5f4a7）**：`markInjected`（纯记账，runAgentTask 已挂接）/ `markVerified`（原位刷新 lastUsedAt+count+1，直写持久化）+ 衰减锚 max(lastSeen,lastUsedAt) + archived 过滤。剩余：markVerified 信号源接线（随本节 refine 闭环一起）。
- 验收：连续做 3 个同风格任务后 `/memory list` 自动出现教训/成功卡（无需 `/remember`）。

### P3 — 事件记忆 + 任务状态机 + 语义检索 v0
- **事件记忆**：在 `rolloutStore` 之上加语义事件层 `memory/events.ts`（append-only，字段：`ts / kind(decision|constraint|requirement|verified|failure|progress|preference) / topic / summary / detailPath / refs[] / sessionId`），写入由 P2 闭环与压缩补漏共用，`/memory events [--since] [--topic]` 可查；注入采用"近事件 + 高重要性 + 按任务 topic 命中"预算。
- **任务状态机**：演进 `FeatureTracker` → `TaskState`（跨多轮：原始需求(不可变的长期锚)、决策清单、未决问题、进度里程碑、已验证清单、风险）。每轮落定更新；注入优先级高于普通记忆卡（因为它直接防"中期遗忘导致决策偏离用户原始需求"）。
- **语义检索 v0（零依赖）**：字符 2-gram 词袋 + 余弦的本地索引 `memory/embed.ts`（对卡片 summary + 事件 summary 建索引，离线构建 ~O(n·k)）；L1 注入排序加一项 semanticScore；文档注明可选替换：国产向量库(Milvus-lite / Qdrant) 或 openPangu embedding，接口已留 provider 位。
- 这三点共同形成评估报告的"全能力（事件+状态+检索）"档位。

### P4 — openPangu 小模型适配（推理行为）
- openPangu-1B/7B 在长格式遵循/深推理上的短板 → 采取"外化状态 + 结构化记忆 + 低成本可验证动作"：
  - 加大记忆卡/事件/任务状态注入的结构化程度，减少对模型记忆窗口的依赖（把关键事实放到 prompt 而不是"指望模型记住"）。
  - 工具调用协议自适应：优先探测 OpenAI JSON tool_calls（openPangu 网关常见）；文本协议 loose 兜底；`<>` 严格格式只对明确声明支持的模型在高档位开。
  - Critique/验证频度按模型能力调低初始值并看门狗化，避免小模型长格式爆token。
- 提供 `taskStyle=maintenance` 场景 profile（软件工程长期维护的验证风格与失败模式）。

### P5 — 资源与软硬件亲和（昇腾/麒麟）
- 部署形态文档：昇腾 310P/910 推理(vLLM-ascend / MindIE) 或本机 CPU/GPU 小模型端点；NPU 显存与上下文预算估算表（1B ~4GB 内、7B ~16GB int8）；Kylin 桌面/服务器 OS 运行验证步骤。
- 推理优化面：`max_tokens`/温度在 `ModelCommand`/完整 `complete` 已透传；长上下文预算由 `PANSHA_CTX_WINDOW` 与 compact 触发阈值驱动；补一次"低档位高轮次长会话"成本核算演示。

### P6 — 存储名/env 全量迁移（品牌收尾，可与 P1 并行或之后）
- `.panshalach.json`→`.panshalach.json`、`.panshalach-memory.json`→`.panshalach-memory.json`、`~/.panshalach`→`~/.panshalach`、`PANSHA_*`→`PANG_*`；一次性迁移脚本(读旧写新 + 移动 sessions/rollouts/file-history/skills)。
- `PanshalachChaser.ts`→`Panshalach.ts`、`cli.ts` bin 文案、`src/cli/repl/commands/*` 文案扫尾；旧类兼容层已删除。

---

## 5. 评测基线设计（供效果评估报告 + 后续里程碑）

- **场景主线**：软件工程长期维护。演示集可取自本仓库/示例仓库：跨 30+ 轮"需求演进式"任务（早期需求约束 → 中段新增功能 → 尾部回归验证早期约束是否仍被遵守）、跨文件长文档关联修改、进程中断后 resume 续接任务状态。
- **维度与指标**：
  1. **中期信息保持**：将早期关键约束埋入多轮历史，随后在 1/5/15/30 轮处召回；指标 = 约束召回率 / 遵循率。基线 = 无记忆直连(只靠对话窗口，或强压缩后)。
  2. **跨文件/跨章节关联**：长文档 A 的约束在文档 B 中被正确引用执行；指标 = 关联命中率。
  3. **压缩后保持**：compact 触发前后对早期约束的保持（现策略 vs 加事件记忆后）。
  4. **任务状态续接**：中断 resume 后，模型对"进行到哪/未决项/下一步"的判断准确率。
- **对比档**：`无记忆基线(压缩窗口)` vs `记忆卡(现状)` vs `全能力(记忆卡+事件+状态+检索, P2+P3 后)`。
- **运行方式**：仅真实 openPangu（本机/昇腾 OpenAI 兼容端点），真实结果才写入 `docs/panshalach/EVALUATION.md`；不虚报离线/合成数据为真模型结果。评估报告需声明：模型版本、端点、上下文窗口、每档任务量、种子与成本。
- **复用点**：`TestTimeOrchestrator.runMultiple` 可封装"同任务开关记忆"的 A/B runner；scorer 侧加"约束遵守/召回"专用打分，而非沿用现有工程风格分。

---

## 6. 风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| 小模型(1B)在真实工具执行链上能力有限 | openPangu-1B 可能不足以做完整 agentic 循环 | 文档如实报告模型档位能力差异；主线以 7B 为主、1B 报低资源形态 |
| 评测成本/时长 | 真模型 30 轮×多任务 × 多基线 较贵 | 任务集控制在可复现的小集合(每档 5–10 任务)，上报成本与 token |
| 零依赖 vs 向量库 | 语义检索 v0 用字符 n-gram 余弦 | 接口抽象 + provider 位，后续可切国产向量库而不改注入层 |
| 存储名迁移破坏既有资产 | resume/branch/记忆文件路径变化 | P6 迁移脚本 + 读旧写新 fallback；文档标注兼容窗口 |
| 品牌/文档叙事与内部名长期不一致 | 代码注释仍 Panshalach | 本期可见层全改 Panshalach；内部名在 ROADMAP 里按 P6 排期收敛，注释标注"兼容别名" |

---

## 7. 本次重构执行边界回顾（已完成部分）

- **A** 本评估报告。
- **B** 物理删除 docs/ 下全部试点模型/30-rounds 旧文档与 docs/agents、.agents 过时流程元数据（保留 CHANGELOG.md/examples/scripts）。
- **C** 新写 `docs/panshalach/` 命题文档集（README 目录页 / ARCHITECTURE / MEMORY-DESIGN / EVALUATION / USER-GUIDE / ROADMAP），根 README 重写为 Panshalach 版。
- **D** 源码**可见层**改名 Panshalach（package/bin、欢迎语与提示符、模型身份串、server 文案、memory 管理器标题、tier 描述、/init 文档指针），**保留**内部存储名/类名/早期试点模型 adapter（P1/P6 排期）。

> 内部兼容名说明：`.panshalach.json`、`.panshalach-memory.json`、`~/.panshalach/`、`PANSHA_*` 环境变量、`PanshalachChaser` 类、旧类兼容层（已删除）、`pangu` bin 均为**内部存储/旧兼容名**，不影响对外品牌 Panshalach；迁移见 `docs/panshalach/ROADMAP.md` P6。
