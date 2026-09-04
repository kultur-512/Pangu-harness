# 长上下文与记忆管理设计审查报告

branch: `feature/zhaiyuanhao`
owner: zhaiyuanhao（翟苑皓 / claude-code）
status: READY-FOR-REVIEW
reviewed: 2026-09-04

## 1. 审查范围

本报告审查以下内容：

- Pangu 当前计划：`WORK-PLAN-2DAY-UNITS.md`；
- Pangu 路线和设计：`docs/panshalach/ROADMAP-NEXT.md`、`MEMORY-DESIGN.md`、`ARCHITECTURE.md`、`EVALUATION.md`、`REFACTOR-ASSESSMENT.md`；
- Pangu 现有运行时：`RefinedMemoryCard/RefinedMemoryStore`、`PromptBuilder`、`compactService`、`Session/SessionStore/rolloutStore`、trajectory 与评测脚本；
- 参考项目：`P:/MY_codes/learn-harness-engineering-main` 中的 harness-creator 设计、状态模板、session handoff、context engineering 和项目示例。

## 2. 结论摘要

**方向贴合，但当前设计不能把“记忆卡”视为完整记忆系统。**

Pangu 的路线确实围绕长交互、多轮任务、长文档、持续状态跟踪和中期遗忘展开。现有代码也已经具备持久化记忆卡、会话资产、resume/branch、单次 compact、分层注入和工具验证等运行时基础。

但是，计划把以下不同性质的信息压缩在同一条 `Trajectory → MemoryCard → Prompt` 链中：

- 稳定项目事实；
- 当前任务状态；
- 用户偏好；
- 每轮事件；
- 验证结果；
- 失败经验和成功经验。

这会导致事实有效性、经验复用、状态恢复和 prompt 优先级互相污染。建议保留 `RefinedMemoryCard`，但将其重新定位为**由事件、断言和任务状态派生出的 prompt 投影**，而不是唯一事实源。

### 评级

| 维度 | 判断 | 说明 |
|---|---|---|
| 长上下文/记忆方向 | 通过 | 目标、场景和模块均对齐命题 |
| 现有运行时基础 | 基本通过 | memory/session/compact 已有真实实现 |
| 记忆语义可靠性 | 需修订 | 卡片职责过宽，可信度、有效性、热度未分离 |
| 跨 session 状态恢复 | 需修订 | snapshot、rollout、handoff 尚未统一 |
| 正式能力评测 | 不通过 | A/B/C runner、T1-T5 和真实结果尚未形成闭环 |

## 3. 参考 learn-harness-engineering 的有效设计

参考项目不是完整的自动 memory runtime，而是“课程文档 + harness 模板 + 可运行示例”。它最值得借鉴的是状态边界和生命周期，而不是照搬人工日志。

### 3.1 仓库作为 system of record

相关资料：

- `skills/harness-creator/SKILL.md`；
- `docs/en/lectures/lecture-03-why-the-repository-must-become-the-system-of-record/index.md`；
- `docs/en/lectures/lecture-05-why-long-running-tasks-lose-continuity/index.md`。

其基本原则是：新 session 不应依赖聊天历史，而应从仓库中的指令、状态、验证证据和交接文件恢复。`AGENTS.md/CLAUDE.md` 只保存地图和不变量；详细知识按需加载。

### 3.2 状态、决策、交接分离

模板：

- `skills/harness-creator/templates/feature_list.json`：机器可读的 feature 状态、依赖、验证步骤和证据；
- `skills/harness-creator/templates/progress.md`：当前状态、已完成、进行中、风险、决定、验证证据和下一步；
- `skills/harness-creator/templates/session-handoff.md`：跨 session 的最小恢复信息；
- `skills/harness-creator/references/memory-persistence-pattern.md`：instruction memory、auto-memory、session extraction 和 bounded index。

它明确把“做了什么”“为什么这样做”“如何证明完成”“下一步是什么”分开放置。这个边界比把所有内容放入自然语言摘要更能抵抗 compaction 丢失。

### 3.3 bounded index + 按需展开

`memory-persistence-pattern.md` 和 `context-engineering-pattern.md` 提出：常驻上下文只放有界索引或短摘要，主题详情写入独立文件，需要时再加载；上下文操作分成 `SELECT / WRITE / COMPRESS / ISOLATE`。

可借鉴的原则：

1. 启动时只加载有界 bootstrap；
2. 细节使用主题、文件、任务和状态按需检索；
3. 压缩前先保存结构化 checkpoint；
4. context reset 依赖持久化状态，不依赖一次 LLM 摘要；
5. 失败时保留 cursor 和原始信息，不静默覆盖。

### 3.4 必须保留的批判

learn 项目中的 compaction、自动 extraction、embedding 和 session replay 多数停留在设计模式或教学示例层，不应被误称为已经验证的运行时能力。它的文件化状态也依赖 agent/人遵守流程，不能替代 Pangu 的自动生命周期钩子。

因此推荐“learn 的结构化状态 + Pangu 的自动事件和运行时注入”，而不是复制一套手工 `progress.md` 负担。

## 4. 对 Pangu 现有设计的对抗性审查

### 4.1 记忆卡职责过宽

`RefinedMemoryCard` 同时承载 failure、success、preference，并计划进一步承载事件、事实、任务状态和约束。不同信息的失效规则不同：偏好通常由新偏好覆盖；当前 next step 快速过期；架构约束需要版本和证据；事件必须追加不可变；失败经验允许衰减但不能无证据升级。

**结论：不要继续向卡片增加字段来解决领域混合问题。应拆成不同实体，并让卡片成为投影。**

### 4.2 `weight × decay × count` 不能代表事实可信度

时间新鲜度、注入优先级、事实可信度和未来效用不是同一个维度：

- 新近使用的低价值卡不一定比旧的架构约束重要；
- 错误信息可以被重复命中而不断升权；
- 长时间未用的有效约束不应自动失效。

建议分离：

```text
priority   = prompt 资源优先级
confidence = 证据支持的可信度
validity   = 当前是否适用
utility    = 历史结果显示的未来效用
freshness  = 时间/使用新鲜度
```

时间衰减最多影响 `priority/freshness`，不应单独决定 `validity`。

### 4.3 `markUsed` 不能把“注入”当成“使用”

计划中的 `PromptBuilder` 注入卡片后调用 `markUsed`，最多证明卡片进入了 prompt，不能证明模型读懂、引用、遵守或从中获益。若注入次数增加 `count` 并延长半衰期，会形成自激励循环：越常被注入，越容易继续被注入。

建议记录不同事件：

```text
memory_retrieved       候选被召回
memory_injected        实际进入 prompt
memory_cited           模型显式引用
memory_supported       验证表明对结果有帮助
memory_contradicted    新证据与卡片冲突
memory_harmed          卡片导致错误或污染
```

`markUsed` 若保留，应改为类似 `markInjected`，不得直接提升事实可信度。

### 4.4 任务完成不等于记忆已验证

`trajectory + score + feedback → refine → save` 是合理的候选生成入口，但模型自评成功、一次通过或局部 score 达标，都不能证明经验可复用。成功经验应先进入 `candidate`，只有测试、静态检查、用户确认或后续独立复现通过后，才提升为 `verified/active`。

记忆必须带证据，例如：

```json
{
  "sourceEventIds": ["event-12", "event-13"],
  "sourceTurnIds": ["turn-12"],
  "refs": [{"path":"src/foo.ts", "commit":"abc123", "hash":"..."}],
  "evidence": [{"command":"npm test", "exitCode":0}],
  "status":"verified"
}
```

### 4.5 2-gram 自动合并存在语义反转风险

字符重叠可以去重明显重复，但不能安全识别语义等价；“必须保留旧 API”与“可以移除旧 API”可能共享大量字符。错误合并比重复卡片更危险。

建议：

- 仅对 exact hash 自动去重；
- 只有同 scope、同 topic、同 polarity、同 refs 才自动合并；
- 疑似相似但可能冲突的卡只建立 `relatedTo`，不直接 archive；
- 保留原事件和来源，任何合并都可回放。

### 4.6 文件路径过滤不足以保证适用性

`referencedFiles ∩ currentFiles` 是有价值的硬过滤，但同一路径可能跨 branch、commit、版本或符号发生变化。建议 provenance 至少包含：workspace/repository、branch、commit、file hash、symbol/range、来源事件。

适用性可分级：

```text
exact commit / file hash  强
same branch + same path  中
same path                弱
仅关键词命中              候选
```

### 4.7 PromptBuilder 仍是拼接器，不是上下文管理器

当前 PromptBuilder 已有 tier、记忆、feature、环境、历史、压缩和 overflow，但多个模块各自估算 token，overflow 可能绕过主预算；TaskState、事件和卡片还可能重复表达同一事实。

建议引入 `ContextCompiler`，统一负责：

1. scope 和 validity 过滤；
2. provenance 与冲突过滤；
3. lexical/semantic 召回；
4. 统一预算装箱；
5. 生成可审计的 `ContextSnapshot`。

### 4.8 compact 的一致性风险

现有 `compactService` 有模型摘要、deterministic fallback、后台 snapshot 和重入保护，这是优点。但摘要缺少结构化 schema、覆盖 turn IDs 和完整性检查；后台计算期间新增 turn 时，没有 generation/version 校验，apply 可能丢失边界区间。`PromptBuilder` 的 head/tail 字符截断还可能切断 XML、JSON 或验证块。

建议：

- 摘要保存 active task、decision/rationale、changed files、verification、blockers、next step、covered turn IDs；
- 原始事件不删除，摘要只是 prompt 投影；
- snapshot 带 generation，generation 不一致则重算或只应用安全区间；
- 以 block/section 为单位裁剪，不做任意字符切片；
- summary 失败时保留旧快照并显式报告失败。

## 5. 推荐目标架构

```text
User / Tool / Verification / Trajectory
                  │
                  ▼
        append-only AgentEvent
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
  Assertion / Fact       TaskState / Progress
        │                   │
        └─────────┬─────────┘
                  ▼
          MemoryProjection
       (lesson/preference/constraint/summary)
                  │
                  ▼
           ContextCompiler
                  │
                  ▼
           ContextSnapshot
                  │
                  ▼
              Model Run
```

### 5.1 AgentEvent：事实源

事件只记录发生了什么，append-only、可审计、可重放：

```ts
interface AgentEvent {
  id: string;
  ts: number;
  sessionId: string;
  taskId: string;
  type:
    | 'user_requirement' | 'decision_made'
    | 'tool_executed' | 'verification_passed'
    | 'verification_failed' | 'task_progressed'
    | 'memory_retrieved' | 'memory_injected'
    | 'memory_cited' | 'context_compacted';
  payload: unknown;
  refs?: SourceRef[];
}
```

可以在现有 rollout JSONL 之上扩展，但必须保持 session、turn、task 和 source 的关联；不要再建一个无法关联的独立日志。

### 5.2 Assertion 与 TaskState：分别表达事实和当前控制面

`Assertion` 表达可被证据支持、修正或冲突的断言，字段应有 scope、confidence、validFrom、validUntil、status、evidenceEventIds 和 provenance。

`TaskState` 表达当前任务的原始需求、决策、未决问题、里程碑、已验证事实、风险和 next step。它不能由普通 memory card 或单一 feature 状态替代。

### 5.3 MemoryProjection：经验复用层

保留 `RefinedMemoryCard` 的兼容 API，但逐步限制其职责为：lesson、procedure、preference、constraint、summary 等投影。投影必须能追溯到 source event，且支持 `candidate → verified → active → superseded/conflicted` 状态流。

### 5.4 ContextSnapshot：上下文审计层

每次模型调用记录：

```ts
interface ContextSnapshot {
  id: string;
  sessionId: string;
  taskId: string;
  model: string;
  contextLimit: number;
  assets: Array<{
    assetId: string;
    source: string;
    priority: number;
    tokenCount: number;
    validity: string;
  }>;
  renderedPromptHash: string;
}
```

这样评测可以知道“哪些记忆被看见、为何被选中、是否因预算被排除”，而不只是知道 prompt 中有几张卡。

## 6. 分阶段建议

### P0：可靠性和边界

1. 扩展现有 rollout 为统一 AgentEvent；
2. 独立持久化 TaskState/Progress；
3. 给 memory 增加 provenance、scope、confidence、utility、status；
4. 将 `markUsed` 拆为 injected/cited/verified 语义；
5. SessionStore、memory store、TaskState 使用原子写和 schema version；
6. resume 做幂等和事件关联校验。

### P1：上下文生命周期

1. task completion 先写 checkpoint/verification，再提炼 memory；
2. session end 生成有界 progress/handoff；
3. 引入 ContextCompiler 和 ContextSnapshot；
4. compact 使用结构化 envelope、covered turn IDs 和 generation check；
5. block-aware budget packing 替换任意字符截断。

### P2：检索和摘要

1. 先做 repository/file/symbol/task scope 硬过滤；
2. 再做关键词和 n-gram 候选召回；
3. 只有评测证明 lexical 不足时再加入 embedding；
4. 语义相似但可能矛盾的卡不自动合并；
5. 多级摘要只作为投影，原始事件和 checkpoint 永久保留。

### P3：正式评测

A/B/C 应增加消融档：

```text
A  无记忆
B  记忆卡
C1 B + TaskState
C2 B + AgentEvent
C3 B + 多级摘要
C4 B + 语义召回
D  全能力
```

每档必须独立 workspace、session、memory 和 cache，至少重复 3 次；记录模型版本、端点、参数、仓库 commit、prompt/schema 版本和失败原因。mock smoke 只能证明工程可启动，不能填入真实能力结果。

## 7. 评测指标建议

除了现有的约束召回、遵循、跨文件关联、状态续接和 token/时间，还应增加：

- 错误记忆注入率；
- 冲突记忆同时注入率；
- 记忆来源可追溯率；
- compact 后关键断言保持率；
- resume 后 TaskState 一致率；
- 验证证据保留率；
- 注入、引用、验证三者的转化率；
- 每个正确结果的 token 成本。

“注入了多少卡片”不是能力指标；A/B/C 也不能只跑一次，否则无法抵抗真实 openPangu 的输出随机性。

## 8. 不建议事项

- 不要把 `markUsed` 等同于模型使用；
- 不要把事实、状态、事件、经验和偏好继续塞进一种万能卡片；
- 不要让 `count` 同时代表热度、可信度和效用；
- 不要用 2-gram 相似度自动合并可能相反的约束；
- 不要先堆 embedding 再补事件、状态和 provenance；
- 不要把 mock smoke、测试数量或注入卡片数量当成长上下文收益证据；
- 不要把未实测的国产部署和资源数据写成已验证事实。

## 9. 交接状态

### 已确认

- [x] 项目叙事与计划主线确实是长上下文 + 记忆管理；
- [x] Pangu 已有结构化记忆卡、session/rollout、resume/branch、compact 和 PromptBuilder 基础；
- [x] learn harness 的核心借鉴点是事实源、状态/决策/交接分离和有界按需加载，而非现成自动 memory runtime；
- [x] 当前正式评测闭环尚未具备，不能把计划项表述为已实现能力。

### 需要后续确认/落地

- [ ] Leader 确认 AgentEvent 是否扩展现有 rollout JSONL，而非新建孤立日志；
- [ ] Leader 确认 `RefinedMemoryCard` 兼容 API 与新 Projection schema 的迁移方式；
- [ ] 确认 P0/P1/P2/P3 是否替代现有 P1-P8/U1-U9 的正式优先级；
- [ ] 明确真实 openPangu 评测端点、模型版本和可重复运行策略；
- [ ] 明确 `ContextSnapshot` 是否作为每次模型调用的强制审计产物。

### 阻塞与风险

- 现有计划同时使用 18 天 U1-U9、8 周主计划和 P1-P8 估时，交付口径不一致；
- `scripts/eval/`、T1-T5 和真实结果产物尚未形成完整闭环；
- 多入口任务完成路径可能导致 memory、session、rollout 写回不一致；
- background compact 缺少 generation check；
- 现有 token 估算口径不统一。

### 建议下一步

1. 先由 Leader 采纳本报告中的信息边界和正式评测分层；
2. 以现有 rolloutStore 为底座设计 AgentEvent 最小 schema；
3. 先实现 checkpoint/TaskState/ContextSnapshot 的可靠性测试；
4. 再决定是否需要 n-gram/embedding；
5. 最后用独立、重复、可机器判定的 A/B/C 消融评测证明收益。

## 10. 证据索引

### Pangu

- `WORK-PLAN-2DAY-UNITS.md:13-18,28-40`：9/24 MVP 和 U1-U9 任务矩阵；
- `tasks/agents/`：4 主力注册卡（owner 与接口协调）；
- `docs/panshalach/ROADMAP-NEXT.md:9-22`：P1-P8 路线和完成条件；
- `docs/panshalach/ROADMAP-NEXT.md:60-224`：P2-P6 具体记忆、摘要和评测计划；
- `docs/panshalach/MEMORY-DESIGN.md:13-23,61-91,112-147`：分层记忆、读写链路和已知差距；
- `docs/panshalach/EVALUATION.md:16-59`：A/B/C 基线、任务集、指标和控制变量；
- `src/memory/RefinedMemoryCard.ts`、`src/memory/RefinedMemoryStore.ts`：现有卡片、衰减、过滤、缓存、合并和 compact 补漏；
- `src/cli/repl/PromptBuilder.ts`：分层注入、预算估算、overflow 和最近上下文；
- `src/cli/repl/compactService.ts`、`compactStrategies.ts`：摘要、fallback、后台 compact 和策略；
- `src/cli/repl/Session.ts`、`SessionStore.ts`、`rolloutStore.ts`：session snapshot、append-only rollout、resume 和 branch。

### learn-harness-engineering

- `skills/harness-creator/SKILL.md`：Instructions、State、Verification、Scope、Lifecycle 五子系统；
- `skills/harness-creator/references/memory-persistence-pattern.md`：topic memory、bounded index、session extraction；
- `skills/harness-creator/references/context-engineering-pattern.md`：SELECT/WRITE/COMPRESS/ISOLATE、渐进披露和预算；
- `skills/harness-creator/references/lifecycle-bootstrap-pattern.md`：session start/end、bootstrap 和两阶段回收；
- `docs/en/lectures/lecture-03-why-the-repository-must-become-the-system-of-record/`：仓库作为事实源；
- `docs/en/lectures/lecture-05-why-long-running-tasks-lose-continuity/`：compaction、reset、progress、decision、handoff 的区别；
- `skills/harness-creator/templates/feature_list.json`、`progress.md`、`session-handoff.md`：机器可读状态和跨 session 交接模板。
