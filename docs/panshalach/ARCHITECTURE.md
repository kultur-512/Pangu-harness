# Panshalach 架构设计文档（命题提交物 1 · 雏形）

> 华为命题：基于 openPangu 系列模型，构建具备长程上下文管理能力的记忆增强智能体。
> 本文档对应命题交付要求：**最终系统架构 / 记忆模块设计 / 训练方案 / 推理流程 / 资源消耗 / 核心创新点**。
> 状态：架构以现有可运行工程为基（自动化测试以 `npm test` 实际输出为准），标注"已实现 / 规划"；真机 openPangu 验证数据见 [EVALUATION.md](EVALUATION.md)。

---

## 0. 摘要

Panshalach 是一个 **记忆增强的软件工程长程维护智能体**：以 openPangu-1B/7B/7B-VL（昇腾/本机 OpenAI 兼容端点）为推理底座，把传统 agent 的"一次性对话窗口"升级为四层记忆保持体系——

1. **会话内状态**（回合轨迹 / 验证信号，实时纠偏）；
2. **结构化记忆卡**（跨会话提炼的教训/经验/偏好，分档注入、衰减与合并）；
3. **上下文压缩与会话资产**（长会话可 resume/branch，压缩保留关键摘要）；
4. **事件记忆 + 任务状态**（规划）：语义化业务事件流与跨多轮任务状态机，直击"中期遗忘 / 上下文断裂"。

在真实业务场景"软件工程长期维护"上，它表现为：早期需求约束在多轮演进后仍被遵守、跨文件修改不丢失关联、中断后能准确续接进度。

---

## 1. 系统分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│ 交互/服务层                                                       │
│   REPL（行模式/富 TTY） · SSE 服务（/api/run） · one-shot CLI      │
│   会话资产：rollout jsonl(resume/branch/undo/rewind) · usage      │
├──────────────────────────────────────────────────────────────────┤
│ 提示工程层 (PromptBuilder)                                         │
│   身份 → L0硬约束(≤3) → tier契约 → 铁律/负向工具清单 → 项目验证块    │
│   → L1记忆注入 → 环境增量 → 最近上下文 → 当前任务 → 压缩            │
│   （注入去重 / token 预算 / 档位差异化 / 参照文件过滤）               │
├──────────────────────────────────────────────────────────────────┤
│ 记忆增强层                                                        │
│   记忆卡 store（failure/success/preference + 类别分档 + 衰减+合并）  │
│   会话资产/事件日志(rollout jsonl → 事件记忆[规划])                 │
│   任务状态跟踪(feature_list → 任务状态机[规划])                     │
│   语义检索[规划]: 字符n-gram v0 → 国产向量库/embedding 可插拔        │
├──────────────────────────────────────────────────────────────────┤
│ 执行循环层 (taskIntent → solveIssue → VerifyCritiqueLoop)          │
│   意图分类(0.7)：chat 单次直答 / search 只读≤3步 / task 全循环      │
│   单次 loop.run——判官/TestTimeOrchestrator 已摘除(0.7.0 归档)       │
│   思维链阶梯 → 工具调用(三路解析) → 验证信号(PASS/FAIL)             │
│   铁律: Read-Before-Write / Verify-Before-Claim / 可回滚           │
│   回合三态: completed(真实验证PASS) / answered(end_turn有正文)      │
│     / no-verification(空白空转)；另有 max-steps/连错上限/aborted    │
│   AbortSignal 贯穿: solveIssue→loop→complete→fetch/executor        │
│   budget 软限(token 按模型调用真实累计) / 每步轨迹采集              │
├──────────────────────────────────────────────────────────────────┤
│ 工具引擎层                                                        │
│   read_file glob grep bash write_file edit_file diff             │
│   （LCS diff + 原子写 + RBW 护栏 + 脱敏）                          │
│   审批：readonly/default/full + allowlist + MCP stdio             │
├──────────────────────────────────────────────────────────────────┤
│ 模型接入层                                                        │
│   ProviderRegistry(openai-compatible) → openPangu                │
│   streamChat / complete / /models；原生 tool_calls 透传            │
│   (detectedFormat:'openai-json'，SSE 增量拼装)为主路径，            │
│   文本协议/<>严格 三路探测为兜底                                     │
└──────────────────────────────────────────────────────────────────┘
          ▼ 推理底座
   openPangu-1B / 7B / 7B-VL
   （昇腾 MindIE / vLLM-ascend · 本机 OpenAI 兼容端点 · 麒麟/其他国产 OS）
```

**各层职责一句话**
- 模型接入层：把"用什么模型、走什么格式"与上层解耦 → **openPangu 可替换，无需动记忆/循环**。
- 工具引擎层：真实执行 + 审批 + 护栏 = agent 的"手"，也决定哪些信号能被记录为可验证事实。
- 执行循环层：agent 的"脑 + 自我复盘"，每步产出轨迹/验证信号（长程记忆的素材）。0.7.0 起单层终止（判官/TestTimeOrchestrator 摘除）：单次 loop.run + 回合三态（completed/answered/no-verification），AbortSignal 可贯穿中止。
- 记忆增强层：agent 的"长期记忆"——把跨会话经验、压缩摘要、事件、状态外置到 prompt 预算里，不依赖模型窗口记忆。
- 提示工程层：记忆注入的"闸门"——按档位与预算决定每轮把多少记忆呈现给模型。

---

## 2. 记忆模块设计（重点）

### 2.1 记忆卡 schema（已实现，`src/memory/RefinedMemoryCard.ts`）

| 字段 | 含义 | 作用 |
|---|---|---|
| `kind` | failure / success / preference | 注入标签（[失败教训]/[成功经验]/[用户偏好]）与衰减基线 |
| `category` | FailureCategory（幻觉/验证/RBW/命令失败/状态不符…） | 失败模式归因（success/preference 用 OTHER） |
| `memoryCategory` | architecture / failure / implementation / insight / general | **档位可见性** + 分类半衰期（arch 365d > impl/insight 180d > failure/general 90d） |
| `summary` | 一句话建设性摘要 | 注入文本（截 120 字符） |
| `weight/count` | 基础权重 / 触发次数 | 合并去重与升权；count≥2 → 半衰期×count |
| `lastSeen/firstSeen/lastUsedAt` | 时间戳 | 四段阶梯衰减（1/0.7/0.4/0.1） |
| `applicableTiers` | 适用档位 | tier 过滤 |
| `referencedFiles` | 相关文件路径 | **P2-D 参照文件交集过滤**：只加载"本任务将触碰文件"相关的卡，命中为空回退全量 |
| `pinned / status / mergedFrom` | 冻结衰减 / 软删除 / 合并溯源 | 偏好 pin、同主题合并可回滚 |

容量：单类 ≤10、总 ≤200；默认落盘 `<workspace>/.panshalach-memory.json`（内部名，见 ROADMAP P6 迁移）。注入时经 8 槽投影缓存（任务内快照冻结、写入失效重建）。

### 2.2 记忆写入（提炼 → 保存）
- ~~**信号源 A（循环实时）**：FailureMemory 会话内即时纠偏~~ → **已摘除**（#6，2026-09-05，archive/2026-09-05-removals/）。失败/成功信号唯一归口 = 信号源 B/C。
- **信号源 B（回合闭环，规划落地 P2）**：任务落定后把 `bestTrajectory` + `attemptCount` + 用户反馈交给 `RefinedMemoryStore.refine()`（失败信号抽教训卡；一次通过且**验证通过（trajectory.success）**或正向反馈 → success 卡），`save()` 合并去重写盘。→ 修复"现在没有任何生产路径调用 refine 的缺口"。（score 已移除，2026-09-05）
- **信号源 C（压缩补漏，已实现）**：`compactService` 把被移除轮次中**验证成功（result.success）**的信号确定性补提为 success 卡，evidence 取该轮任务摘要（hash 去重，防双重计数）。（score 已移除，2026-09-05）
- **用户显式（已实现）**：`/memory remember [--pin]` / forget / import / export / clear / merge。

### 2.3 记忆读取与注入（loadFiltered，已实现）
1. 归一化旧卡（无 kind 默认 failure，无 memoryCategory 默认 general）。
2. 过滤：任务风格匹配 → tier 可见性（architecture 始终可见；quick 仅 failure；standard 加 implementation；high 加 insight；max/ex/pangu 全量）。
3. **参照文件交集过滤**（提供 currentWorkspaceFiles 时）：只保留 referencedFiles 与当前相关文件有交集的卡；空则回退全量（不"无卡可用"）。
4. 有效权重：kind 基线（preference 0.6 / 其余 1.0）· pin 冻结 · 分类半衰期×count · 4 段因子；`effective < 0.3` 丢弃。
5. 相关性：任务关键词命中 summary +1（cap 3）；排序 = 0.7×权重 + 0.3×相关性，再按 count。
6. 数量：档位 3/6/8/10；preference 保留 1 席位。L1 之外 standard/high 可探索期自动拉取 ≤5 张、预算 ≤700 token（ghost 提示余量去 `/memory` 看）。

### 2.4 已知差距与补齐路线（详见 MEMORY-DESIGN.md）
| 缺口 | 补齐（里程碑） |
|---|---|
| 无回合写入闭环（refine 无生产调用点） | P2：任务落定调用 refine+save（markInjected/markVerified 已落地，见 bf5f4a7） |
| 无语义检索（仅 keyword 子串） | P3：字符 2-gram 词袋余弦 v0 → 国产向量库/openPangu embedding 可插拔 |
| 无业务事件层（rollout jsonl 是回合级） | P3：语义事件流（decision/constraint/requirement/verified/failure/progress） |
| 无跨轮任务状态机 | P3：TaskState（原始需求长期锚/决策/未决/进度/已验证），防决策偏离原始需求 |
| 一次性摘要（非多级滚动） | P3：粗粒度长期 + 结构化中期 + 逐字近期 |
| ~~loadFiltered 不刷新 lastUsedAt 且无 markUsed~~ | ✅ 已修复（接口契约 v3）：二态 markInjected（记账）/markVerified（保鲜）+ 衰减锚 max(lastSeen,lastUsedAt) + archived 过滤 |

---

## 3. 推理流程（回合 → 注入 → 执行 → 验证 → 提炼写回）

```
用户输入 / 任务队列
  │
  ▼ 意图分类（src/cli/taskIntent.ts · 0.7；PANSHA_INTENT_GATE=0 逃生门）
    chat（问候/纯问答）→ 单次 complete 直接回答：不进循环、不灌格式教学
        与工具 schema → stopReason='answered'，正文呈现给用户
    search（文件宾语无动词）→ 受限只读循环：≤3 步、强制 readonly、禁写
        禁 bash；搜到报告位置与概要，搜不到询问用户具体用意
    task/execution → 完整验证循环（↓ 主路径）
    meta（/命令、r/s 前缀）→ 不进 agent
  │（task/execution 主路径）
  ▼ PromptBuilder.buildForTask
  身份(openPangu 记忆增强) · L0 · tier约束 · 铁律/负向清单 · 项目验证块
  L1 记忆卡注入(参照文件/关键词/tier 过滤 + 预算) · skills · 当前特性
  最近上下文(3轮) · 当前任务 → 一条"带记忆"的初始 prompt
  │
  ▼ PanshalachChaser.solveIssue（0.7：单次 loop.run——判官与
    TestTimeOrchestrator 已摘除 archive/2026-09-05-removals/，
    空批保护并入 chaser；Phase 探索/锚点注入已摘除——记忆注入承担
    "仓库我知道什么"）
    VerifyCritiqueLoop 迭代：
        思维链(think/plan/verify) → 工具调用(三路自适应解析)
        → 真实执行+审批 → 验证信号(PASS/FAIL)
        （critique/FailureMemory 轨道已摘除 archive/2026-09-05-removals/；
        多 rollout / early-stop 预算裁剪随 TestTimeOrchestrator 退场；
        score 已整体移除——成败由验证信号判定）
        终止（单层，无判官续跑）：PASS+end_turn → completed /
        end_turn 有正文 → answered / 空白空转 → no-verification /
        max-steps / 连错上限 / signal abort
    budget 软限：estimatedUsedTokens 按每次模型调用累加（0.7 修复恒 0）
  │
  ▼ 任务落定（回合写闭环 · P2 规划）
    refine(信号=stopReason==='completed' + attemptCount + 反馈) → save → invalidateProjection
    （0.7 记忆信号收紧：纯问答/闲聊 answered 不产生 success 卡）
    会话 addTurn + rollout append + (需要时)后台预压缩
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

1. **记忆写入闭环 + 使用语义二态**：回合结束自动提炼写盘 + `markInjected`（注入仅记账，不保鲜）/`markVerified`（机器判定的真实使用才刷新，修"读即用永不衰减"）——记忆会随真实任务生长，且不把"被看见"误当"被使用"。
2. **分档记忆注入预算**：六档强度(quick→pangu)把记忆加载量、衰减、探索深度、并行度做成可量化行为契约；轻档省 token、高档全量。
3. **参照文件交集过滤（P2-D）**：不是"什么都注入"，而是按"本任务实际触碰的文件"只载入相关记忆，命中为空自动回退——精准防上下文污染。
4. **确定性记忆维护**：四段阶梯衰减 × 类别半衰期、同主题 2-gram 合并(原卡归档可回滚)、容量上限、投影缓存快照——离线可测，不依赖 LLM 判断记忆要不要留。
5. **上下文压缩 + 补漏提炼**：压缩不只丢历史——被移除轮次中的成功信号被确定性地补提为记忆卡(hash 去重)，压缩反而成为记忆沉淀入口。
6. **事件日志 + 任务状态 + 会话资产**（规划里程碑补齐）：追加式语义事件、跨轮任务状态机、resume/branch——把"长周期持续跟踪"做成可审计、可续接的资产。
7. **国产软硬件亲和**：模型层为 OpenAI 兼容抽象 → openPangu on 昇腾(MindIE/vLLM-ascend)/本机端点即插即用；工具协议三路自适应探测让模型格式差异不再是接入门槛。

---

## 7. 下一步（按 ROADMAP.md）

P1 openPangu 泛化接入（✅ env 三件套/tool_calls 透传已落地）→ P2 记忆写闭环（✅ 使用语义二态已落地，refine 调用点待接）→ P3 事件记忆+任务状态机（类型契约已落 types.ts）+语义检索 v0 → P4 小模型适配 → P5 昇腾/麒麟资源亲和文档 → P6 内部存储名迁移收口。真机评估数据持续回填本文档与 EVALUATION.md。真机评估数据持续回填本文档与 EVALUATION.md。
