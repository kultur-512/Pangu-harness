# 上下文管理与记忆系统：两种候选方案（2026-09-04）

> 目的：迭代现有 `RefinedMemoryCard + PromptBuilder + compactService` 体系，服务命题
> 《基于 openPangu 的记忆增强智能体架构设计与优化》（中期遗忘 / 上下文断裂 / 软件工程长期维护）。
> 约束：9/24 交付 MVP；4 主力 U1-U9 并行；505+ 测试全绿；零运行时依赖；评测只用真实 openPangu。
> 本文是**靶子**：供 3 个对抗批判 agent 攻击，两轮后收敛为实施方案。

---

## 方案一：渐进加固式（Incremental Hardening）

**一句话**：不动核心抽象，在现有记忆卡/注入/压缩骨架上补语义、补账本、补审计，全部向后兼容。

### 1.1 记忆卡语义修复
- `RefinedMemoryCard` 增加可选字段（兼容扩展）：`sourceEventIds?: string[]`、
  `evidence?: { command?: string; exitCode?: number; ts: number }[]`、
  `status?: 'active' | 'candidate' | 'superseded' | 'conflicted'`、`provenance?: SourceRef[]`。
- `markUsed(cardIds)` 拆三态：
  - `markInjected(cardIds)`：注入即记（事件 `memory_injected`），**不再**延长半衰期；
  - `markCited(cardIds)`：模型显式引用（`memory_cited`），count+1、刷新 lastUsedAt；
  - `markVerified(cardIds, evidenceEventIds)`：工具验证通过后确认（`memory_verified`），提升 confidence。
- `markUsed` 保留为 `markInjected` 的 deprecated 别名（兼容调用方）。
- 衰减规则微调：`count` 只由 cited/verified 驱动；注入不再影响衰减。

### 1.2 注入与预算
- PromptBuilder 单一 token 估算器（复用 `estTokens`），overflow memory 纳入同一账本；
- `injection_summary` 扩展为 `ContextSnapshot`：记录 `{ assetType, ids, tokenCount }[]` +
  prompt hash + model ctx window，每次任务落盘到 rollout（`context` 事件）。
- 注入顺序维持 `TaskState → 卡 → Event → 当前任务`（TaskState/Event 由 W3 交付，此处只留槽位与预算）。

### 1.3 压缩加固
- compact 摘要 prompt 改结构化 envelope：active task / decisions / files / verification /
  blockers / next step；`CompactResult` 记录 `coveredTurnIds` 与 `generation`。
- 后台压缩 apply 前校验 generation（snapshot 基于的 turn 数 vs 当前），不一致则只合并安全区间。
- 摘要失败保留旧快照并显式报告（现状静默吞掉）。

### 1.4 检索
- 保持关键词 + referencedFiles 硬过滤；新增同 hash 精确去重；
- n-gram 语义召回**推迟**到 U6 真实评测证明 lexical 不足后再加（消融档 C4）。

### 1.5 交付与验收（U1-U5 内）
- 新增测试：三态 mark、衰减不受注入影响、snapshot 记录、generation 冲突回退；
- 消融评测可用档：A（无记忆）/ B（卡）/ C（B+TaskState+Event）。

**优点**：风险最低；525 测试全兼容；9/24 前可完成；W2/W3/W4 分工不被打乱。
**缺点**：卡片仍是核心抽象，事实/经验/状态仍混居；冲突记忆只能 status 标记、无系统性消解；
长期审计依赖 rollout 事件的完备性（事件种类不全时无法回放）。

---

## 方案二：事件溯源式（Event-Sourced Context Plane）

**一句话**：AgentEvent 日志为唯一事实源，断言/状态/记忆卡全部是事件的派生投影，ContextCompiler 统一裁决。

### 2.1 事实源
- `AgentEvent`（types.ts 契约 v2 已落）扩展 rolloutStore 成**唯一**追加日志；
- 事件种类：user_requirement / decision / constraint / requirement / verified / failure /
  progress / preference / memory_retrieved / memory_injected / memory_cited / memory_verified / context_compacted；
- 一切写入点（任务落定、压缩补漏、用户 /remember、审批、验证）只产事件，不直接改状态。

### 2.2 派生投影
- **Assertion 提取器**（W3 事件层上）：事件 → 断言（subject/predicate/value/scope/
  confidence/status），evidenceEventIds 强制；冲突检测：同 subject+predicate 不同 value → `conflicted`。
- **TaskState = 事件折叠**：从事件流 replay 出 decisions/verified/risks/nextStep，
  持久化仅是缓存（`.panshalach-task.json`），可随时重建（originalRequirement 锁定首个 user_requirement）。
- **MemoryProjection**：lesson/preference/constraint/summary 四类投影替代广义"记忆卡"；
  现有 RefinedMemoryCard 变成 lesson+preference 的兼容视图（适配层）。
- 合并规则：同 hash 自动去重；同 scope+topic+polarity 才自动合并；其余只建 `relatedTo`。

### 2.3 ContextCompiler（替代 PromptBuilder 的选择职责）
- 流水线：scope 硬过滤 → validity/conflict 过滤 → 关键词+符号召回 → 融合排序
  （0.3 scope + 0.25 validity + 0.2 evidence + 0.15 relevance + 0.1 utility）→ 预算装箱 → ContextSnapshot。
- PromptBuilder 退化为"渲染器"：接收已选资产列表拼 prompt。

### 2.4 压缩
- 压缩=投影切换：原始轮永不删除，摘要是 `context_compacted` 事件 + SummaryArtifact
  （coveredTurnIds/level/sourceHash）；prompt 引用 artifact 而非 synthetic turn。

### 2.5 交付与验收（U1-U6 内）
- 新增模块：assertions.ts / taskState.ts（投影重建）/ contextCompiler.ts / summaryArtifact.ts；
- 消融评测可细粒度：C1=+TaskState、C2=+Event、C3=+摘要、C4=+检索。

**优点**：架构正确性最高；审计/可解释最强；冲突与有效性系统化；最贴命题"事件日志+任务状态管理"技术点。
**缺点**：工程量约为方案一的 2-3 倍；RefinedMemoryStore 适配层易引入回归；4 主力接口重构波及 W2/W3/W4；
18 天窗口内"重构未完、评测来不及"风险显著。

---

## 预设的决策维度（供批判 agent 打分）

| 维度 | 权重建议 |
|---|---|
| 9/24 前可完成且 505 测试不破 | 高 |
| 长上下文收益可被 A/B/C 评测证明 | 高 |
| 命题技术点覆盖（事件日志/任务状态/压缩/检索/结构化记忆） | 高 |
| 记忆语义正确性（注入≠使用、冲突、有效性、provenance） | 中 |
| 多模型源/小模型(1B)下的鲁棒性 | 中 |
| 团队并行不互相阻塞 | 中 |

---

# 综合草案 v2（第一轮批判后修订，待第二轮批判）

> 第一轮输入：记忆架构批判（12 条攻击，含行号证伪）+ 命题贴合批判（12 条攻击 + 覆盖度表）。
> 骨架裁决一致：**方案一为底盘**；方案二只保留"确定性可判定"的增量。

## A. 对第一轮攻击的逐条采纳

| 第一轮攻击 | 裁决 | 修订 |
|---|---|---|
| markCited 无检测通道（卡 id 从不渲染；1B 无法回显 hash；模板 summary 与 L0 撞车误报） | **采纳，砍** | 三态退二态：`markInjected`（纯记账，事件 memory_injected，不影响衰减/count）+ `markVerified`（机器判定）；`markUsed` 别名取消（零调用方） |
| markVerified 判定协议缺失 | **采纳** | 机器判定 = 任务内工具写入/验证过的文件集 ∩ 卡.referencedFiles ≠ ∅（确定性，无 LLM） |
| 真衰减 bug：`calculateEffectiveWeight` 的 `lastUsedAt ?? lastSeen` 短路，复发卡不保鲜（RefinedMemoryStore.ts:608） | **采纳，修** | 衰减锚改 `max(lastSeen, lastUsedAt)`；新增回归测试：复发 30 天卡 effectiveWeight 不降 |
| status 联合类型替换破坏 archived | **采纳** | 保留 `active/archived` 不动；conflicted 仅做未来展示级预留，不进本迭代 |
| 卡上 evidence/sourceEventIds 是悬空伪 provenance（卡在工作区、事件在 HOME） | **采纳，砍** | 卡不加引用字段；provenance 全部由 ContextSnapshot 事件承担 |
| Turn 落盘只有 `score=NN`，envelope 是幻觉生成器（sseInteractive.ts:733 等） | **采纳，前置修** | 先修上游：`Turn.result` 增结构化最小集（goal/changedFiles/verifyCmd/verified），summary 兜底仍兼容旧格式；envelope 只在结构化输入存在时启用，并记录 envelope 触发率 |
| `getRecentContext` 渲染 `score=score=85` | **采纳，修** | 渲染改 `t.result.summary` 本身（去重复前缀） |
| compact `applyCompactResult` 新增轮次被静默丢弃（compactService.ts:269） | **采纳，修** | generation 校验（snapshot 记录 removed+kept 轮次 id 集）；apply 时：旧 removed→摘要、旧 kept∪新增→全保留；`CompactResult` 记 `coveredTurnIds`；摘要失败显式报告不再静默 |
| 方案二冲突检测结构性缺陷（无 supersede、scope/时间维缺失、subject 归一未定义） | **采纳，砍** | Assertion 停留在 types.ts 契约（1.x 再立项）；本迭代不做抽取与冲突消解 |
| ContextCompiler 五项加权：量纲不同构、utility 恒 0、scope 双算 | **采纳，砍** | 检索维持 refs 硬过滤 + 关键词 + `0.7w+0.3rel`（有声明动机） |
| 方案二 HOME 事件日志不配当事实源；/forget 与 append-only 矛盾；全量 replay 延迟 | **采纳** | 事件定位为"审计账本 + TaskState 来源"；不做"原始轮永不删除"；事件读取带条数上限 |
| TaskState.version 乐观锁与纯派生矛盾 | **采纳** | version 字段保留在类型里但语义改为"重建序号"，不做事务锁 |
| C 档成分不在方案一交付内 → 消融塌缩 | **采纳** | TaskState/Event 明确进 C 档依赖清单，W3 交付物与本方案对齐；B 档加 memoryCardCount>0 会话占比指标防 B≡A |
| 向量检索"没做"在命题下不可接受 | **采纳** | C4（n-gram 语义）至少在 7B × T2/T3 跑通，正负数据都进 EVALUATION.md；EVALUATION.md §2.1 C 档口径先行改为"结构化过滤+关键词+可选语义扩展"，局限性一节声明 |
| SUBMISSION 创新点缺与 MemGPT/Letta/LangGraph/KG 三元组的差异声明 | **采纳** | 创新点各配一句差异化（强制证据链 evidenceEventIds + 可 replay + ContextSnapshot 审计） |
| 505/525/62 口径漂移 | **采纳** | 以 `npm test` 实际输出为准（当前 505+新增），全库统一 |

## B. 综合方案定稿形态（二态 + 显式事件 TaskState + 审计账本）

1. **记忆卡**：字段零破坏性变更；新增行为 = `markInjected`/`markVerified` 两方法 + 衰减锚修复。注入格式增卡号 `[M1] …`（为 7B 引用实验留通道，1B 忽略）。
2. **TaskState**（W3 owner，接口已定稿）：仅从显式事件折叠（任务落定/审批/验证/用户声明），工作区持久化、可重建、originalRequirement 锚定首个 user_requirement。
3. **ContextSnapshot**：每任务落一条 rollout `context` 事件（assets/ids/tokenCounts/promptHash）——消融评测"模型当时看见什么"的唯一证据源。
4. **compact**：generation + coveredTurnIds 修数据丢失；结构化 envelope 以上游 Turn 修复为前提；触发率进评测过程指标。
5. **检索**：lexical + refs + 0.7/0.3 不动；n-gram 语义为 C4 消融档（U6，正负皆报）。
6. **评测防线**：B 档 memoryCardCount>0 占比、envelope 触发率、事件抽取抽检（如启用）三个过程指标先于结果指标。

---

# 综合定稿 v3（第一轮三份批判全部并入；待第二轮批判）

> 相比 v2 的修订（来源：工程可行性批判 F1-F10/A1-A6/B1-B7）：
> 1. **count 驱动维持现状**（refine/merge/refineCompactSignals），本迭代不切换驱动源——A1 的"记忆静默消失窗口"风险。`markInjected` 仅记账（memory_injected 事件），`markVerified` API 落库但信号源（injectedCardIds 回链 + 工具写入文件集）仅在可用处接线，不强行全链贯通（F9 的 runAgentTask 改造列入 W2 认领项）。
> 2. **markCited 推迟**，但注入格式加卡号 `[M1] …`（零成本，为 7B 引用实验与评测观察留通道；1B 忽略）。
> 3. **衰减锚修复保留**（`max(lastSeen, lastUsedAt)`，修 `??` 短路 bug）——独立于 count 驱动，纯 bug fix。
> 4. **status 不动**（保留 active/archived），四值联合与卡上 evidence/sourceEventIds 字段全部砍掉。
> 5. **generation = (turnCount, lastTurnId) 二元组**；coveredTurnIds 进 CompactResult；**新增 resume×compact 一致性**：compact apply 时追加 rollout `compact` 标记事件，`replayInto` 消费之（修 F6：resume 恢复全量轮导致压缩失效/不一致）。
> 6. **ContextSnapshot 按任务落盘**（不按模型调用，B6）；复用 lastBuildMeta + injection_summary；`listRecent` 加扫描上限（有界化）。
> 7. **token 估算统一只做 PromptBuilder 内部账本**；不动 estimateSessionTokens/sseInteractive 的 0.85/0.95 阈值（A3 行为漂移风险）。
> 8. **注入顺序不改**（KV-cache 前缀稳定，A4）；TaskState 注入位（W3）建议放在 env/feature 之后、recent-context 之前，写进接口契约修订。
> 9. **评测防线**：B 档 memoryCardCount>0 会话占比、envelope 触发率两项过程指标先于结果指标；测试口径统一为 `npm test` 实际值（F3/命题批判）。
> 10. **U0 动作**：契约 v2（types.ts/rolloutStore.ts）随本迭代一起提交——消除 F2"冻结空中楼阁"风险。
>
> 实施范围（本次会话内落地）：衰减锚修复 + markInjected/markVerified API 与接线（可用处）+ [M1] 卡号 + compact generation/coveredTurnIds/显式失败 + score=score 渲染 bug + rollout `compact` 标记与 replay 消费 + context 事件类型 + 测试。
> 推迟清单（9/24 后）：markCited 全链、Assertion 抽取器、四类投影、ContextCompiler 独立模块、token 估算器跨文件统一。

---

# 终稿裁决（第二轮批判后，2026-09-04 深夜）

## 第二轮批判输入

- **架构视角（YES，附 3 条必修）**：compact 标记须自足（内嵌 synthetic turn/coveredTurnIds/generation/tokens）；apply 禁止从活体重切 kept；loadFiltered 必须过滤 archived（否则 merge 净增重复注入）；[M1] 编号须单一序列并与 lastInjectedCardIds 严格一致；envelope 触发率指标随 Turn 结构化一起推迟（已从 v3 指标中移除）。
- **命题视角**：C 档口径炸弹（EVALUATION.md §2.1/§6 已修）；B≠A 防线补 prompt-diff 展品 + T1 结果级差值 + A 档窗口必须真溢出；创新点重写（SUBMISSION 已按"每个 claim 指向已落地工件"原则改写）；T4 须一页 rubric（W3 认领）。
- **工程视角（GO/NO-GO 清单）**：N1 血统校验拒绝 apply、N2 generation 替换前定格、N4 兜底携带账本、N3 测试——**四条 NO-GO 全部已修并落测试**；D4-D7/D9-D14/D16/D19 列入已知遗留。

## 最终实现清单（本轮已全部落地，tsc=0 / 529 测试全绿 / cleanup PASS）

| 项 | 文件 |
|---|---|
| 衰减锚 max(lastSeen,lastUsedAt)（修 `??` 短路） | `RefinedMemoryStore.ts:656` |
| markInjected（纯记账）/ markVerified（原位刷新直写） | `RefinedMemoryStore.ts:414/432` |
| archived 卡退出注入 | `RefinedMemoryStore.ts:318` |
| [M1] 卡号单一序列 == lastInjectedCardIds 顺序 | `PromptBuilder.ts:396/443/491` |
| score=score 双前缀修复 | `PromptBuilder.ts:617` |
| CompactResult + generation/coveredTurnIds/summarySource/syntheticTurn；apply 安全合并 + N1 血统拒绝 + N4 兜底账本 | `compactService.ts` |
| rollout `compact`/`context` 事件 + replay 消费 + readAgentEvents/readContextSnapshots（有界）+ listRecent 扫描上限 | `rolloutStore.ts` |
| runAgentTask：逐任务 ContextSnapshot + memory_injected 事件 + markInjected 双账本对齐 | `runAgentTask.ts` |
| 回归测试 12 条 | `MemoryMark.test.ts` / `ContextMemoryV3.test.ts` / 旧衰减分段测试按 v3 语义更新 |

## 已知遗留（记录在案，不阻塞本次提交）

1. markCited 全链（7B [M1] 引用实验）→ 9/24 后；仪器已就位。
2. Turn.result 结构化最小集（goal/changedFiles/verifyCmd/verified）→ W 层认领项（半天）；compact 结构化 envelope 在其之后启用。
3. rewind 事件 replay 消费（D10）→ 与 rewind×compact 交叉语义一起立项。
4. ContextCompiler 独立模块 / Assertion 抽取器 / 四类投影 / token 估算器跨文件统一 → 9/24 后；Assertion 契约保留在 types.ts。
5. sseInteractive 的 ctxUsedChars 累加 estTokens(prompt) 一行修 → W2 认领（涉及跨层接线）。
6. 双 synthetic 幂等（D6）/ synthetic id 随机后缀（D7）/ listBranches O(N²)（D14）→ 低危，随 P6 评测工程一起处理。

## 评测防线（进 U4-U6 评测设计）

- B 档 memoryCardCount>0 会话占比（防 B≡A 假阴性）；
- context 事件自动生成 A/B prompt diff 展品（近零成本、答辩"眼见为实"）；
- T1 × 7B × A/B/C 最小 9 runs（唯一结果级差值证据，脚本断言无人工评分）；
- A 档任务设计必须真溢出窗口（收窄窗口或长轮填充），否则 A≡B 评测失效；
- 压缩完整性双证据：coveredTurnIds 零丢失确定性测试（已有）+ T5 一次 7B 强制 compact 实跑日志。
