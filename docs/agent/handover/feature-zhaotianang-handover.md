# Handover — zhaotianang（Main-B / W4 · P4 语义检索 v0 + P5 多级摘要）

> 起草日：2026-09-04（周五前置）
> 更新日：2026-09-05（v3 兼容性确认）
> 工作分支：feature/zhaotianang1
> 状态：**接口签名阶段**（实现未落地，待 9/7 周一 U1 开工）
> 代码：`src/memory/embed.ts`（已落库，独立模块）

---

## 1. 范围（W4 全部 9 单位）

| 单位 | 日期 | 内容 | 阶段 |
|---|---|---|---|
| U1 | 9/7-8 | `src/memory/embed.ts`：EmbeddingProvider + LocalNGramHashProvider + cosine | ✅ 已起草待开工 |
| U2 | 9/9-10 | RefinedMemoryStore 接 embedProvider/embedCache；loadFiltered 加 semanticScore | 待 U1 |
| U3 | 9/11-12 | `.panshalach.json.example` 加 `embedding.provider` 字段 | 待 U2 |
| U4 | 9/13-14 | compactService 三级摘要 L0（保持）+ L1（中期 12k+） | 待 U3 |
| U5 | 9/15-16 | tests/memory/SemanticSearch.test.ts + tests/repl/MultiLevelCompact.test.ts 全绿 | 待 U4 |
| U6 | 9/17-18 | M4 集成：embed 缓存 + 三级摘要联动 + `memory search-semantic` | 待 U5 |
| U7 | 9/19-20 | 注入预算 + 资源消耗实测 + ARCHITECTURE.md §5 填表 | 待 U6 |
| U8 | 9/21-22 | 语义检索 demo + 多级摘要资源数据 | 待 U7 |
| U9 | 9/23-24 | 摘要/语义测试全绿 + DEPLOY-CN.md + SUBMISSION.md 项目书 | 待 U8 |

---

## 2. 我暴露的接口（v0 草案 · 9/14 前要 Leader 拍板）

### 2.1 `EmbeddingProvider` 接口

```ts
export type DenseVector = number[];

export interface EmbeddingProvider {
  readonly name: string;     // 'local-ngram' / 'remote-xxx'
  readonly dim: number;      // v0 默认 4096
  embed(text: string): DenseVector | Promise<DenseVector>;
  embedBatch?(texts: string[]): DenseVector[] | Promise<DenseVector[]>;
}
```

### 2.2 `cosineSimilarity(a, b): number`

```ts
export function cosineSimilarity(a: DenseVector, b: DenseVector): number;
```

- 输入：同维度向量
- 输出：[-1, 1]（v0 因非负向量，实际 ∈ [0, 1]）
- 边界：零向量 → 0；维度不一致 → throw；undefined/NaN 视作 0

### 2.3 `LocalNGramHashProvider` 默认实现

- 算法：字符 2-gram → FNV-1a 32-bit 哈希 → 4096 桶计数 → L2 归一化
- 性质：确定性 / 零依赖 / 中文友好 / 同输入幂等
- 桶数可配（`new LocalNGramHashProvider(buckets)`，默认 4096）
- `embedBatch` 默认同步循环实现

### 2.4 `EmbeddingCache` 接口（U2 占位）

```ts
export interface EmbeddingCache {
  get(text: string): DenseVector | undefined;
  set(text: string, vec: DenseVector): void;
  has(text: string): boolean;
  size(): number;
  clear?(): void;
}
```

### 2.5 工厂

```ts
export function createDefaultProvider(buckets?: number): EmbeddingProvider;
```

---

## 3. ⚠️ Memory v3 (bf5f4a7) 兼容性影响（关键 · 2026-09-05 更新）

翟苑皓 9/5 落地了 memory v3 改动，**直接影响** P4 + P5 的实现路径：

### 3.1 `RefinedMemoryStore.loadFiltered` 现在过滤 archived 卡

```ts
// src/memory/RefinedMemoryStore.ts:733
const candidates = file.cards.filter(c => c.status !== 'archived' && ...);
```

**我的 P4 实现要点**：`semanticScore` 计算必须**在 archived 过滤之后**做，否则算完又会被过滤掉。

### 3.2 `markUsed` 二态化：`markInjected` / `markVerified`

```ts
// markInjected: 纯记账，不写盘不影响衰减（注入路径每轮调）
// markVerified: 原位刷新 lastUsedAt+count+1，直写持久化（成功后调）
```

**我的 P4 实现要点**：
- 注入路径（`PromptBuilder.appendMemoryCards`）只调 `markInjected`，**不调**本模块
- `embedCache.set()` 类似 `markInjected`——纯内存记账，**不**直写持久化（避免每轮写盘）
- 仅当用户显式确认或 score ≥ 阈值时才 `embedCache.flush()` 落盘

### 3.3 `CompactResult` 扩展字段（v3 契约）

```ts
// src/cli/repl/compactService.ts:37
export interface CompactResult {
  ok: boolean;
  removed: number;
  kept: number;
  summary: string;
  beforeTokens: number;
  afterTokens: number;
  message: string;
  generation?: CompactGeneration;        // { turnCount, lastTurnId }
  coveredTurnIds?: string[];             // 被摘要覆盖的轮次 id
  summarySource?: 'model' | 'fallback' | '';
  syntheticTurn?: Turn;                  // compact 标记事件内嵌
}
```

**我的 P5 实现要点**：
- `compactSessionL1()` / `compactSessionL2()` 必须返回兼容这些字段
- L1 中期摘要：用 `summarySource: 'model'` + `syntheticTurn` + `coveredTurnIds`
- L2 长期摘要：可走 `fallback`（确定性段落摘要）兜底
- 触发 L1/L2 时也要走 `appendCompactMarker`（v3 新增）

### 3.4 `PromptBuilder [M1] 卡号单一序列`

```ts
// src/cli/repl/PromptBuilder.ts:434
private lastInjectedCardIds: string[];
// 跨 L1 与溢出块连续，顺序==lastInjectedCardIds
```

**我的 P4 实现要点**：加 `semanticScore` 时**不能破坏卡号序列**，必须按现有 L1 → overflow 顺序追加。

### 3.5 `runAgentTask` 的 `memory_injected` 事件 + ContextSnapshot

```ts
// runAgentTask 在每任务记录 ContextSnapshot(promptHash + injectedCardIds)
```

**我的 P6 / U6 实现要点**：M4 集成要走 `memory_injected` 事件触发 embed 缓存预热。

---

## 4. 与其他主力的接口契约（更新）

### 4.1 给 W2（Doer）— `RefinedMemoryStore.loadFiltered` 增强

- 构造接 `embedProvider?: EmbeddingProvider` + `embedCache?: EmbeddingCache`
- 卡片新增字段 `semanticScore: number`（注入时计算，缓存友好）
- **新排序公式**：`0.5 × weight + 0.2 × keywordRelevance + 0.3 × semanticScore`
- ⚠️ 在 archived 过滤之后算 semanticScore（v3 兼容性）

### 4.2 给 W3（Main-A）— 注入顺序

- `PromptBuilder` 注入顺序改：`TaskState → 卡 → Event → 当前任务 → 压缩`
- P5 三级摘要注入的是"压缩后的历史"，由 Main-B 提供 `compactSessionL1()` / `compactSessionL2()`（U4 末定义签名）

### 4.3 给 W1（Leader）— 接口评审要点

| 决策点 | 我的建议 | 备选 | 状态 |
|---|---|---|---|
| `embed` 是 sync 还是 async？ | **sync（v0）**，预留 Promise 包装 | 全部 async（更统一但慢） | 待 Leader 拍 |
| 4096 桶大小是否要可配？ | **要**（`.panshalach.json` `embedding.buckets`）| 写死 4096 | 待 Leader 拍 |
| 是否要支持 batch embed？ | **要**（`embedBatch` 可选方法）| 不需要 | 待 Leader 拍 |
| 余弦相似度是否工具化？ | **要**（导出 `cosineSimilarity`）| 内嵌在 Provider 内 | 待 Leader 拍 |
| P5 `compactSessionL1/L2` 与 v3 `CompactResult` 兼容 | **必须**（继承 generation/coveredTurnIds/summarySource/syntheticTurn） | 重写独立类型 | 默认 |
| P4 `semanticScore` 计算时机 | **archived 过滤后** | 之前（会被过滤掉）| 默认 |

---

## 5. 待 Leader（W1）9/14 前拍板

- [ ] 同意 `EmbeddingProvider` 接口签名（含 sync/async 二选一）
- [ ] 同意 4096 桶默认大小（是否写入 `.panshalach.json` schema）
- [ ] 是否同意 `LocalNGramHashProvider` 作为 v0 默认实现（零外部依赖）
- [ ] `cosineSimilarity` 工具函数是否需要单独抽出（vs. 内嵌）
- [ ] P5 三级摘要是否继承 v3 `CompactResult`（继承 vs. 独立）

## 6. 待 Doer（W2）U2 启动前对齐

- [ ] `RefinedMemoryStore` 构造接 `embedProvider/embedCache` 的注入点（哪个字段、什么默认值）
- [ ] markInjected / markVerified 二态化与 embed 缓存策略的对齐
- [ ] embed 缓存 TTL 策略（永久？7 天？与 MemoryMark v3 一致？）

## 7. 待 Main-A（W3）U4 启动前对齐

- [ ] PromptBuilder 注入顺序改动的具体位置
- [ ] L1/L2 摘要触发后保留什么结构（结构化字段？摘要块？）

## 8. 测试计划

| 文件 | 阶段 | 覆盖 |
|---|---|---|
| `tests/memory/embed.test.ts` | U1 | `LocalNGramHashProvider` 幂等性 / 维度 / 桶分布 / 边界（空字符串） |
| `tests/memory/cosine.test.ts` | U1 | 余弦边界（同向量=1 / 正交=0 / 零向量=0 / 维度错抛错） |
| `tests/memory/SemanticSearch.test.ts` | U5 | 跨卡语义召回（注入路径端到端，含 archived 过滤） |
| `tests/repl/MultiLevelCompact.test.ts` | U5 | L0/L1/L2 触发条件 + 保留结构（generation/coveredTurnIds/syntheticTurn） |

## 9. 风险与降级

| 风险 | 触发 | 降级 |
|---|---|---|
| 中文/代码混合召回差 | U2 末测试 fail | `semanticScore` 默认关闭；走 keyword 优先 |
| 桶分布偏斜（短文本大量空桶） | U1 测试 | 改用 TF 长度归一化，或文本长度阈值 |
| 9/14 接口契约 PR 不通过 | Leader 评审 fail | 9/15 stand-up 集中协调；签名可微调 |
| Doer 端 markInjected 缓存 TTL 不一致 | U2 与 W2 冲突 | 双方在 handover 同步；默认 TTL=永久 + 手动失效 |
| P5 L1/L2 与 v3 CompactResult 不兼容 | U4 测试 | 强制走继承，failure 即拒绝合入 |

## 10. 9/14 评审目标（5 个接口签名全员对齐）

- [ ] `OpenAICompatClient.complete` → `ModelClientOutput`（W1 · Leader 自审）
- [ ] `EmbeddingProvider.embed(text)` / `cosineSimilarity`（W4 · 我）
- [ ] `MemoryEvent.append/query/listTopics`（W3 · 王佐）
- [ ] `TaskState.record* / getOrCreate`（W3 · 王佐）
- [ ] `compactSessionL1 / compactSessionL2`（W4 · U4 末追加，必须兼容 v3 CompactResult）

## 11. 我的下一步

- [x] 9/4 周五：起草本 handover + embed.ts 骨架
- [x] 9/5 周六：发现 memory v3 兼容性，更新 handover §3
- [x] 9/5 周六：搬 embed.ts 到 src/memory/ + commit `3f0d40b` + push + 提 **PR #1** https://gitee.com/Kultur/pangu-harness/pulls/1（源 zhaotianang1 → 目标 develop）
- [ ] 9/6~7 周末/周一：等 Leader 评审 PR #1；按意见调整
- [ ] 9/7 周一 U1 D1 上午：`git fetch origin develop` + `cat handover/*` + 看 PR 评论
- [ ] 9/7 周一 D1 下午：完成 embed.ts 的单元测试 + 自查（`npx tsc --noEmit` + `npm test`）
- [ ] 9/8 周二 D2：commit 测试 + push + 提 PR-2（追加测试）+ 完善 handover §4-6