# Panshalach / 烛龙 Zhulong —— 命题后续开发路线

> 内部代号 盤沙拉克 Panshalach（包名/类名/存储/env）/ 外部产品 烛龙 Zhulong（CLI/欢迎/身份串/对外文档）。
> 命题：华为《基于 openPangu 的记忆增强智能体架构设计与优化》。场景：软件工程长期维护。
> 基线：翟苑皓（Leader）做的 `docs/agent/handover/feature-zhaiyuanhao-long-context-memory-review.md` 修订报告（READY-FOR-REVIEW）—记忆卡降级为 prompt 投影，事件 / 状态 / 投影 三层事实源分离。

## 0. 五层事实源

```
User / Tool / Verification / Trajectory
       │
       ▼
append-only AgentEvent       ← 事实源（仅追加，可重放）
       │
   ┌───┴───┐
   ▼       ▼
Assertion  TaskState     ← 事实校验 + 当前控制面
   │       │
   └───┬───┘
       ▼
MemoryProjection          ← 经验复用层（RefinedMemoryCard 兼容 API）
       │
       ▼
ContextCompiler            ← 统一预算装箱
       │
       ▼
ContextSnapshot           ← 每次模型调用的强制审计产物
       │
       ▼
Model Run
```

- **AgentEvent**：append-only，关联 sessionId + taskId，类型 `user_requirement / decision_made / tool_executed / verification_passed / verification_failed / task_progressed / memory_retrieved / memory_injected / memory_cited / context_compacted`
- **Assertion**：scope / confidence / validFrom / validUntil / status / evidenceEventIds / provenance
- **TaskState**：原始需求 / 决策 / 未决 / 里程碑 / 已验证 / 风险 / next step
- **MemoryProjection**：由 AgentEvent + Assertion 派生出的 prompt 卡片（**RefinedMemoryCard 仅作为兼容 API 保留**）
- **ContextCompiler + ContextSnapshot**：统一预算装箱 + 每次模型调用的输入审计

## 1. 总体路线（P0–P5）

| ID | 主题 | 关键交付 | 估时 |
|---|---|---|---|
| **P0** | 事实源与持久化分层 | rolloutStore 扩展 AgentEvent + TaskState/Assertion 独立 + markUsed 拆三态 | 1 周 |
| **P1** | openPangu 接入泛化 | `tool_calls` 透传 + env 注入 + 跨 provider 上下文 | 1 周 |
| **P2** | 记忆投影 + 检索 v0 | MemoryCard 加 provenance/sourceEventIds/evidence/status；n-gram hash + 余弦；provider 抽象 | 1 周 |
| **P3** | 滚动多级摘要 + ContextCompiler | 三级摘要 + 统一预算装箱 + ContextSnapshot | 1 周 |
| **P4** | 真实 openPangu 评测套件 | `scripts/eval/` + A/B/C 消融 + 真 openPangu 跑 | 1.5 周 |
| **P5** | 国产软硬件亲和 + 提交物定稿 | DEPLOY-CN.md + EVALUATION.md 实数据 + 项目书 SUBMISSION.md | 1 周 |

> 完成条件：`npx tsc --noEmit` EXIT=0；525+ 用例全绿；`verify-panshalach-cleanup.mjs` PASS；`scripts/eval/run-eval.mjs` 一键跑出 A/B/C 对比 CSV。

## 2. 五件套 + 五层落点（与代码模块映射）

| 层 | 模块 | 角色 |
|---|---|---|
| AgentEvent 事实源 | `src/memory/events.ts` + `src/cli/repl/rolloutStore.ts`（扩展） | append-only JSONL，重放/A/B 评测 |
| Assertion | `src/memory/assertions.ts`（新） | 事实校验：scope / confidence / validFrom-validUntil / evidenceEventIds |
| TaskState | `src/memory/taskState.ts` + `src/cli/repl/commands/TaskCommand.ts` | 原始需求锚 + 决策 + 未决 + next step |
| MemoryProjection | `src/memory/RefinedMemoryCard.ts`（兼容 v2）+ `src/memory/embed.ts` | 卡片降级为派生投影；n-gram hash v0 + provider 抽象 |
| ContextCompiler | `src/cli/repl/PromptBuilder.ts`（重构为 compiler）+ `src/cli/repl/ContextSnapshot.ts` | 替代"拼接器"做预算装箱与注入审计 |

## 3. P0 — 事实源与持久化分层

### P0.1 AgentEvent 扩展现有 rolloutStore
- 在 `src/cli/repl/rolloutStore.ts` 上扩展 schema：保留 `meta / turn / approval / rewind`，追加 `task_id` 与 `events`（typed）。
- 类型（`src/memory/events.ts`）：
  ```ts
  export type AgentEventKind = 'user_requirement' | 'decision_made' | 'tool_executed' | 'verification_passed' | 'verification_failed' | 'task_progressed' | 'memory_retrieved' | 'memory_injected' | 'memory_cited' | 'context_compacted';
  export interface AgentEvent { id; ts; sessionId; taskId; kind; payload: unknown; refs?: SourceRef[]; }
  ```
- `rolloutStore.appendAgentEvent(ev)` 写到同一 `~/.panshalach/rollouts/<sid>.jsonl`。
- 落定路径（`PanshalachChaser.solveIssue`）在写 refine/save 前先写 AgentEvent 序列。

### P0.2 TaskState 独立持久化
- `src/memory/taskState.ts`：JSON 持久化 `~/.panshalach/task_state.json`。
- 字段：原始需求 / decisions / openQuestions / milestones / verified / risks / nextStep。
- CLI：`/task status | /task risks | /task next | /task decide "..."`。

### P0.3 Assertion schema（`src/memory/assertions.ts`）
- 字段：scope / confidence / validFrom / validUntil / status / evidenceEventIds / provenance。
- 任务完成才升级 `candidate → verified`。

### P0.4 markUsed → markInjected/cited/verified 拆三态
- `RefinedMemoryStore` 暴露三方法：`markInjected(cardIds)` / `markCited(cardIds)` / `markVerified(cardIds, evidenceEventIds)`。
- `PromptBuilder.appendMemoryCardsDedup` 注入前 `markInjected`；commit/checkpoint 时 `markCited`/`markVerified`。
- **不再用 `markUsed` 等同于模型使用**——杜绝自激励循环。

### P0.5 原子写 + schema version
- `SessionStore` / `memory store` / `TaskState` 写盘先写 `<file>.tmp.<ts>` 再 `rename`，避免半截写崩。
- 每次落盘带 `schemaVersion`；resume 校验版本兼容，不兼容则明确失败而不是 silent fallback。

### P0.6 单测
- `tests/memory/EventStore.test.ts`：追加 + 查询 + 隔离。
- `tests/repl/TaskState.test.ts`：status 迁移 + 持久化。
- `tests/memory/MemoryProjection.test.ts`：candidate → verified 升级 + provenance 校验。
- `tests/utils/AtomicWrite.test.ts`：模拟中断后不残留半截文件。

## 4. P1 — openPangu 接入泛化

### P1.1 `openai-compatible.ts` 透传 `tool_calls`
- `complete` 返回 `Promise<string | ModelClientOutput>`，类型在 `src/cli/repl/types.ts:209`。
- `doComplete` 把 `message.tool_calls` / `delta.tool_calls` 抽出成 `{ content, raw, toolCalls, detectedFormat }`。
- `ProviderRegistry.createClientSync` wrapper 把对象透传给 `VerifyCritiqueLoop.preParsedToolCalls` 通道。

### P1.2 env 注入泛化（`src/cli/repl/ModelProvider.ts`）
- `PANSHA_<PROV>_API_KEY` / `PANSHA_<PROV>_BASE_URL` / `PANSHA_<PROV>_MODEL`。
- 向后兼容 `SCNET_API_KEY` / `SCNET_KEY`（仅在 `.panshalach.json.providers.scnet` 已配时生效）。
- `_extractScnetKeyFromFile` → `_extractProviderKeyFromFile`（扫描 `providers.*.apiKey`）。

### P1.3 `/model list` 重构（`src/cli/repl/commands/ModelCommand.ts`）
- 通用路径遍历 `Object.keys(providers)` 调 `listProviderModelsWithContext(providerName)`。
- 错误模板化：`未在 {provider} 中找到密钥，请设置 {PANSHA_${PROV}_API_KEY} 或在 .panshalach.json 配置。`

### P1.4 协议与适配器去品牌（统一到"结构化"，已完成）
- ✅ `StructuredReasoner.getGlmIronLawsHeader` → `getEngineeringIronLawsHeader` 等三方法已改名。
- ✅ `strictGlmOnly` → `strictStructured` 已完成（`isStrictGlm` 选项已删除）。
- ✅ Adapter 类已重命名：`StrictStructuredToolAdapter` / `XmlStructuredToolParser`（git mv 保留历史）。
- ✅ `src/adapter/README.md` 已重写为"三路工具调用解析：JSON / 文本 / XML 结构化"。
- ✅ 兼容别名全部移除（不留 `Glm` 别名导出），`Glm53SweProChaser` 兼容 stub 与 `scripts/test-glm-shorthand.mjs` 已删除。

### P1.5 `getModelContextLength` 跨 provider
- 遍历 `providers.*.modelContexts[modelName]`，未命中 fallback 256k。
- 这样 `openPangu-1B 4096` / `openPangu-7B 8192` 真正生效。

## 5. P2 — 记忆投影 + 检索 v0

### P2.1 MemoryCard v2（兼容 API + 新字段）
- 在 `RefinedMemoryCard` 加字段：`provenance / sourceEventIds / sourceTurnIds / refs / evidence / status (candidate | verified | active | superseded | conflicted) / priority / confidence / validity / utility / freshness`。
- `weight × decay × count` 改 `priority × freshness`（cf. 翟苑皓审查 §4.2）。
- `markUsed` 改 `markInjected / markCited / markVerified`。

### P2.2 EmbeddingProvider（`src/memory/embed.ts`）
- `LocalNGramHashProvider`：字符 2-gram 词袋向量、4096 哈希桶、L2 归一化、零依赖。
- `loadFiltered` 排序 = `0.5×priority + 0.2×relevance + 0.3×semanticScore`。
- 嵌入缓存 `.panshalach-embed-cache.json`（TTL 30d）。

### P2.3 合并安全（cf. 审查 §4.5）
- 仅 exact hash 自动去重；只有同 scope + 同 topic + 同 polarity + 同 refs 才自动合并。
- 疑似相似但可能冲突的卡只建立 `relatedTo`，不直接 archive。
- 保留原事件和来源，任何合并都可回放。

### P2.4 文件路径过滤 + provenance（cf. 审查 §4.6）
- `provenance` 至少含 workspace/repo、branch、commit、file hash、symbol/range、来源事件。
- 适用性按 exact commit / branch+path / 关键词分级。

## 6. P3 — 滚动多级摘要 + ContextCompiler

### P3.1 三级摘要分层（`src/cli/repl/compactService.ts`）
- L0（近 6 轮，逐字）：保持。
- L1（中期，结构化）：> 12k token 触发；保存 active task / decision / changed files / verification / blockers / next step / covered turn IDs。
- L2（长期，粗粒度）：> 30k token 触发；中期合并为 ≤800 token 段落。

### P3.2 ContextCompiler 取代拼接器
- 新增 `src/cli/repl/ContextCompiler.ts`：scope/validity 过滤 → provenance 冲突过滤 → lexical/semantic 召回 → 统一预算装箱 → 输出 `ContextSnapshot`。
- `PromptBuilder` 重构为 compiler 的 thin adapter，保留同名 API。

### P3.3 ContextSnapshot
- 每次模型调用记录 `id / sessionId / taskId / model / contextLimit / assets[] / renderedPromptHash`。
- 评测可读取 snapshot 知道"哪些记忆被看见 / 为何被选中 / 是否因预算被排除"。

### P3.4 compact 风险（cf. 审查 §4.8）
- 摘要保存 active task / decision / changed files / verification / blockers / next step / covered turn IDs；原始事件不删除。
- snapshot 带 generation 做 generation check；后台计算期间新增 turn 时不一致则重算或仅应用安全区间。
- 以 block 为单位裁剪，不做任意字符切片。

## 7. P4 — 真实 openPangu 评测套件

### P4.1 任务集 T1–T5（`scripts/eval/tasks/`）
- T1 约束保持 / T2 跨文件 / T3 长文档 / T4 resume / T5 compact。
- 每文件 `EvalTask { setup(repo); scenario[] }`，Scenario `{ userInput, referenceAnswer?, expectInjected? }`。

### P4.2 A/B/C 消融评测（cf. 审查 §6）
- A：无记忆
- B：记忆卡
- C1：B + TaskState
- C2：B + AgentEvent
- C3：B + 多级摘要
- C4：B + 语义召回
- D：全能力
- 每档独立 workspace + session + memory + cache，至少重复 3 次。
- mock smoke 不能填入真实能力结果。

### P4.3 评测指标（cf. 审查 §7）
- 错误记忆注入率 / 冲突记忆同时注入率 / 记忆来源可追溯率 / compact 后关键断言保持率 / resume 后 TaskState 一致率 / 验证证据保留率 / 注入→引用→验证 转化率 / 每正确结果的 token 成本。
- 禁用指标："注入了多少卡片" / "测试数量" / "未实测的国产部署数据"。

### P4.4 EVALUATION.md 数据回填
- 用户跑 `run-eval.mjs` 后，`scripts/eval/fill-evaluation.mjs` 拉数据填 §4.1–4.4 表。

### P4.5 smoke-eval（CI gate）
- `scripts/eval/smoke-eval.mjs`：mock model client + 跑 1 个最小任务验证 runner 工程（≈ 5s）。

## 8. P5 — 国产软硬件亲和 + 提交物定稿

### P5.1 部署文档（`docs/panshalach/DEPLOY-CN.md`）
- 昇腾 310P/910 + vLLM-ascend / MindIE 跑 openPangu-1B/7B 的 OpenAI 兼容端点。
- 麒麟 OS（Kylin V10 SP3）/ 鲲鹏 920 + openEuler：Node 18+/22 安装、零运行时依赖说明。

### P5.2 资源消耗实测表
- `ARCHITECTURE.md` §5 填实测：
  - openPangu-1B int8 单卡：< 4GB、上下文 4096、每任务 token 中位数/p95
  - openPangu-7B int4 单卡：显存 16GB、上下文 8192、每任务 token 中位数

### P5.3 项目书 SUBMISSION.md
- ≤1000 字概述 + 完整解决方案（背景/目标/产品/技术愿景/创新点/差异化 + 五层架构细节）。
- 主线：**记忆作为上下文管家**——AgentEvent 事实源 + Assertion 校验 + TaskState 控制 + MemoryProjection 复用 + ContextCompiler 装箱。
- "注入了多少卡" 不作为卖点；"记忆注入后任务质量提升 X%" 才作为卖点。

### P5.4 提交前验证
```bash
cd P:\MY_codes\Pangu
npx tsc --noEmit                                  # EXIT=0
node --test --import tsx --test-concurrency=1 "tests/**/*.test.ts"   # 525+ 全绿
node verify-panshalach-cleanup.mjs               # PASS
node scripts/eval/smoke-eval.mjs                  # PASS (mock)
node scripts/migrate-panshalach.mjs              # 报告 skip（本地无 ~/.zorge）
```

## 9. 关键文件路径

| 模块 | 路径 |
|---|---|
| 入口/主类 | `src/PanshalachChaser.ts`, `src/cli.ts`, `src/cli/repl.ts` |
| 模型接入 | `src/model/openai-compatible.ts`, `src/model/ProviderRegistry.ts`, `src/cli/repl/ModelProvider.ts` |
| 协议/适配器 | `src/reasoning/StructuredReasoner.ts`, `src/loop/VerifyCritiqueLoop.ts`, `src/adapter/*` |
| 提示注入 | `src/cli/repl/PromptBuilder.ts`, `src/cli/repl/commands/MemoryCommand.ts`, `src/cli/repl/commands/ModelCommand.ts` |
| 五层记忆 | `src/memory/events.ts`, `src/memory/assertions.ts`, `src/memory/taskState.ts`, `src/memory/embed.ts`, `src/memory/RefinedMemoryStore.ts` |
| 上下文管理 | `src/cli/repl/ContextCompiler.ts`, `src/cli/repl/ContextSnapshot.ts` |
| 压缩 | `src/cli/repl/compactService.ts`, `src/cli/repl/compactStrategies.ts` |
| 会话资产 | `src/cli/repl/Session.ts`, `src/cli/repl/SessionStore.ts`, `src/cli/repl/rolloutStore.ts`, `src/cli/repl/FeatureTracker.ts` |
| 工具引擎 | `src/tools/*` |
| 评测 | `scripts/eval/`（新增）、`scripts/verify-*.mjs`、`scripts/m1-acceptance.mjs` |
| 配置 | `.panshalach.json.example`, `package.json`, `.gitignore` |
| 文档 | `docs/panshalach/{README,ARCHITECTURE,MEMORY-DESIGN,EVALUATION,USER-GUIDE,ROADMAP,DEPLOY-CN}.md` |
| 校验 | `verify-panshalach-cleanup.mjs` |

## 10. 真实 openPangu 运行步骤

```bash
# 0) 端点就绪（昇腾 MindIE / vLLM-ascend / 本机 vLLM）— OpenAI 兼容 /v1
#    POST /chat/completions 支持 OpenAI 原生 tool_calls

# 1) 配置（.panshalach.json 已含 openpangu 预设）
export PANSHA_OPENPANGU_API_KEY=EMPTY
export PANSHA_OPENPANGU_BASE_URL=http://127.0.0.1:8000/v1
export PANSHA_MODEL=openpangu:openPangu-7B

# 2) 验证 modelclient
panshalach run "ping"

# 3) 跑真实评测
node scripts/eval/run-eval.mjs --openpangu http://127.0.0.1:8000/v1 \
    --tasks T1,T2,T3,T4,T5 --modes A,B,C

# 4) 数据回填
node scripts/eval/fill-evaluation.mjs

# 5) 提交物定稿 + 验证（见 P5.4）
```
