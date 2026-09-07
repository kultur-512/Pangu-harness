# HERMES 二次对齐调研（0.7.4）

> 性质：**调研报告（0.7.4）——纯调研，不实施**。对上轮（0.6.x 时期）hermes-agent（NousResearch/hermes-agent）对齐调研中**未采纳项**的二次判定。
> 仓库：Pangu / 烛龙 Zhulong，当前版本 0.7.3（HEAD=0088d87）。竞赛语境：9/24 交付时间盒（`WORK-PLAN-2DAY-UNITS.md` U1-U9），评测证据链（R6）是唯一得分来源，工程美观从属于证据链。
> 裁决基线：`docs/panshalach/ROADMAP-NEXT.md` §3.2 缺陷登记表 + §4「已裁决不做/推迟」表；`USABLE-PLAN-0.7.3.md` 的 L 级六项「明确不进本轮」。

## 0. 方法与信息源

**本地读码**：`src/cli/repl/{sseInteractive,rolloutStore,compactService,compactStrategies,Session,SessionStore,ModelProvider}.ts`、`src/cli/repl/commands/{Model,Run,Simulate}Command.ts`、`src/cli/repl/Repl.ts`、`src/cli/repl/types.ts`、`src/loop/VerifyCritiqueLoop.ts`、`src/server/runAgentTask.ts`、`src/PanshalachChaser.ts`。所有 file:line 证据均来自本次真实读取，非臆测。

**hermes 上游**（GitHub raw 直读，逐条注明出处）：
- 文档：`docs/micro-compaction.md`、`website/docs/developer-guide/session-storage.md`
- 源码：`agent/micro_compaction.py`、`agent/context_compressor.py`、`agent/session_persistence.py`、`agent/conversation_loop.py`、`agent/turn_facade.py`

> 说明：hermes 上游为 Python（非本仓库的 TS 零依赖）。其上下文管理/会话持久化已全面演化为「SQLite WAL + append-only flush + 消息级 `_DB_PERSISTED_MARKER` 去重」架构（见 §4），与本仓库「jsonl 账本 + 整文件快照」是两条不同路线。逐项判定时只取其「机制语义」，不做代码照搬。

---

## 1. telemetry 单行埋点（hermes 的 micro-compaction 统计/事件遥测）

### hermes 侧机制（出处）

- `agent/micro_compaction.py` 的 `_emit_micro_compaction_telemetry`：每次 micro-compaction pass 结束时发**一行 content-free JSON**，字段含 `event:"micro_compaction"`、`outcome`、`tokens_before/after/delta`、`occupancy_pct`、`threshold_tokens`、`passes_total`、`tokens_saved_total`、`duration_ms`。关键设计约束写在注释里：**telemetry 只读缓存值，绝不触发同步 `/models` 探测，绝不阻塞 turn**（`micro_compaction.py:315-341`）。
- `agent/context_compressor.py` 的批量压缩遥测 `_begin_compression_telemetry`（`context_compressor.py:1658-1682`）与 `_finalize_compressed` 里的单行 log `Compressed: %d -> %d messages (~%d tokens saved, %.0f%%)`（`context_compressor.py:4548-4549`）。
- 文档 `docs/micro-compaction.md`「Measuring it」节给出完整 JSON 样例，明确 `occupancy_pct` 是"窗口占用率"这一头号指标。

### 本仓库现状（file:line 证据）

**已存在等价物，但不在「埋点」形态，而在「append-only 事件账本」。**

1. `src/cli/repl/rolloutStore.ts:83-99` `appendEvent`——`fs.appendFileSync` 追加一行 JSON，**永不 throw**、返回 bool，正是「单行落盘」机制本身。
2. 压缩标记已携带计量：`rolloutStore.ts:129-141` `appendCompactMarker(sessionId, syntheticTurn, coveredTurnIds, beforeTokens, afterTokens)`——`beforeTokens/afterTokens` 已经在账本里，只是没像 hermes 那样再拼一行「过程遥测」。
3. 业务事件通道已就位：`rolloutStore.ts:123-125` `appendAgentEvent`，事件枚举 `types.ts:186-199`（`AgentEventKind`），其中 **`context_compacted`（`types.ts:199`）已定义但当前零发射点**——全仓库 `appendAgentEvent` 唯一调用在 `runAgentTask.ts:140`（`memory_injected`）。
4. 写入失败可观测：`rolloutStore.ts:50` `AuditedRolloutEvent` + `:68-79` 会话级 `auditWriteFailures` Map（0.7.1 C5），`appendEvent` 失败后下一次成功落盘事件带 `auditStatus:'write-failed:N'`。

### 判定：**推迟（到 R8/多级摘要，9/24 后）**

### 依据

机制**已存在**（append-only jsonl + beforeTokens/afterTokens + auditStatus），缺的只是「每次 compact 再补一行 process 遥测」。这不是功能缺口，是观测粒度。9/24 前唯一得分路径是 R6 评测证据链（`ROADMAP-NEXT.md` §3 R6：A/B/C 消融 + `results/<date>.json`）；把一条 `context_compacted` 事件接进 compact 虽只需 ~20 行，但它既不改善 A/B 因果，也不进任何评测指标（`EVALUATION.md` 只认 `injectedCardIds`/verification 信号/失败分类）。若真要做，也应是 R8（多级摘要 L1/L2）的配套观测（envelope 触发率），而非独立项——ROADMAP 已把「envelope 触发率」列为 R8 过程指标（`ROADMAP-NEXT.md` §3 R8）。

### 预估成本（若做）

- `compactService.ts:158`（`appendCompactMarker` 处）补一行 `appendAgentEvent(session.id, { kind:'context_compacted', ... })`，或复用 `appendCompactMarker` 已有 before/after 字段新加一个 `type:'telemetry'` 事件：约 15-25 行。
- `rolloutStore.ts` 加一个 `appendCompactTelemetry` 封装（可选）：约 10 行。
- 测试：`tests/repl/compactService.test.ts` 加 1 个断言（compact 后 `readAgentEvents` 读到 `context_compacted`）：约 20 行。
- 合计 **约 50 行 + 1 测试**。**不采纳理由**：R6 优先；且 `context_compacted` 枚举悬空（`types.ts:199`）是个「已留口的欠账」，留在 R8 一并销。

---

## 2. 不对称压缩（用户原文/固定头永不摘要，只有中段可压缩）

### hermes 侧机制（出处）

- `docs/micro-compaction.md`「Your messages are never compacted」节：micro-compaction 只吸收 **assistant 轮**（assistant + tool results），**故意跳过 user 消息**——"what you typed is never summarized"。文档明言这是刻意的不对称：压缩派生材料（assistant 的叙述/工具输出），保留事实源（用户指令），因为 "use the existing retry helper, don't add a new one" 这类指令一旦被改写就会六轮后反噬。
- `docs/micro-compaction.md`「What it never touches」节：除 user 轮外，**头（system prompt + 开场消息）**与**尾（token-budget 的最近窗口）**也永不摘要，只在中段工作。
- `agent/micro_compaction.py` `_find_one_exchange`：`while ... not _turn_row(idx, ("assistant",)): idx += 1`——跳过 user 消息直到找到 assistant（`micro_compaction.py:64-93`）；`_protect_head_size` 保护 system + `protect_first_n`（`context_compressor.py:3881-3890`）；`_ensure_last_user_message_in_tail` 保证最后一条 user 消息在受保护尾部（`context_compressor.py:3947-3963`）。

### 本仓库现状（file:line 证据）

**无不对称保护——所有轮次（含用户原文）一律进摘要。**

1. `src/cli/repl/compactService.ts:19` `KEEP_RECENT=6`；`:107-108` `removed = turns.slice(0, length-6)` / `kept = turns.slice(-6)`——**纯按位置切，不看角色**。用户 prompt 与 assistant 结果同池被摘要。
2. `src/cli/repl/compactStrategies.ts:27-35` default 策略 `buildPrompt` 把 `removed` 逐轮 `turnBrief`（含 `userInput` 前 80 字）塞进摘要 prompt——**用户原文主动进入摘要模型的输入**。
3. `compactService.ts:78-82` `fallbackSummary` 同样把每轮 `turnBrief`（含 userInput）写进 `[COMPACT 历史摘要]`。
4. `compactService.ts:144-151` synthetic turn 的 `userInput` 被整体替换成 `"[COMPACT] 已压缩 N 轮历史"`——**被摘要覆盖的区间里，用户原文在会话内已不可再逐字恢复**（只在 rollout jsonl 的原始 turn 事件里留存）。
5. 无「头保护」概念：`system/tier contract` 是 PromptBuilder 每次重建时注入的（`PromptBuilder.ts` 见 §5.3 of solution/05），不在 `session.turns` 里，故 compact 天然不动它；但「会话首条用户指令」与「最新用户指令」并没有被显式钉住（`slice(-6)` 只保证最后 6 轮，其中可能是纯 assistant/tool 轮，最新用户指令未必在 kept 里）。

### 判定：**推迟（并登记为 R8 前置约束，9/24 后）**

### 依据

这是五个未采纳项里**唯一有真实语义价值**的一条：不对称压缩直接决定「长程任务里用户约束是否会被摘要冲掉」，与 `solution/05-压缩与长期连续性.md` §5.19-5.21「非对称：压缩派生材料、保留事实源」的精神完全一致。但：①当前 compact 是**单次 batch**（触发式 `slice`），hermes 的不对称是**rolling micro-compaction** 的属性，二者不是同一层；②R8（多级摘要 L1/L2）已经在路线图里（`ROADMAP-NEXT.md` §3 R8），前置 R3 Turn 结构化（王浩宇 `c139528` 已 rebase 待合入）。不对称保护应作为 R8 envelope 的**验收约束**落地（L1 摘要必须显式标注「已保留的用户指令原文」+ 保头尾），而不是现在单独再切一刀 compact。

### 预估成本（若现在做）

- `compactService.ts:107-108` 改 `removed/kept` 分区逻辑：识别 user 角色 turn 并强制保留（需 `Turn` 有角色区分——当前 `Turn` 无 role 字段，`userInputType` 只有 `command/task/multiline` 三值，见 `types.ts:45`，**不能可靠区分 user vs assistant**，要先给 Turn 加 role 或依赖 rollout 的 role 序列）——这是隐性前置成本，约 +40-80 行 + `types.ts` 加字段 + 迁移。
- `compactStrategies.ts` 摘要 prompt 加「用户指令原文必须逐字引用」约束：约 +10 行。
- 测试（不对称保留断言）：约 +40 行。
- 合计 **约 100-150 行 + Turn 契约变更 + 迁移**。**不采纳理由**：与 R8 强耦合，且需要 Turn 角色字段这一 L 级前置，9/24 前不划算。

---

## 3. TurnController 抽取（sseInteractive.ts 2152 行巨函数）

### hermes 侧机制（出处）

hermes 没有叫 `TurnController` 的单一文件，但把回合控制流**彻底模块化**：`agent/conversation_loop.py`（1600 行）只做「一个 user turn」的驱动（模型调用 + 工具分发），而回合的收尾/校验/截断/空响应/重试/门控被拆成 `agent/turn_finalizer.py`、`turn_response_check.py`、`turn_response_intake.py`、`turn_empty_response.py`、`turn_retry_state.py`、`turn_stop_gates.py`、`turn_truncation.py`、`turn_overflow.py`、`turn_facade.py`（turn 准入门面）等 **~30 个单职责模块**（GitHub tree 可证）。`turn_facade.py` 头注释明写「Extracted from run_agent.py」。

### 本仓库现状（file:line 证据）

- `src/cli/repl/sseInteractive.ts` **2152 行**。顶层 `startSseInteractive` 从 `:396` 起，内部嵌套 `runTaskViaSse`（`:726` 起，单函数体约 725 行）、`handleLocalCommand`（`:1993` 起）、`mapSseToBridge`（`:1451`）、`renderSseEvent`（`:1604`）等 ~20 个闭包函数，全部闭包共享一个巨型 `session/ctxUsedChars/ctxWindowTokens/bridge` 状态。
- `ROADMAP-NEXT.md` §3.2 已登记：「sseInteractive 巨函数拆分（现 2147 行）… L 级；拆分须测试先行」（`ROADMAP-NEXT.md:101`）；同表 `:100` 登记「消息数组协议重构」L 级。
- `ALIGNMENT-REVIEW-0.7.3.md` §三 明确：「巨函数拆分（turnController 化）…本轮刻意不做，避免与命题主线争夺时间」（`ALIGNMENT-REVIEW-0.7.3.md:25`）。

### 判定：**推迟（继续推迟到 9/24 后，1.x）**

### 依据

① 9/24 前 R6 评测是唯一得分来源，且当前有三个队友分支待合入（`ALIGNMENT-REVIEW-0.7.3.md` §四：wangzuo1 基座 still behind 7，需要 rebase 通知）。拆分 2152 行巨函数是「优秀」的差距、不是「基本可用」的差距（`ALIGNMENT-REVIEW-0.7.3.md:25` 原话），且 ROADMAP 已登记「须测试先行」——现在没有 2152 行的覆盖基线，拆分即裸奔。② 拆分与「消息数组协议重构」同属 L 级跨文件手术，二者应一起立项（拆分的真正收益是让消息协议重构有处可落）。③ 两个 P0 真 bug 已在 0.7.4 计划里单独修（`PLAN-0.7.4-FOR-CLAUDECODE.md` B2/B6），不依赖拆分。

### 预估成本（若现在做）

- 抽出 `TurnController`/`runTaskViaSse` 单函数 → 独立模块：约 **300-500 行重构**（状态经参数/接口传递，而非闭包共享）。
- 覆盖基线先行：需为现 2152 行补集成测试锁定行为（否则重构无回归保障）：约 **200-400 行测试**。
- 合计 **约 500-900 行 + 高回归风险**。**不采纳理由**：与评测主线零因果，且无测试基线可安全执行。

---

## 4. 会话存储 append-only 化（崩溃安全）

### hermes 侧机制（出处）

- hermes 已**从 JSONL 迁移到 SQLite**：`website/docs/developer-guide/session-storage.md` 明写「This replaces the earlier per-session JSONL file approach」，架构是 `~/.hermes/state.db`（WAL 模式）+ `messages` 表全量历史 + `messages_fts` 全文检索 + `compression_locks` 跨进程锁。
- append-only 语义体现在 flush：`agent/session_persistence.py:191-193`「Append-only flush: a mid-turn persist of scaffolding would commit a synthetic turn the end-of-turn drop cannot un-write」——逐消息打 `_DB_PERSISTED_MARKER` 去重，`append_messages_batch` 事务写入（`session_persistence.py:204-214`），`atomic_json_write` 用于可选 JSON session log（`session_persistence.py:24`）。崩溃安全靠「SQLite WAL + 事务 + 标记去重」，不是 JSONL 追加。

### 本仓库现状（file:line 证据）

**已经是「双轨」，其中权威轨 append-only，快照轨整文件重写——但快照轨已降级为非权威。**

1. **权威轨 = rollout jsonl，append-only、崩溃安全**：`rolloutStore.ts:83-99` `appendEvent` 用 `fs.appendFileSync` 逐行追加，`readEvents`（`:175-185`）读时逐行 `try/catch` 跳过 torn/corrupt 行——损坏一行不影响其余（崩溃中途断行可恢复）。这是 resume 的唯一权威源（`rolloutStore.ts:14-15` 注释：replay jsonl；`SessionStore.load` 只是 jsonl 缺失/损坏时的兜底）。
2. **分支复制也 append**：`forkRollout` 逐行 `appendRawLine`（`rolloutStore.ts:291-297`，`appendFileSync`），唯一例外是 `:328` 一次 `writeFileSync` 建分支文件（一次性创建，可接受）。
3. **快照轨 = SessionStore，整文件重写**：`SessionStore.ts:39-43` `save()` 用 `writeFileSync(JSON.stringify(file))` 整体覆盖；`Session.ts:120-135` `toFile()` 序列化完整 `turns` 数组。调用点仅三处：`Repl.ts:148`（`process.on('exit', () => this.saveSession())` 退出兜底）、`Repl.ts:162`（`/session load` 换会话前落旧会话）、`SessionCommand.ts:24`（`/session save` 手动命名快照）。
4. 即：**rollout 每轮 appendTurn（`sseInteractive.ts:1380` / `Repl` 走 `SessionStore` 无 appendTurn）、SessionStore 每轮/退出整文件重写**——但 SessionStore 的重写从不参与 crash-resume（resume 走 jsonl），它只是「命名快照 + 退出兜底」的遗留物。

### 判定：**拒绝（9/24 内不改；也不值得列为 1.x 高优先）**

### 依据

崩溃安全**已经由 rollout jsonl 提供**，这正是 hermes 早期「per-session JSONL」的同一思路。`SessionStore` 的整文件重写是**非权威快照**（兜底/命名保存），把它 append-only 化没有证据链收益——评测不读它、resume 不靠它。更关键：hermes 自己已经走相反方向（JSONL → SQLite），说明「append-only 化」不是终点而是手段，其真正价值（可检索、事务、去重）对 9/24 的 A/B/C 消融无用。ROADMAP §4 已把「事件 hash-chain / 持久化幂等键」列为 9/24 后按需立项（`ROADMAP-NEXT.md:104`），SessionStore append-only 化同属此档。

### 预估成本（若做）

- `SessionStore.ts:39-43` 改为按 delta 追加 + 读时重建：约 60-100 行 + 迁移读旧格式。
- 但**无收益点**（无消费方）。**不采纳理由**：解决一个不存在的问题，且与 hermes 自身演进方向相反。

---

## 5. 模型切换计量重置的剩余面

### hermes 侧机制（出处）

- hermes 把上下文窗口解析做成**惰性缓存 + 主动失效**：`context_compressor.py` `context_length` 是 property，setter 里 `if value == self._resolved_context_length: return`，否则重设 `_resolved_context_length` 并**清空派生的 `_threshold_tokens/_tail_token_budget/_max_summary_tokens`**（`context_compressor.py:1750-1770` 区段）。切换模型 → 设 context_length → 派生预算全部失效重算。
- 会话级状态重置：`on_session_reset()`（/new /reset）与 `on_session_end()` 各自清空所有 per-session 计数器/冷却/摘要状态，防止「旧模型窗口的计量污染下一会话」（`context_compressor.py:1642-1657, 1804-1844`）。

### 本仓库现状（file:line 证据）

**SSE 主路径已正确（0.7.3 已做），残留面在 classic 路径。**

1. **主路径（sseInteractive）已闭环**：
   - `sseInteractive.ts:924-930` `/model <name>` 切换时 `session.model = sub; ctxUsedChars = 0; ctxWindowTokens = resolveCtxWindowTokens()`——**旧模型字符计量清零 + 窗口立即重取**，注释明写「下次任务边界也会再取一次兜底」。
   - `sseInteractive.ts:1171-1172` 任务边界再重取 `ctxWindowTokens = resolveCtxWindowTokens()`。
   - `sseInteractive.ts:531-541` `resolveCtxWindowTokens`：env 覆盖 → `provider.getModelContextLength(session.model)` → `≤0/256000` 哨兵 → 32768 保守回落。
   - 引擎侧同源：`runAgentTask.ts:54-64` `resolveWindowTokens` 同一回落逻辑，`:173` 每任务 `windowTokens` 传入 loop。
   - `VerifyCritiqueLoop.ts:167` `windowTokens` 字段，`:668-671` 组装超 70% 窗口裁中段（保前 2 + 后 2）。
   - `ModelProvider.ts:500-526` `getModelContextLength` 惰性解析、每次重查 `remoteContextsCache`（`/model list` 后 `adoptRemoteModels` 更新），`invalidateProviderCache`（`:578-582`）清缓存。

2. **残留面 A（classic/Repl 路径，窗口预算未挂到 loop）**：`Repl.ts:341-347` 取 `contextLen` 只用于**给模型的提示头**（`:360-362` 注入「上下文上限约 N K」），但 `executeTask` 调 `solveIssue` 时（`Repl.ts:427-492`）**没有传 `windowTokens`**——对比 `runAgentTask.ts:173` 有传、`PanshalachChaser.ts:276` 有透传。后果：classic 路径的 loop 里 `windowTokens` 恒 `undefined`，`VerifyCritiqueLoop.ts:668` 的 `if (this.windowTokens && ...)` 永不触发 → **classic 路径无「超 70% 裁中段」保护**。
   - 且 `Repl.ts:347` 的 fallback 是 `: 256000`（provider 缺失时），与主路径 32768 保守值不一致（虽然 provider 存在时走 `getModelContextLength` 内部已回落 32768，故实际影响仅在 provider 为 null 的边界）。

3. **残留面 B（classic 无 auto-compact，故无「compact 阈值随切换刷新」问题，但也无保护）**：`Repl.ts` 全文无 `shouldAutoCompact`/`estimateSessionTokens` 调用（grep 仅命中 `CompactCommand` 注册 `:36/:98`），即 classic 路径**根本没有基于窗口的自动压缩/裁中段**——模型切换后「旧计量残留」在 classic 里表现为「无计量可残留」，但代价是「长会话 8K 模型仍可能爆窗」。这一点与 0.7.3 在 SSE 主路径的修复（`USABLE-PLAN-0.7.3.md` #6）未覆盖 classic 一致。

4. **残留面 C（ModelCommand 的注册表切换，classic 侧）**：`ModelCommand.ts:350` `session.updateModel(name)` 只改 `session.model`，**不重置任何计量**（classic 无 `ctxUsedChars` 变量，故「清零」无从谈起；但也没有触发 `getModelContextLength` 的窗口刷新动作——好在其每次 `executeTask` 开头都重取 `getModelContextLength`，`Repl.ts:345-346`，无缓存陈旧问题）。

### 判定：**建议采纳（最小面，仅 classic 路径补齐，约 20 行）**

### 依据

这是五个未采纳项里**唯一建议采纳**的一项，但范围收窄到「残留面 A」：classic/Repl 路径的 loop 窗口预算没有像 `runAgentTask` 那样传 `windowTokens`，导致 0.7.3 的「窗口预算挂真值 + 超 70% 裁中段」在 classic 降级路径上不生效。它属于**已交付功能（0.7.3 T2#6）的入口覆盖遗漏**，而非新功能——`USABLE-PLAN-0.7.3.md` #6 自己写的「落点：compactService、sseInteractive、VerifyCritiqueLoop」并未包含 Repl.ts，故是一个诚实的小欠账。补它不挤占 R6 主线（改动 <30 行、纯透传、方向与 `runAgentTask.ts:173` 完全一致），且能消除「文档说挂真值、classic 实不挂」的口径不一致。残留面 B/C 不采纳：B 是「classic 无 auto-compact」的更大缺口，牵出 classic 路径整体的窗口策略，应随消息数组协议重构（L 级）一并处理；C 无实际陈旧问题。

### 预估成本

- `Repl.ts:341-347` 改用 `resolveWindowTokens`（从 `runAgentTask.ts` import，或内联同逻辑）+ `:427-492` 的 `solveIssue` 配置里补 `windowTokens: <解析值>`：约 **15-25 行**。
- 可选：把 `:347` 的 `: 256000` fallback 对齐为 32768 保守值：约 **3 行**。
- 测试：`tests/` classic 路径断言「切到 modelContexts=8192 后 loop 收到 windowTokens=8192」（或等价）：约 **25 行**。
- 合计 **约 40-50 行**。**采纳理由**：主路径已有同款实现（`runAgentTask.ts:54-64/173`），照抄最小透传，零架构改动，闭环一个已交付功能的入口覆盖。

---

## 6. 汇总表

| # | 项 | 判定 | 一句话依据 | 何时做 |
|---|---|---|---|---|
| 1 | telemetry 单行埋点 | **推迟** | 机制已存在（rollout append-only jsonl + before/afterTokens + auditStatus），缺的只是过程观测粒度，对 R6 因果无用 | R8 多级摘要配套（envelope 触发率），9/24 后 |
| 2 | 不对称压缩（用户原文/固定头永不摘要） | **推迟** | 有真实语义价值，但需 Turn 角色字段（L 级前置）+ 与 R8 envelope 强耦合，当前 compact 是单次 batch 非 rolling | R8 前置约束，9/24 后 |
| 3 | TurnController 抽取 | **推迟** | L 级跨文件手术、无 2152 行覆盖基线、与评测主线零因果；ROADMAP 已登记「须测试先行」 | 1.x，与消息数组协议重构一并立项 |
| 4 | 会话存储 append-only 化 | **拒绝** | 崩溃安全已由 rollout jsonl 提供；SessionStore 是非权威快照，append-only 化无消费方，且 hermes 自己反向演进（JSONL→SQLite） | 不立项（同 ROADMAP §4 事件 hash-chain 档） |
| 5 | 模型切换计量重置剩余面 | **建议采纳（最小面）** | 0.7.3「窗口预算挂真值」在 classic/Repl 路径漏传 `windowTokens`（`Repl.ts:427-492`），是已交付功能的入口覆盖遗漏，照抄 `runAgentTask.ts:173` 透传即可 | 本轮即可（约 40-50 行，不挤占 R6） |

**总体结论**：五项未采纳项中，四项维持「推迟/拒绝」，唯一建议采纳的是第 5 项的**最小子集**（classic 路径补传 `windowTokens`）。这一结论与上轮 hermes 对齐报告的方向一致——hermes 的结构性优势（rolling micro-compaction、SQLite 会话、turn 模块化）对 9/24 的 A/B/C 消融证据链无因果贡献，而对「基本可用」的闭环（第 5 项）才值得花 <50 行补一个诚实的小欠账。
