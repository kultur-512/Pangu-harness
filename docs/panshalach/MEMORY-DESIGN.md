# Panshalach 记忆模块设计

> 面向"长程上下文管理"的记忆增强层深挖。本文档描述记忆的数据模型、写入源、读取注入、维护策略，以及**已知差距 → 补齐路线**。

## 1. 设计总则

1. **外置优于内记**：关键事实外置到 prompt 预算（注入），不依赖模型记住 N 轮前的 token。
2. **事实与经验分离**：会话资产(回合/事件)记"发生了什么"，记忆卡记"该怎么做"(教训/经验/偏好)。
3. **注入是稀缺资源**：任何记忆都先过"档位可见性 + 参照文件交集 + 关键词相关性 + 预算"闸门再进 prompt。
4. **确定性维护**：衰减/合并/去重/容量/缓存全部确定性规则 → 可离线测试、可复现、不烧 token。
5. **写入闭环**：真实任务结束即提炼沉淀（含压缩补漏），记忆随使用生长。

## 2. 记忆的分层（长程 = 把"分层"做对）

| 层 | 载体 | 时间尺度 | 已实现/规划 |
|---|---|---|---|
| L0 会话内实时 | 轨迹/验证信号/FailureMemory | 单任务内 | 已实现 |
| L1 结构化记忆卡 | `.zorge-memory.json`（failure/success/preference） | 跨会话（天~月） | 已实现 |
| L2 压缩摘要 | `[COMPACT]` 合成轮（模型摘要 + 逐轮 brief） | 长会话 | 已实现 |
| L3 事件记忆 | 语义事件流（decision/constraint/…） | 跨会话审计 | **规划(P3)** |
| L4 任务状态 | TaskState（原始需求/决策/未决/进度） | 跨多轮任务 | 雏形(feature_list) → **规划(P3)** |
| L5 语义索引 | n-gram 向量 v0 → 国产向量库/embedding | 检索 | **规划(P3)** |

## 3. 数据模型

### 3.1 RefinedMemoryCard（src/memory/RefinedMemoryCard.ts）
见 [ARCHITECTURE.md §2.1](ARCHITECTURE.md)。要点：kind / category / memoryCategory(档位可见性+分类半衰期) / summary(建设性一句话) / weight·count / lastSeen·firstSeen·lastUsedAt / applicableTiers / referencedFiles / pinned / status·mergedFrom。容量每类10·总200；半衰期 30d；`LESSON_TEMPLATES` 提供失败→建设性教训模板（"重要教训：… / 建议重点避免：…"）。

### 3.2 事件记忆（规划 schema，`memory/events.ts`）
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

### 3.3 任务状态 TaskState（规划，演进自 FeatureTracker）
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
| 循环实时信号 | 每步违规/失败 | FailureMemory（会话内） | 已实现 |
| **回合提炼** | 任务落定（拿到 bestTrajectory + score + attemptCount + 反馈） | refine→卡→save | **规划(P2)**（当前无生产调用点，是最紧要缺口） |
| 压缩补漏 | compact 移除轮次中 score≥85 | success 卡（hash 去重） | 已实现 |
| 用户 | /memory remember [--pin] / forget / import | preference/删除/批量 | 已实现 |
| 合并 | /memory merge 或后台 | 2-gram 同主题合并（原卡 archived） | 已实现 |
| 事件/状态 | P2/P3 各落定点 | events/TaskState | 规划 |

## 5. 读取与注入（loadFiltered 全链）

```
用户任务文本
  → collectCurrentWorkspaceFiles(@path + 路径-like + 最近2轮)  [PromptBuilder]
  → 关键词提取(过滤 /@# 前缀, ≥2字符)
  → loadFiltered({
       tier, currentWorkspaceFiles?, keywords?,
       (Chaser 路径再加 maxCards + reservePreferenceSeat)
     })
     ├─ 归一化旧卡(kind/memoryCategory/refs 默认补齐)
     ├─ taskStyle + tier 可见性(architecture 恒可见)
     ├─ P2-D 参照文件交集: referencedFiles ∩ currentFiles ≠ ∅ → 只留交集；空 → 回退
     ├─ 有效权重: pin=1 │ preference基0.6 │ 半衰期(按类×count) │ 4段(1/.7/.4/.1) │ <0.3 丢弃
     ├─ 关键词相关性 +1/命中(cap3)
     ├─ 排序 0.7·w + 0.3·rel（再按 count）
     └─ top-N(档位 3/6/8/10) · preference 保 1 席
  → 【相关记忆】注入(截120/来源标签/ghost余量提示)          [L1]
  → (standard/high) 探索期 auto-pull ≤5 张、预算≤700token  [M3.2 overflow]
```

**Cached 变体** `loadFilteredCached`：filter 归一 + 30d decayStep 作 key，8 槽 LRU 投影缓存；任务内快照冻结、写入 invalidate 重建。

**注入形态（最终 prompt 片段）**：
```
【相关记忆】
  - [失败教训] 重要教训：写入前应先完整读取目标文件…
  - [成功经验] 已验证可行的做法：score=92 …
  - [用户偏好] 项目优先用 pnpm
（另有 3 张相关记忆未注入，/memory 查看）
```

## 6. 维护策略（确定性）

- **衰减**：加载时算 effective，不写回（读不刷新鲜）。四段：age<half/2 → 1.0；<half → .7；<2half → .4；else .1；且 <0.3 丢弃。分类半衰期：failure/general 90d、implementation/insight 180d、architecture 365d；count≥2 半衰期×count；preference 基 0.6（默认低于事实卡）；pin 冻结。
- **合并（M3.3a）**：active 且 effective≥0.5 的候选，2-gram 公共词元≥2 归组（组≤6）；合并 summary≤800、count=Σ、decayWeight 从 now 起算（防 Σcount 霸榜）；原卡 `status=archived` 软删（可回滚）。
- **容量**：按 category 每类≤10（新者优先）→ 总≤200（按 weight×count 淘汰）。
- **投影缓存**：多槽 LRU(≤8)，写操作 invalidate，跨衰减阶梯自动重建。
- **.gitignore**：自动追加记忆文件名。

## 7. 已知差距 → 补齐路线（逐条）

### 7.1 回合写入闭环缺失（P2 · 最紧要）
- **现状**：`RefinedMemoryStore.refine()` 无生产调用点；任务结束了却不沉淀。
- **修复**：在 `Repl.executeTask` 完成分支 / `runAgentTask` / sseInteractive 回合落定，调 `refine({trajectory: bestTrajectory, taskStyle, applicableTiers:[tier], attemptCount, userFeedback})` → `save()` → `invalidateProjection()`。attemptCount 语义：1 = 一次通过（触发 success 提炼信号）。

### 7.2 无 markUsed（读即用永不衰减 bug 未正式修）
- **现状**：`loadFiltered` 注释声明"使用刷新应由 markUsed 承担"，但无实现 → 卡永远按 lastUsedAt=lastSeen 衰减（一旦写入即只随时间降权，不因真实使用升鲜）。
- **修复（P2）**：注入命中后按任务边界批量 `markUsed(cardIds)`：`lastUsedAt=now` + count 可选 +1，单次写盘 + invalidate。频控说明：任务边界批量，避免每步写盘；保留投影缓存一致性。

### 7.3 无语义检索（P3）
- **v0 零依赖**：`memory/embed.ts` 字符 2-gram 词袋向量（对 summary 建索引，离线构建 O(n·k)），注入候选先召回 top-K，再与关键词相关性融合。
- **v1 可插拔**：接口留 provider 位，可选国产向量库 / openPangu embedding；注入层不变。

### 7.4 无业务事件层（P3）
- rollout jsonl 是回合审计；补 `MemoryEvent`（§3.2）按业务语义抽事件，`/memory events [--since|--topic]` 可查，注入按 近+高重要性+topic 命中。事件与卡的关系：事件是"流水账"，卡是"归纳结论"；P2 回合提炼可从事件流再归纳。

### 7.5 无跨轮任务状态机（P3）
- FeatureTracker 只有一个 in-progress + nextStep；补 TaskState（§3.3），把"原始需求/决策/未决/进度/已验证/风险"做成长轮任务的注入锚（优先级高于普通卡），这也是评估报告"任务状态续接"维度的支撑。

### 7.6 一次性摘要 → 多级滚动（P3）
- 现压缩=一次摘要+保 6 轮；滚动多级：长期粗粒度(每 ≥N 轮对早期再摘要) + 中期结构化(卡片/事件) + 近期逐字。压缩时保留"被移除轮"的成功信号补提卡已实现，可复用。

### 7.7 存储名/branding（P6）
- `.zorge-memory.json` / `.zorge.json` / `~/.zorge` / `ZORGE_*` → Panshalach 名（迁移脚本 + 读旧写新 fallback）。

## 8. 与评估指标的映射

| 评估维度（见 EVALUATION.md） | 由哪个记忆机制支撑 |
|---|---|
| 中期信息保持（早期约束多轮后仍遵守） | L1 卡 + L4 任务状态（原始需求锚）注入 |
| 跨文件/跨章节关联 | P2-D 参照文件过滤 + L3 事件 refs |
| 压缩后保持 | L2 压缩摘要 + 补漏提炼 + L3 事件（压缩不丢可归纳信号） |
| 任务状态续接 | L4 TaskState + rollout resume/branch |
| 记忆增长质量 | 写入闭环(P2) + 确定性衰减/合并防污染 |
