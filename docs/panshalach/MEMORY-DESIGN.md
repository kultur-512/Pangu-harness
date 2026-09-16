# Panshalach 记忆模块设计

> 面向"长程上下文管理"的记忆增强层深挖。本文档描述记忆的数据模型、写入源、读取注入、维护策略，以及**已知差距 → 补齐路线**。
> 状态基线 **v0.8.8**：0.8.1 对抗性审计修复三大 S 级缺陷（产卡零信息 / markVerified 断链 / 通用卡永生）后，"证据门槛写入 → 二态使用语义 → 注入审计"链路完整闭环。

## 1. 设计总则

1. **外置优于内记**：关键事实外置到 prompt 预算（注入），不依赖模型记住 N 轮前的 token。
2. **事实与经验分离**：会话资产(回合/事件)记"发生了什么"，记忆卡记"该怎么做"(教训/经验/偏好)。
3. **注入是稀缺资源**：任何记忆都先过"卡级档位适用（`applicableTiers`，空=全档） + 参照文件交集 + 关键词相关性 + 预算"闸门再进 prompt。
4. **确定性维护**：衰减/合并/去重/容量/缓存全部确定性规则 → 可离线测试、可复现、不烧 token。
5. **写入闭环**：真实任务结束即提炼沉淀（含压缩补漏），记忆随使用生长。

## 2. 记忆的分层（长程 = 把"分层"做对）

| 层 | 载体 | 时间尺度 | 已实现/规划 |
|---|---|---|---|
| L0 会话内实时 | 轨迹/验证信号 | 单任务内 | 已实现（FailureMemory 轨道已摘除 2026-09-05） |
| L1 结构化记忆卡 | `.panshalach-memory.json`（failure/success/preference） | 跨会话（天~月） | 已实现 |
| L2 压缩摘要 | `[COMPACT]` 合成轮（模型摘要 + 逐轮 brief）；摘要正文经 PromptBuilder【历史压缩摘要】块注入 prompt | 长会话 | 已实现（注意与任务内"溢出截断"是两级机制：截断是确定性保首尾步 + 折叠标记、无摘要，压缩是摘要合成轮——0.8.2 起文案严格区分） |
| L3 事件记忆 | 语义事件流（decision/constraint/…） | 跨会话审计 | **已落地**（R4 `memory/events.ts`，0.6.5；AgentEvent 接线 11dbea3；`/memory events` 查询子命令未挂载） |
| L4 任务状态 | TaskState（原始需求/决策/未决/进度） | 跨多轮任务 | **已落地**（R5 `memory/taskState.ts`，0.6.5；运行时注入接线 11dbea3） |
| L5 语义索引 | n-gram 向量 v0 → 国产向量库/embedding | 检索 | **embed v0 已落地**（赵天昂，含单测）；L1 注入融合未接线 |

## 3. 数据模型

### 3.1 RefinedMemoryCard（src/memory/RefinedMemoryCard.ts）
见 [ARCHITECTURE.md §2.1](ARCHITECTURE.md)。要点：kind / category / memoryCategory(分类半衰期) / summary(建设性一句话；对话对卡为 'Q: …
A: …' 双行) / weight·count / lastSeen·firstSeen·lastUsedAt / applicableTiers(卡级档位适用，空=全档) / referencedFiles / pinned / status·mergedFrom / source（0.8.4：'dialogue-pair'=对话对卡） / confidence（0.8.4：写侧分类器定价，软惩罚只进排序） / factDate·factDateText（0.8.4 时间锚定：事实发生时间，区别于记录时间 lastSeen）。容量按 kind（failure 40·类内每 category 10 / success 10 / preference 80——chat-fact 同桶；pinned 免淘汰）·总200；半衰期 30d；`LESSON_TEMPLATES` 提供失败→建设性教训模板（"重要教训：… / 建议重点避免：…"）。

### 3.2 事件记忆（已落地 · R4，`memory/events.ts`；下为立项时规划 schema）
```ts
interface MemoryEvent {
  id: string;            // sha1(ts+kind+topic+sessionId)
  ts: number;            // 写入时间
  kind: 'decision'|'constraint'|'requirement'|'verified'|'failure'|'progress'|'preference';
  topic: string;         // 归一话题（用于注入命中）
  summary: string;       // ≤120 字
  detailPath?: string;   // 详细内容（轨迹文件/工作区相对路径）
  refs?: string[];       // 关联文件
  sessionId: string;
}
// 存储：append-only jsonl，追加式、可审计、崩溃容错（复用 rolloutStore 的 tolerant 读取）
```
写入点：P2 回合写闭环、压缩补漏、用户偏好、每轮 verify PASS/FAIL 摘要。注入：近事件 + 高重要性 + topic 命中，预算受限。

### 3.3 任务状态 TaskState（已落地 · R5 `memory/taskState.ts`，演进自 FeatureTracker；下为立项时规划 schema）
```ts
interface TaskState {
  featureId: string;
  createdAt: number; updatedAt: number;
  originalRequirement: string;   // 原始需求 = 长期锚（不可因轮次多而漂移）
  decisions: Array<{ ts; what; why; refs? }>;
  openQuestions: Array<{ ts; q; status }>;   // 未决项
  milestones: Array<{ ts; title; done; evidence? }>;
  verified: Array<{ what; how; when }>;      // 已验证事实清单
  risks: Array<{ ts; risk; mitigation? }>;
  nextStep?: string;
}
```
注入优先级高于普通卡（直接防"中期遗忘导致偏离用户原始需求"）。每轮落定更新 + 写入事件流。

## 4. 写入源

| 源 | 时机 | 产出 | 状态 |
|---|---|---|---|
| 循环实时信号 | 每步违规/失败 | ~~FailureMemory~~ 已摘除——收敛到回合提炼（信号源 B） | 已摘除（2026-09-05） |
| **回合提炼** | 任务落定（拿到 bestTrajectory + 验证成败 + attemptCount + 反馈） | refine→卡→save | **已实现（0.7.2）**：`finalizeTaskMemory` 单一落定点（runAgentTask result 前），覆盖 SSE/server/headless；Repl 直调三口留统一执行器收口 |
| 压缩补漏 | compact 移除轮次中验证成功（stopReason==='completed'，answered 不产卡） | success 卡（evidence=任务摘要，hash 去重） | 已实现（0.8.2 路径统一：compute 携带信号、apply 写盘成功后统一提炼——手动/后台自动同路径） |
| 用户 | /memory remember [--pin] / forget / import | preference/删除/批量 | 已实现 |
| 合并 | /memory merge 或后台 | 2-gram 同主题合并（原卡 archived） | 已实现 |
| 事件/状态 | P2/P3 各落定点 | events/TaskState | 已落地（R4/R5，0.6.5；运行时接线 11dbea3） |

## 5. 读取与注入（loadFiltered 全链）

```
用户任务文本 + 最近2轮(各60字)                                [0.8.5 查询构造：issue 双拼主导防稀释]
  → collectCurrentWorkspaceFiles(@path + 路径-like + 最近2轮)  [PromptBuilder]
  → 关键词提取(extractKeywordsFromIssue：ASCII 词走停用词表；CJK 标点切短句
    + 2-gram 词粒度 + 单位词白名单 + ASCII 段保留——中文无空格，整句作关键词
    曾致词面/语义双通道失效)                                    [0.8.5]
  → loadFiltered({
       tier, currentWorkspaceFiles?, keywords?, queryText?, semantic?   [0.8.4 混合检索]
     })
     ├─ 归一化旧卡(kind/memoryCategory/refs 默认补齐)
     ├─ taskStyle + tier 可见性(architecture 恒可见)
     ├─ P2-D 参照文件交集: referencedFiles ∩ currentFiles ≠ ∅ → 只留交集；空 → 回退
     ├─ 有效权重: pin=1 │ preference基0.6(对话对卡0.85) │ 半衰期(按类×count)
     │            │ 4段(1/.7/.4/.1) │ ×confidence 软惩罚(0.5+0.5×c，只进排序)
     │            → 出局门 0.3 用未惩罚基线(_effectiveBase)               [0.8.4]
     ├─ 关键词相关性 +1/命中(cap3；对卡 Q 侧命中 ×2)
     ├─ 混合排序: semantic 激活时 effN/relN 归一后与 cosine 融合
     │            (α=0.5，PANSHA_SEMANTIC_SEARCH=0 可关；keywords<2 且
     │             查询无 CJK / embed 异常 → 回纯词面 0.7·w+0.3·rel)      [0.8.4]
     └─ 窗口感知预算: min(窗口×10%(≤8K)/15%, 1600token) 内按渲染后实测
        token 贪心装入，张数上限 clamp[6,40]；PANSHA_MEMORY_LIMIT 显式时不变  [0.8.4]
  → 【相关记忆】注入(对卡双行渲染 Q≤160/A≤400；普通卡截120；[事实时间:…]
    标注；ghost余量提示)                                        [L1]
  → (standard/high 且非 chat) 探索期 auto-pull ≤5 张            [M3.2 overflow]
```

**Cached 变体** `loadFilteredCached`：filter 归一（0.8.5 起含 queryText 与 α）+ 30d decayStep 作 key，8 槽 LRU 投影缓存；任务内快照冻结、写入 invalidate 重建。

**注入形态（最终 prompt 片段）**：
```
【相关记忆】
（规则：记忆卡【】内的日期与[事实时间:...]标注的是事实发生时间；计算"多久之前/
  多少周"时用它与今天的差值，不要用其他时间戳。）
  - [失败教训] 重要教训：写入前应先完整读取目标文件…
  - [成功经验] 已验证可行的做法：修复 alpha 模块登录 bug …
  - [用户偏好] [事实时间:2023-11-01] 项目优先用 pnpm
  - [对话记忆] [事实时间:2023-05-21] Q: 我3月开始学法语，每周上两次课
    A: 已记录：你3月开始学法语，每周两次课…
（另有 3 张相关记忆未注入，/memory 查看）
```

> **时间锚定（0.8.4）**：显式区分三个时间——`factDate/factDateText`（记的是何时的事，写侧 sessionDate 透传，产品实时路径=当天）、`lastSeen/firstSeen`（何时记的，衰减语义不动）、`now`（消费者 prompt 注入"今天是 X"，`resolveToday()` 支持 `PANSHA_TODAY` 锚定）。stable 段与 chat directive 均注入今天行。

> **chat 直答出口（0.8.2 起）**：user = `getChatMemoryBlock()` + `【最近对话】`（最近 2 轮原文 ≤600 字符，0.8.5）+ 用户原话；auto-pull 溢出卡不进 chat 块（按意图门禁），注入账本只记实际可见卡。

**Cached 变体** `loadFilteredCached`：filter 归一 + 30d decayStep 作 key，8 槽 LRU 投影缓存；任务内快照冻结、写入 invalidate 重建。

**注入形态（最终 prompt 片段）**：
```
【相关记忆】
  - [失败教训] 重要教训：写入前应先完整读取目标文件…
  - [成功经验] 已验证可行的做法：修复 alpha 模块登录 bug …
  - [用户偏好] 项目优先用 pnpm
（另有 3 张相关记忆未注入，/memory 查看）
```

## 6. 维护策略（确定性）

- **衰减**：加载时算 effective，不写回（读不刷新鲜）。age 锚 = **max(lastSeen, lastUsedAt)**（接口契约 v3，2026-09-04 修复 `??` 短路——复发卡的 lastSeen 刷新此前对衰减不可见）。四段：age<half/2 → 1.0；<half → .7；<2half → .4；else .1。分类半衰期：failure/general 90d、implementation/insight 180d、architecture 365d；count≥2 半衰期×count（封顶 ×3）；基线：preference 0.6（对话对卡 0.85，0.8.4——修复对卡 effBase 踩 0.3 出局门被工程卡全面压制）；pin 冻结。**confidence 软惩罚**（0.8.4）：带 confidence 字段 ×(0.5+0.5×c)，**只进排序不进淘汰判定**——出局门 0.3 用未惩罚基线 `_effectiveBase`（惩罚进淘汰会把 0.4 置信卡在第一个衰减段就硬出局，'排序下沉'变'提前出局'）。
- **合并（M3.3a）**：active 且 effective≥0.5 的候选，2-gram 公共词元≥2 归组（组≤6）；合并 summary≤800、count=Σ、decayWeight 从 now 起算（防 Σcount 霸榜）；原卡 `status=archived` 软删（可回滚）。
- **容量**：按 kind 分桶——failure 40（类内每 category ≤10）/ success 10 / preference 80（chat-fact 卡 kind='preference' 同桶承载；pinned 卡免淘汰，非 pinned 竞争剩余名额）→ 总≤200（按 weight×count 淘汰）。2026-09-13 修缮：旧『按 category 每类≤10』使 success/preference/chat-fact（全部 category='OTHER'）互挤一个 10 张桶，80/200 声明不可达。
- **投影缓存**：多槽 LRU(≤8)，写操作 invalidate，跨衰减阶梯自动重建。
- **.gitignore**：自动追加记忆文件名。

## 7. 已闭环能力与开放差距

**已闭环**（过程细节见 CHANGELOG 对应版本段）：回合写入闭环（finalizeTaskMemory 单一落定点，覆盖 SSE/server/headless，Repl 三口经 U5 接线）；使用语义二态（markInjected 记账 / markVerified 保鲜，衰减锚 max(lastSeen,lastUsedAt)）；0.8.1 对抗性审计三修复（产卡携带任务信息 / markVerified 断链接通 / count 封顶 min(count,3)）；事件层 R4（`/memory events` 查询子命令已挂载）；任务状态机 R5（TaskState.record* 原语已补齐）。

**开放差距**（推进节奏见 ROADMAP-NEXT §B/C）：

| 差距 | 现状 | 补齐路线 |
|---|---|---|
| 语义检索仅 2-gram 词袋 v0 | embed.ts 已落（含单测）；L1 注入融合未接线 | R7/C4：接口留 provider 位，可插拔国产向量库 / openPangu embedding |
| 多级滚动摘要 | 现压缩 = 单次摘要 + 保 6 轮 + 补漏提炼卡 | R8：Turn.role 已就位，不对称分区压缩本体待做 |
| markCited（模型显式引用检测） | 注入已带 [M1] 编号 | 7B 引用实验 9/24 后 |
| 记忆审计 #4-#13 剩余项 | messages 分段 Repl/Simulate 接线、CJK 2-gram 增强、--classic finalize、prevEnvSnapshot 增量、档位契约对齐、磁盘压实 | ROADMAP-NEXT §B2 |
| 存储名/branding（P6） | `.panshalach-memory.json` 等内部名沿用 | 待 Leader 裁决迁移目标 |

## 8. 与评估指标的映射

| 评估维度（见 EVALUATION.md） | 由哪个记忆机制支撑 |
|---|---|
| 中期信息保持（早期约束多轮后仍遵守） | L1 卡 + L4 任务状态（原始需求锚）注入 |
| 跨文件/跨章节关联 | P2-D 参照文件过滤 + L3 事件 refs |
| 压缩后保持 | L2 压缩摘要 + 补漏提炼 + L3 事件（压缩不丢可归纳信号） |
| 任务状态续接 | L4 TaskState + rollout resume/branch |
| 记忆增长质量 | 写入闭环(P2) + 确定性衰减/合并防污染 |
