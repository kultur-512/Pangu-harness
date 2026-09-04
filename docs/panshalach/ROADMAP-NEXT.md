# Panshalach / 烛龙 Zhulong —— 命题后续开发路线（对照 openPangu 长程记忆增强）

> 来源：内部代号盤沙拉克 Panshalach（包名/类名/存储/env），外部产品名 烛龙 Zhulong（CLI/欢迎/身份串/对外文档）。
> 命题：华为《基于 openPangu 的记忆增强智能体架构设计与优化》。场景：软件工程长期维护。
> 状态：现状已盘点（见 `REFACTOR-ASSESSMENT.md` §3）；本次路线解决 **记忆不闭合 / 检索与事件空缺 / openPangu 适配断裂 / 评测工程缺位** 四块。

---

## 总体路线（P1–P8）

| ID | 主题 | 关键交付 | 估时 |
|---|---|---|---|
| **P1** | openPangu 模型接入泛化 | `tool_calls` 透传 + env 注入 + Provider 抽象去 GLM | 1 周 |
| **P2** | 记忆"写入闭环" + `markUsed` | 任务落定 refine+save；注入命中刷新 lastUsedAt | 0.5 周 |
| **P3** | 事件记忆 + 任务状态机 | `MemoryEvent` 持久化 + `TaskState` 跨轮任务跟踪 | 1.5 周 |
| **P4** | 语义检索 v0 | 本地 n-gram hash + 余弦 + `EmbeddingProvider` 抽象 | 1 周 |
| **P5** | 滚动多级摘要 | 粗粒度长期 + 结构化中期 + 逐字近期 | 0.5 周 |
| **P6** | 真实 openPangu 评测套件 | `scripts/eval/` + A/B/C runner + EVALUATION.md 实数据 | 1.5 周 |
| **P7** | 国产软硬件亲和 | 昇腾/麒麟运行验证 + 资源消耗实测 | 1 周 |
| **P8** | 评测基线数据回填 + 提交物定稿 | EVALUATION.md §4 实数据 + ARCHITECTURE.md 闭环图 | 0.5 周 |

> 完成条件：EVALUATION.md §4.1–4.4 填入真实数据；`npx tsc --noEmit` EXIT=0；505+ 用例全绿；`scripts/eval/run-eval.mjs` 一键跑出 A/B/C 对比 CSV。

---

## P1 — openPangu 模型接入泛化

### P1.1 `openai-compatible.ts` 透传 `tool_calls`
- `OpenAICompatClient.complete` 返回类型 `Promise<string | ModelClientOutput>`（`src/cli/repl/types.ts:209`）。
- `doComplete` 把 `json.choices[0].message.tool_calls` 抽出 → `{ content, raw: JSON, toolCalls, detectedFormat: 'openai_json' }`（仅当 tool_calls 非空）。
- `streamChat` 在 SSE 行同样识别 `delta.tool_calls`（delta 数组），累加成完整 `ToolCall` 后 emit。
- `ProviderRegistry.createClientSync` wrapper 把对象结果透传给 `VerifyCritiqueLoop` 的 `preParsedToolCalls` 通道（已支持）。

### P1.2 env 注入泛化（`src/cli/repl/ModelProvider.ts:103-123`）
- 把 `SCNET_API_KEY` 单点特化 → `PANSHA_<PROV>_API_KEY` / `PANSHA_<PROV>_BASE_URL` / `PANSHA_<PROV>_MODEL`。
- 向后兼容 `SCNET_API_KEY`/`SCNET_KEY` 仅在 `.panshalach.json.providers.scnet` 已配时生效。
- `_extractScnetKeyFromFile` → `_extractProviderKeyFromFile`（扫描 `providers.*.apiKey`）。
- `_pickBestGLMModel` → `_pickBestModel(providerName)`（从 `models` 数组选第一个非 `-Base`）。

### P1.3 `/model list` 重构（`src/cli/repl/commands/ModelCommand.ts`）
- 删除 `targetProvider === 'scnet'` 特化分支（行 133）+ 默认 baseUrl 硬编码（行 96）。
- 通用路径遍历 `Object.keys(providers)` 调 `listProviderModelsWithContext(providerName)` 合并。
- 文案去 scnet/GLM：描述/usage 用 `e.g. /model openpangu:openPangu-7B`。
- 错误模板化：`未在 {provider} 中找到密钥，请设置 {PANSHA_${PROV}_API_KEY} 或在 .panshalach.json 配置。`

### P1.4 StructuredReasoner / Adapter 去品牌
- `getGlmIronLawsHeader` → `getEngineeringIronLawsHeader`（字面量去 GLM）。
- `getGlmIronLawsShort` → `getEngineeringIronLawsShort`；`buildGlmFormatEnforcementPrompt` → `buildToolCallFormatEnforcementPrompt`。
- `strictGlmOnly` → `strictStructured`（参数语义重命名）。
- Adapter 类重命名：`ExtremeGlmToolCallAdapter` → `StrictStructuredToolAdapter`；`GlmToolCallParser` → `XmlStructuredToolParser`。
- `src/adapter/README.md` 重写为"三路工具调用解析：JSON / 文本 / XML 结构化"。
- **内部 identifier 保留 `Glm` 别名兼容**（`export { StrictStructuredToolAdapter as GlmToolCallParser }`）。

### P1.5 `getModelContextLength` 跨 provider
- `src/cli/repl/ModelProvider.ts:422-445`：`getModelContextLength` 遍历所有 `providers.*.modelContexts[modelName]`，未命中 fallback 256k。
- 这样 `openPangu-1B 4096` 真正生效，避免默认 256k 上下文预算超过模型能力。

---

## P2 — 记忆写入闭环 + `markUsed`

### P2.1 `RefinedMemoryStore.markUsed`
- 在 `src/memory/RefinedMemoryStore.ts:393` 实现（注释承诺但未实现）：
  ```ts
  public markUsed(cardIds: string[], now = Date.now()): { updated: number; path: string } {
    if (cardIds.length === 0) return { updated: 0, path: this.filePath };
    const file = this.load();
    let updated = 0;
    for (const c of file.cards) {
      if (cardIds.includes(c.id)) {
        c.lastUsedAt = now;
        c.count = (c.count ?? 0) + 1;
        updated++;
      }
    }
    file.meta.lastUpdated = now;
    writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
    this.cache = file;
    this.invalidateProjection();
    return { updated, path: this.filePath };
  }
  ```

### P2.2 Chaser 落定点
- `src/PanshalachChaser.ts:516-518`：替换"任务落定只 invalidateProjection"为 `refine(...)` + `save(cards)`。
- `solveIssue` 返回值加 `refined?: { added: number; merged: number }`。

### P2.3 REPL / Server / SSE 入口
- `Repl.executeTask` / `runAgentTask` / `sseInteractive` 完成路径拿 `result.refined` 后提示"已提炼 N 张卡"。
- `runAgentTask` 把 `refined` 通过 `ctx.onEvent` `done` 事件下发。

### P2.4 注入端 markUsed
- `PromptBuilder.appendMemoryCardsDedup` 注入前 `memStore.markUsed(cards.map(c => c.id))`（task 边界一次）。
- `getOverflowCards` 路径同样。
- `PanshalachChaser` `loadFilteredCached` 后调用。
- `compactService` 不清空 lastUsedAt（冻结即可）。

### P2.5 单测
- `tests/memory/MemoryM4.test.ts`：`markUsed` 单测 + 端到端（mock `PanshalachChaser.solveIssue` → `markUsed` → 文件持久化 → 二次 `loadFiltered` 验证）。

---

## P3 — 事件记忆 + 任务状态机

### P3.1 `MemoryEvent` 持久化（新增 `src/memory/events.ts`）
```ts
export type MemoryEventKind = 'decision' | 'constraint' | 'requirement' | 'verified' | 'failure' | 'progress' | 'preference';
export interface MemoryEvent {
  id: string; ts: number; kind: MemoryEventKind;
  topic: string; summary: string;           // ≤120 字
  detailPath?: string; refs?: string[]; sessionId: string;
}
export class MemoryEventStore {
  constructor(private workspace: string, private home: string) {}
  append(ev: MemoryEvent): void;                                       // ~/.panshalach/events/<topic>.jsonl
  query(filter: { topic?; kind?; since?; refs? }): MemoryEvent[];
  listTopics(): string[];
}
```
- topic 自动分类：决策/约束/需求/验证 等 30+ 启发式正则。
- 注入：L1 之后，预算 200 token；优先级 importance（verified > requirement > decision > constraint > progress > failure）。

### P3.2 `TaskState` 任务状态机（`src/cli/repl/FeatureTracker.ts`）
```ts
export interface TaskState {
  taskId: string;
  taskContextId: string;
  originalRequirement: string;    // 首次回合锁定，永不漂移
  decisions: { ts; what; why; refs? }[];
  openQuestions: { ts; q; status: 'open'|'answered'|'abandoned' }[];
  milestones: { ts; title; done; evidence? }[];
  verified: { ts; what; how; command? }[];
  risks: { ts; risk; mitigation? }[];
  nextStep?: string; updatedAt: number;
}
```
- 存储：`~/.panshalach/task_state.json`。
- 注入：与 L1 同级，**优先级最高**，预算 300 token。
- CLI 子命令：`/task status` `/task risks` `/task next` `/task decide "..."`。

### P3.3 事件流提取器（`src/memory/eventExtractor.ts`）
- 输入：`bestTrajectory` + `score` + `userFeedback` + 当前 `TaskState`。
- 启发式：终步 `critique`/`verify` 含"已验证/通过/失败/决定/约束/未决" → 抽取 MemoryEvent。
- 用户消息含"必须/不许/建议/决定" → `requirement/decision/constraint`。
- 每回合 ≤ 5 事件；`score < 50` 只记 failure。

### P3.4 三件套串联
- `PanshalachChaser.solveIssue` 落定路径同时：refine+save (P2) + 提取 MemoryEvent + 更新 TaskState。
- PromptBuilder L1 注入顺序：**TaskState → 记忆卡 → MemoryEvent → 当前任务**。
- 单测：`tests/memory/EventStore.test.ts`、`tests/repl/TaskState.test.ts`。

---

## P4 — 语义检索 v0（本地 n-gram hash + Provider 抽象）

### P4.1 EmbeddingProvider 抽象（`src/memory/embed.ts`）
```ts
export interface EmbeddingProvider {
  name: string; dim: number;
  embed(text: string): Float32Array | Promise<Float32Array>;
}
```
- `LocalNGramHashProvider`：字符 2-gram 词袋向量、4096 哈希桶、L2 归一化、零依赖（Node 22 全平台）。

### P4.2 RefinedMemoryStore 融合
- 构造参数 `embedProvider?: EmbeddingProvider`、`embedCache?: Map<string, Float32Array>`。
- `loadFiltered` 新增 `semanticScore`（缓存中 `summary` embedding vs `issue` embedding 余弦）。
- 排序 = `0.5×effectiveWeight + 0.2×relevance + 0.3×semanticScore`。
- 嵌入缓存：`.panshalach-embed-cache.json`（`{hash: Float32Array}`，TTL 30d）。
- 注入预热：构造时 `setImmediate` 为当前卡列表 embed。

### P4.3 `/memory` CLI 暴露（`src/cli/MemoryCommand.ts`）
- `memory search-semantic <text>` 走余弦打分。
- `memory embed-stats` 显示缓存。

### P4.4 Provider 预留扩展点
- `.panshalach.json` 增加可选 `embedding.provider`：`{ name: 'local-ngram' }`（v0）或 `{ name: 'openpangu', baseUrl, model: 'openPangu-Embedding-1B' }`（**留口不实装**）。
- 默认 `LocalNGramHashProvider`。

### P4.5 单测
- `tests/memory/SemanticSearch.test.ts`：同义不同措辞召回；非命中上限；缓存命中。

---

## P5 — 滚动多级摘要

### P5.1 三级摘要分层（`src/cli/repl/compactService.ts`）
- L0（近 6 轮，逐字）：`KEEP_RECENT = 6`，保留。
- L1（中期，结构化）：> 12k token 时触发，逐轮摘要 + `intent/decision/refs` 三元组，落 `~/.panshalach/mid-summaries/<sessionId>.jsonl`。
- L2（长期，粗粒度）：> 30k token 时触发，中期合并为 ≤800 token 段落，落 `~/.panshalach/long-summaries/<sessionId>.jsonl`。

### P5.2 串联
- 摘要提取时识别"是否含教训" → 自动 `refineCompactSignals` 写 success/failure 卡。

### P5.3 单测
- `tests/repl/MultiLevelCompact.test.ts`：100 轮模拟 → 三级文件落定 + 注入预算正确。

---

## P6 — 真实 openPangu 评测套件

### P6.1 任务集 T1–T5（新增 `scripts/eval/tasks/`）
- `T1-constraint.ts`：种子仓库 + 早期约束（如"不得用 lodash"），30 回合后跑后期任务，断言未破坏。
- `T2-crossfile.ts`：跨 5 文件契约（如 `compute` 接口签名不变）。
- `T3-longdoc.ts`：1000 行文档分块摘要 + 关联问答，5 回合。
- `T4-resume.ts`：中途 `--resume <id>` 测任务状态恢复。
- `T5-compact.ts`：强制 `ctxRatio > 0.85` 触发压缩，检早期约束保持。
- 每文件 export `EvalTask { setup(repo: string): Promise<void>; scenario: Scenario[] }`，Scenario `{ userInput, referenceAnswer?, expectInjected? }`。

### P6.2 A/B/C runner（`scripts/eval/run-eval.mjs`）
- A：纯上下文窗口（无 L1）。
- B：RefinedMemoryStore 现有 `loadFiltered`（仅记忆卡）。
- C：A + B + MemoryEvent + TaskState + 语义检索 + 多级摘要（全能力）。
- 每档跑 5 任务族 × 1 次，记：约束召回率、约束遵循率、跨文件关联命中、状态续接得分、token 总成本、平均时长。
- 输出 `scripts/eval/results/<timestamp>.json`。
- `--openpangu http://...` flag 接 baseUrl/apiKey。

### P6.3 EVALUATION.md 数据回填
- 用户跑 `run-eval.mjs` 后，`scripts/eval/fill-evaluation.mjs` 拉数据填 EVALUATION.md §4 表。
- README 提示："不要手填，从 results/ 拉取"。

### P6.4 smoke-eval（CI gate）
- `scripts/eval/smoke-eval.mjs`：mock model client + 跑 1 个最小任务验证 runner 工程（≈ 5s）。

---

## P7 — 国产软硬件亲和

### P7.1 部署文档（`docs/panshalach/DEPLOY-CN.md`）
- 昇腾 310P/910 + vLLM-ascend 跑 openPangu-1B/7B 的 OpenAI 兼容端点。
- MindIE 部署脚本片段。
- 麒麟 OS（Kylin V10 SP3）：Node 18+/22 安装、`npm i`、零运行时依赖说明。
- 鲲鹏 920 + openEuler：同上（aarch64 兼容）。

### P7.2 资源消耗实测表
- `ARCHITECTURE.md` §5 资源消耗表填实测：
  - openPangu-1B int8 单卡：< 4GB、上下文 4096、每任务 token 中位数/p95。
  - openPangu-7B int4 单卡：显存 16GB、上下文 8192、每任务 token 中位数。

### P7.3 optionalDependencies
- `package.json` 增加占位项 `"@openpangu/ascend-runtime": "*"`（不实际安装），README 说明真实昇腾部署从 ModelScope / gitcode 拉取。

---

## P8 — 评测基线数据回填 + 提交物定稿

### P8.1 EVALUATION.md 数据回填
- 从 `scripts/eval/results/*.json` 拉数据填 §4.1–4.4 表。
- §5 写"分析叙事"：约束召回曲线、跨文件关联命中差距、记忆污染观察、1B/7B 能力差异。

### P8.2 提交物定稿
- `ARCHITECTURE.md` 标题与 §0 更新为"烛龙（Zhulong）· 内部代号 Panshalach"；§1 加 MemoryEvent + TaskState 层；§3 加 P3 闭环。
- `EVALUATION.md` §4 + §5 + §6（评测脚本路径）完工。
- `README.md` 加"评测结果"小节指向 EVALUATION.md。
- `REFACTOR-ASSESSMENT.md` §3 缺口表改为"已实现 / 路在 P1–P8"，§4 标完成为已完成 P0–P1 + P2–P8。

### P8.3 提交前验证
```bash
cd P:\MY_codes\Pangu
npx tsc --noEmit                                       # EXIT=0
node --test --import tsx --test-concurrency=1 "tests/**/*.test.ts"   # 525 全绿
node verify-panshalach-cleanup.mjs                     # PASS
grep -ri 'zorge\|GLM-5\.x' src/ | wc -l                 # ≤ 10 仅 alias
node scripts/eval/smoke-eval.mjs                        # PASS (mock)
node scripts/migrate-panshalach.mjs                    # 报告 skip（本地无 ~/.zorge）
```

---

## 关键文件路径

| 模块 | 路径 |
|---|---|
| 入口/主类 | `src/PanshalachChaser.ts`, `src/cli.ts`, `src/cli/repl.ts` |
| 模型接入 | `src/model/openai-compatible.ts`, `src/model/ProviderRegistry.ts`, `src/cli/repl/ModelProvider.ts` |
| 协议/适配器 | `src/reasoning/StructuredReasoner.ts`, `src/loop/VerifyCritiqueLoop.ts`, `src/adapter/*` |
| 提示注入 | `src/cli/repl/PromptBuilder.ts`, `src/cli/repl/commands/MemoryCommand.ts`, `src/cli/repl/commands/ModelCommand.ts` |
| 记忆 | `src/memory/RefinedMemoryStore.ts`, `src/memory/RefinedMemoryCard.ts`, `src/memory/FailureMemory.ts` |
| 压缩 | `src/cli/repl/compactService.ts`, `src/cli/repl/compactStrategies.ts` |
| 会话资产 | `src/cli/repl/Session.ts`, `src/cli/repl/SessionStore.ts`, `src/cli/repl/rolloutStore.ts`, `src/cli/repl/FeatureTracker.ts` |
| 工具引擎 | `src/tools/*` |
| 评测 | `scripts/eval/`（新增）、`scripts/verify-*.mjs`、`scripts/m1-acceptance.mjs` |
| 配置 | `.panshalach.json.example`, `package.json`, `.gitignore` |
| 文档 | `docs/panshalach/{README,ARCHITECTURE,MEMORY-DESIGN,EVALUATION,USER-GUIDE,ROADMAP,DEPLOY-CN}.md` |
| 校验 | `verify-panshalach-cleanup.mjs` |

---

## 真实 openPangu 运行步骤

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

# 5) 提交物定稿 + 验证（见 P8.3）
```
