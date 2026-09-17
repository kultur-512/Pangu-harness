# EVAL-FEASIBILITY.md — 记忆与上下文管理评测可行性评估方案

> 目的：为 9/24 交付的评测环节提供**基准选型决策与落地方案**——在自建 T1-T5 消融之外，评估外部公认基准的接入可行性，确定"测什么、怎么测、测到什么程度"。
> 性质：决策文档（本方案评审通过后执行）；评测数据一律回填 [EVALUATION.md](EVALUATION.md) §4，本文不承载结果数据。
> 基线：v0.8.8 · 评测基建 `scripts/eval/{run-eval,smoke-eval,fill-evaluation}.mjs` 冒烟全过（A/B/C/C4 × mock）· **真机已接已跑**（2026-09-16：本机 LM Studio openpangu-embedded-1b-i1 完成 T1-T5 × A/B/C/C4 全量 20 runs；外部锚点 LongMemEval-90 完成，ZL×M3 strict 47/90 旗舰）。
> 调研日期：2026-09-12（状态注记 2026-09-16 更新）。外部基准信息源见文末链接。

## 0. 结论（TL;DR）

三层评测体系，9/24 前的投入排序：

| 层 | 内容 | 裁决 |
|---|---|---|
| **第一层：自建消融（主体）** | T1-T5 任务族 × A/B/C/C4 消融（`run-eval.mjs`） | **已跑（2026-09-16，20 runs 数据回填 EVALUATION.md §4）**——这是"记忆增强在工程 agent 场景的价值"的主证据，不替代 |
| **第二层：外部基准锚点（已做一半）** | ①LongMemEval-S 子集（对话记忆链路）②RULER 式有效窗口探测（openPangu 底座） | ①**已完成**：LME-90 六格矩阵（COMPARE-90.md，ZL×M3 47/90）；②**待做**：约 1-2 人日，换"在公认基准上验证"的答辩锚点 |
| **第三层：agent 记忆基准（登记不做）** | MemoryAgentBench / MemoryArena | 9/24 后：harness 适配成本超时间盒；登记 0.9 候选 |

差异化叙事分工：自建消融证明**工程场景记忆价值**（外部基准无对应物——烛龙的验证门槛写入/注入审计/血统账本在纯对话基准上没有施展面）；外部锚点证明**对话记忆链路的通用竞争力**。两层分开呈现，不混一张表。

## 1. 被测对象与约束（决定可行性边界）

| 约束 | 数值 | 对评测的影响 |
|---|---|---|
| 模型 | openPangu-1B / 7B（7B-VL 视端点） | 1B 仅跑快档；主结论立 7B |
| 有效上下文窗口 | 配置 8K-32K（未知回落 32768） | **full-context 基线在长会话上放不下或爆窗**——这正是记忆增强的必要性叙事（大模型评测中不存在的约束） |
| 端点 | OpenAI 兼容 /v1，tool_calls 原生优先 | 外部基准 harness 多为 Python 直连，可复用同一端点 |
| 时间盒 | ≤ 9/24（真机窗口最迟 9/17 开跑） | 外部接入总量 ≤ 3 人日；优先"数据集现成、改造最小"的基准 |
| 消融口径 | A=`PANSHA_NO_MEMORY=1` 零注入 / B=记忆卡 / C=全能力 / C4=语义检索 | 外部基准若接入，沿用同一 A/B 消融轴（统一口径，禁止另立） |

## 1.5 32K 窗口上限的执行口径（本机部署约束下的澄清）

本机端点最大可配 **32K** 上下文。这不构成评测障碍——三个层面分别澄清：

| 评测层 | 32K 是否够 | 口径 |
|---|---|---|
| **LongMemEval-S（116K 历史对话）** | **够** | 走 memory-based 设置：历史按 turn 顺序逐轮喂入 Session，每步窗口只装"stable 提示 + 记忆注入 + 当前轮"；旧历史由记忆卡提炼 + auto-compact（85% 阈值触发，血统账本保护）消化——**116K 塞不进 32K 恰恰是记忆增强的必要性论据**（塞得进就用 full-context 了）。compact 触发事件本身进 T5 过程指标。 |
| **RULER 式窗口探测** | **够** | 探测梯度 4K/8K/16K/32K——32K 是曲线终点。产物即"声称窗口 vs 有效窗口"，直接论证小模型上下文必然滚动丢失。 |
| **T1-T5 自建消融** | **需校准一处** | A 档"必须真溢出"（`run-eval.mjs` overflowWindow 合同）与端点窗口配置耦合：**T3 `document.md` 现仅 24.8KB（≈6-12K tokens），32K 窗口下不会溢出 → A 档整档落 not_applicable**。处置见下。 |

**T3 溢出校准（P1 前置任务，赵天昂/王浩宇）**：将 `tasks/T3/document.md` 扩充至 **60-80KB（≈20-30K tokens，约为 32K 窗口的 0.8-1.2 倍负载）**，加上提示组装开销即可在 32K 配置下稳定触发溢出；扩充内容保持同主题长文档结构（供 keyword 召回检查的分节不变，只加深干货密度）。同时 T1/T2 规模复核一遍（当前 2KB 级，在 32K 下本就不指望溢出——它们的溢出压力由 T3 独担，符合任务族设计分工）。若端点最终以更小窗口部署（如 1B 的 8K），fixture 规模按"目标窗口 × 1.5"重新校准——**校准脚本化（按窗口参数生成文档规模），禁止手调**。

## 2. 外部基准逐项可行性评估

### 2.1 LongMemEval（ICLR 2025）——**推荐接入（第二层首选）**

- **是什么**：500 题 × 六类问题，测五种记忆能力（信息抽取/多会话推理/时间推理/知识更新/**拒答 abstention**）；官方提供 LongMemEval-S（会话历史约 116K token）与 -M（约 433K）两档，含评测 harness 与数据集。
- **贴合度：高**。对话记忆公认"新金标准"（Mem0/Zep/Letta 均刷此榜）；其中**知识更新**（记忆过期后新旧事实冲突）与**拒答**（历史中不存在的信息应答"不知道"）两维度与烛龙记忆卡的衰减/未注入行为直接对应——**拒答维度是 1B 小模型幻觉问题的直接测试面**（真机已实证：1B 编造历史年代数据）。
- **接入成本：中低（约 1-1.5 人日）**。评测设置选 **memory-based**（agent 用记忆系统检索，非 full-context 塞窗）：把 LongMemEval 的多会话历史作为**多轮会话喂给烛龙**（经 Session/rollout 落盘 → 记忆卡提炼），问题作为任务提交，答案抽取后用官方判分脚本（LLM-judge + 关键事实匹配）。窗口不是障碍——历史进记忆链路而非上下文，**这本身就是叙事点**（full-context 在 8K 窗口放不下，记忆增强是必需品而非优化）。
- **裁量子集（9/24 内）**：不跑全量 500 题。按能力维度抽样 **50-100 题**（信息抽取 30 / 知识更新 30 / 拒答 30 ± 弹性），只跑 7B × A/B 两档；1B 视端点吞吐决定是否跑。
- **预期与诚实声明**：烛龙的证据门槛写入（completed 才产卡）在纯对话数据上**没有优势**（对话无验证信号），B 档成绩取决于注入检索质量——预期不及 Mem0 等专优系统是**正常且可解释的**，答辩口径为"通用链路竞争力锚点"，不与专优系统比排名。

### 2.2 RULER 式有效窗口探测（NVIDIA RULER 的自制简化版）——**推荐做（约 1 天）**

- **是什么**：RULER 用多针检索/多跳/聚合任务测模型"声称窗口 vs 有效窗口"（论文实证：部分模型声称 32K 实效如 4K）。官方全套为 Python 生成管线，**不必整接**。
- **自制方案**：合成 KV 针对脚本（~200 行）——在填充文本中埋 N 对"关键词-数字"针（100/500/2000 针 × 4K/8K/16K/32K 填充长度），直接打 openPangu 端点测召回率，画"声称窗口 vs 有效窗口"曲线。
- **为什么值得**：①一次性验证"未知窗口回落 32768 保守值"的设计是否有据；②给项目书提供"1B/7B 有效窗口远小于标称 → 上下文必然滚动丢失 → 记忆外置是必需"的**底座级证据**；③与 T3（长文档）互证。
- **裁决**：做。产出一图一表进 EVALUATION 附录。

### 2.3 LOCOMO（ACL 2024）——**不接入，仅作横向参照**

- 十段超长多会话对话（跨月/年），事实记忆行业标准。**不接的理由**：与 LongMemEval 测的是同一能力面（多会话事实 QA），而 LongMemEval 的能力维度更全（含拒答/时间推理）且 harness 更规范；二者取一即可。项目书引用 Mem0/Zep/Letta 公开成绩作竞品背景，不自测。

### 2.4 MemoryAgentBench / MemoryArena——**登记 9/24 后（0.9 候选）**

- **MemoryAgentBench**（HUST，arXiv 2507.05257）：四大记忆能力（精确检索/测试时学习/长程理解/冲突解决），增量多轮交互式，**唯一为带工具 agent 设计**——理论上最贴烛龙。不接的理由：Python harness 需要适配层（对接 headless runner 的 stdin/stdout 协议 + 会话注入），工作量 3-5 人日超时间盒；且其"记忆写入"假设是自由存取型（无验证门槛概念），消融轴对不齐。
- **MemoryArena**（Stanford，arXiv 2602.16313）：相互依赖子任务的多会话 agentic 任务，与 T4（中断续接/任务状态）最像——但任务实体与依赖结构不可裁剪，接入成本同类。登记 0.9：若 9/24 后做跨任务连续会话（M3 遗留项），届时以它验收。

### 2.5 其他（盘点性，均不接）

- **AMB**（agentmemorybenchmark.ai）：100K-10M token 级，与烛龙窗口约束不匹配。
- **ContextBench**：coding agent 上下文收集，社区性质无规范 harness——其"持久记忆为 coding agent 省 15-28% 成本"的公开结论可作为叙事佐证引用。
- **EvoMemBench**：自进化记忆视角，与烛龙"确定性维护"设计哲学相反，无对照意义。

## 3. 自建评测补充实验（零外部依赖，与第一层同批跑）

| 实验 | 做法 | 产出 | 支撑的创新点 |
|---|---|---|---|
| **注入-使用-保鲜过程图** | 从 rollout `context` 事件抽取 injectedCardIds → markVerified 序列，按任务时间轴可视化 | 一图：哪些卡被注入、哪些被真实复用、effective weight 变化 | 二态语义 + 注入审计（外部基准给不出的证据） |
| **记忆消融质询集** | 对 B 档跑对的题，检查注入卡与答案的证据链（答案内容是否来自卡） | 证据链命中率 | 注入审计的定性面 |
| **压缩血统实验** | T5 已有：压缩前后约束召回对比 + coveredTurnIds 覆盖核对 | 表 | 血统账本 |
| **成本对比** | 同题 memory-based vs full-context（放得下的题）token 成本/时延 | 表 | "小模型窗口下记忆是必需品"量化 |

## 4. 落地执行方案

### 4.1 阶段与人力

| 阶段 | 内容 | 人力 | 门槛 |
|---|---|---|---|
| P0（已过） | run-eval/smoke-eval 框架 + A/B/C/C4 消融 + schema | 已完成 | mock 冒烟全过 ✅ |
| P1（端点就绪即跑） | T1-T5 真机 A/B/C/C4（第一层主体） | 赵天昂+王浩宇 | 结果入 EVALUATION §4；mock 不入表 |
| P2（与 P1 并行准备，端点后 0.5 天跑） | RULER 式窗口探测脚本 | 赵天昂 | 一图一表 |
| P3（P1 数据出炉后接入） | LongMemEval-S 子集（50-100 题 × 7B × A/B） | 赵天昂 | 外部锚点表；判分用官方脚本 |
| P4（9/24 后） | MemoryAgentBench 适配（若做跨任务会话） | 待立项 | 0.9 |

### 4.2 LongMemEval-S 接入步骤（P3 展开版）

1. 拉官方数据集（HF `xiaowu0162/LongMemEval`）取 S 版；按能力维度抽样并冻结题目清单（防挑选偏差，抽样脚本入库可复现）。
2. 会话历史 → 烛龙多轮会话注入器：每段历史按 turn 顺序喂 Session（复用 rollout 落盘），落定走 finalizeTaskMemory（对话无验证信号 → 走 answered 口径，success 卡仅用户显式 remember——如实按现机制，不为此改造）。
3. 问题经 A/B 两档提交（A=`PANSHA_NO_MEMORY=1`）；答案抽取 → 官方判分（LLM-judge 用端点同模型时声明自评偏差）。
4. 结果表：能力维度 × A/B 两列 + token 成本列，入 EVALUATION 新增"外部基准锚点"节。

### 4.3 口径纪律（沿用 R6 合同，全文适用）

`injectedCardIds` 是唯一记忆存在性口径（memoryCardCount 仅存在性标志）；A 档零注入=防线失败不计有效样本；`promptChars` 不改写为 token；缺失填"—"不填零；mock 结果永不入真实表；LLM-judge 与被测模型同源时必须在表中声明。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 端点迟迟不就绪 → P1 全部阻塞 | P2 脚本先行（本地 LM Studio 可跑窗口探测）；LongMemEval 数据准备与抽样脚本不依赖端点 |
| 1B 在外部基准上成绩难看 | 预期内——1B 只报 T1-T5；LongMemEval 只立 7B；答辩口径"通用锚点非排名" |
| LLM-judge 自评偏差 | 优先用官方判分实现；同源模型判分时表内声明；关键题人工抽检 10% |
| 外部基准接入挤占自建消融时间 | 硬排序：P1 > P2 > P3；P3 仅在 P1 数据出炉且仍有 ≥5 天余量时启动 |
| T3 fixture 在 32K 窗口下不溢出 → A 档无效 | §1.5 校准任务：document.md 扩至 60-80KB 且脚本化生成；P1 开跑前必检 |

## 6. 与既有文档的关系

- 本文 = 评测**选型与可行性决策**；结果数据一律进 [EVALUATION.md](EVALUATION.md)（新增"外部基准锚点"与"有效窗口探测"两节，由 P2/P3 产出入座）。
- 执行排期并入 [ROADMAP-NEXT.md](ROADMAP-NEXT.md) §A1（R6 真机评测）的子步骤；未完成项追踪不另立清单。

## 参考链接

- LongMemEval：[论文 arXiv:2410.10813](https://arxiv.org/abs/2410.10813) · [GitHub xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval)（ICLR 2025）
- MemoryAgentBench：[论文 arXiv:2507.05257](https://arxiv.org/abs/2507.05257) · [GitHub HUST-AI-HYZ/MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench)
- LOCOMO：[论文 (ACL 2024)](https://aclanthology.org/2024.acl-long.747/) · [GitHub snap-research/locomo](https://github.com/snap-research/locomo)
- MemoryArena：[arXiv:2602.16313](https://arxiv.org/abs/2602.16313)
- RULER：[论文 arXiv:2404.06654](https://arxiv.org/abs/2404.06654) · [GitHub NVIDIA/RULER](https://github.com/NVIDIA/RULER)
- 行业参照：[Mem0 Research](https://mem0.ai/research) · [Letta 文件系统记忆基准实验](https://www.letta.com/blog/benchmarking-ai-agent-memory/) · [Mem0 State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
