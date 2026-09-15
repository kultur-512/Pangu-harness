# 交接声明 — B7 事件层销项 + B11 通道记忆覆盖（wangzuo1 → 各分支）

- **日期**：2026-09-15
- **发起分支**：wangzuo1（王佐）；`wangzuo2` 内容已按 Leader 指示合并回本分支（fast-forward）
- **commit**：`95c3e4f`（B7）/ 本批（B11 + 合并冲突解决）
- **性质**：常规（内部语义修复 + 加性参数；导出签名不变）

## 背景
ROADMAP-NEXT §B7（事件层三项遗留）与 §B11（两通道 chat 记忆覆盖缺口）本批销项。
B11 是**团队源码里 2026-09-14 已注明"补齐属独立工作项"的申报缺口**，非新增需求。

## 我改变了什么（行为差异，依赖方需知）

### B7（`rolloutStore.ts`）
1. **rewind 事件现在被 replay 消费**（此前只写审计、resume 时跳过）
   - 影响：`resumeSession` / `--resume` 恢复出的会话，在曾执行过 `/rewind` 的会话上**比以前短且正确**——此前已回退的轮次会在 resume 时复活。**这是修复**；若测试断言依赖旧行为需更新（本批全量 1396 例已跑，无此类断言）。
2. **compact 标记回放幂等**：同一标记重放两次不再产生重复合成轮。在线 `applyCompactResult` 语义不变。
3. **分支解析成本**：`listBranches` / `listSessionTree` 从 O(文件数 × 链深) 次整文件读降为 O(文件数)。返回结果语义不变。

### B11（`PanshalachChaser.ts` + `Repl.ts`）
4. **complete-only 回退通道的 chat `basePrompt` 现在内联记忆块 + 【最近对话】段**
   - 仅影响「只实现 `complete()`、无 `chat`/`streamChatMessages`」的客户端。messages 通道（有 `chat`/`streamChatMessages`）**不受影响**——仍走独立 system/user 消息组装。
5. **classic REPL 的 chat 意图改传原始输入 + `chatMemoryBlock` + `chatRecentTurns`**
   - 与 `runAgentTask`（server/SSE/headless 路径）行为对齐。classic 的 chat 直答此前零记忆零上下文。
   - **只影响 chat 意图**；execution/search 路径的 solveIssue 入参不变（仍传 enriched）。

## 我暴露的接口（可选依赖）
- `directBranches(sessionId, index?)`：新增**可选**第二参数（预建索引）。不传时行为与旧版一致。
- 其余导出面不变：`replayInto` / `listBranches` / `listSessionTree` / `isBranch` 签名同旧；
  `PanshalachChaser` 的 `SolveConfig.chatMemoryBlock` / `chatRecentTurns` 本就存在（本批只是补齐消费点）。

## 依赖我的人需要知道
- **王浩宇（R6 评测 runner）**：评测大量生成 rollout 文件，本批后 `/tree`、`listBranches` 不再随目录变大退化；若 runner 涉及 `/rewind` 会话的 resume 长度断言，注意修复方向（会话变短且正确）。
- **赵天昂**：无影响（`/task`、eval fixture 与 rolloutStore 分支解析、chat 通道无交集）。
- **Leader**：CHANGELOG 加 0.8.8 段；ROADMAP-NEXT §B7/B11 标销项；版本 0.8.0-rc → **0.8.8**（对齐 CHANGELOG 现存最高段 0.8.7；团队 package.json 自 0.8.4 起未 bump，如需统一口径请裁）。

## 各分支需要做什么
- 无强制动作。基准验证：`npx tsc --noEmit` EXIT=0 + `npm test` **1401 例（1400 pass + 1 skip + 0 fail）**
  + `verify-panshalach-cleanup` / `check-protected-files` / `verify-m2-e2e` 三契约 PASS（后者需先 `npm run build`）。
- 追加两处现状核实（供 Leader 排期参考，**本批未动**）：
  - **B3 已由团队修复**（`b598e60` A3：REPL 补传 windowTokens）——无需重做。
  - **B4 属逃生门语义非缺陷**：`PromptBuilder.buildStableSegment` / `buildVolatileSegment` 的
    唯一生产者在测试内（`tests/loop/messagesLoop.test.ts`），**无任何生产调用方**传
    `stableSegment`/`volatileSegment` → chaser 的 `messagesEnabled` 恒假 → messages 通道在
    生产路径不可达（与 `scripts/eval/` 从不设 `PANSHA_MESSAGES_MODE` 的事实一致，评测基线
    全部跑在文本路径）。接线会一次性切换全部评测口径，属 S 级改动，需 Leader 决策后再动。

## 阻塞我
- 无。等 Leader 评审合入 develop。

---

## 续批追加 — B5（MCP 结果验证尾标策略）

- **日期**：2026-09-15
- **性质**：常规（内部行为修复；导出签名不变）

### 我改变了什么
1. **MCP 工具结果走独立分支且不带任何 VERIFICATION 尾标**（`engineAdapter.describeResult`）
   - 行为差异：MCP 调用成功的结果段落 head 从 `TOOL_OK: <name>`（或其他子串命中的前缀）**统一为 `MCP_OK: <name>`**，且**不追加** `VERIFICATION: PASS/APPLIED/NEUTRAL`。
   - 依据：MCP 服务自述输出无外部退出码佐证；`classifySignal` 的 `PASS` 是 `completed` 的唯一来源，若 MCP 自述能触发 PASS 即等于第三方工具可伪造任务成功。
   - **若你的测试断言依赖 MCP 结果的 head 前缀或尾标，需同步**（本批全量 1401 例已跑，仓库内无此类断言；`tests/tools/executor.test.ts` 的 MCP 用例只断言 `DENIED`/审批计数，不受影响）。
2. **连带修复**：`mcp_srv_read` 等含 `read`/`glob`/`grep` 子串的 MCP 名此前被内置工具的 `name.includes(...)` 命中，误贴 `VERIFICATION: NEUTRAL`（=PARTIAL：清零连败计数）。现 MCP 分支前置于所有内置工具判定。
3. **内置工具尾标行为完全不变**（bash=PASS / write·edit=APPLIED / read·glob·grep=NEUTRAL）。

### 依赖我的人需要知道
- **王浩宇（R6 评测）**：若评测涉及 MCP 工具，其 `verification.signal` 现在确定性地**不因 MCP 成功而变 PASS**——这正是 B5 的意图（防自述伪装）。内置六工具的 PASS/FAIL 口径未变，**评测基线不受影响**。
- **赵天昂**：无影响。
- **Leader**：ROADMAP-NEXT §B5 标销项；CHANGELOG 0.8.8 段增补 B5 小节 + 全量数 1396→**1401**。

### 基准验证
`npx tsc --noEmit` EXIT=0 + `npm test` **1401 例（1400 pass + 1 skip + 0 fail）** + 三契约 PASS。

---

## 续批追加 2 — B2-4（env-delta 增量跨任务真正生效）

- **日期**：2026-09-15
- **性质**：常规（内部缺陷修复 + 一处字段搬迁；导出签名不变）

### 我改变了什么（行为差异，依赖方需知）
1. **env-delta 基线从 `PromptBuilder` 实例字段搬到 `Session.prevEnvSnapshot`**
   - 行为差异：连续第二个任务起，**环境未变时不再注入 `【环境变更】` 块**（此前因基线恒 null，每个任务都白注入一行 cwd）。**这是修复**（增量语义首次真正生效）。
   - 影响面：所有走 `PromptBuilder.buildForTask` 的路径（server/SSE/headless/classic）。**评测 prompt-diff 基线会变**——若你的 A/B 展品脚本按 prompt 逐字节比对，注意这一处减少了一行 cwd 注入。
2. **新增 `Session.prevEnvSnapshot?: { cwd; branch?; fs? }`（public，**不落盘**）**
   - 有意不进 `toFile()`：git status 是易变现场，跨进程回放陈旧基线会产生假 delta。已在字段注释与使用处注释写明理由。
   - 若你构造 `Session` 时想预置基线（如评测回放），直接赋 `session.prevEnvSnapshot = {...}` 即可。

### 依赖我的人需要知道
- **王浩宇（R6 评测）**：prompt-diff 展品脚本若逐字节比对，会看到"环境未变任务的 prompt 少一行 cwd"——这是修复带来的确定性变化，两侧（A/B 档）同样受影响，**差分关系不变**。
- **赵天昂**：无影响。
- **Leader**：ROADMAP-NEXT §B2 该子项标销项；§B3 标注"已由 b598e60 修复"、§B4 标注"逃生门语义需决策"；CHANGELOG 0.8.8 增补 B2-4 小节（全量数 1401→**1405**）。

### 基准验证
`npx tsc --noEmit` EXIT=0 + `npm test` **1405 例（1404 pass + 1 skip + 0 fail）** + 三契约 PASS。

### 现状核实（未动，供排期）
- **B3 已由团队修复**（`b598e60` A3）——无需重做。
- **B4 属逃生门语义非缺陷**：三段分段无生产调用方 → messages 通道生产不可达；接线属 S 级改动，需 Leader 决策。
- **B1 本机三次并发复跑未复现**（3/3 绿）；疑与负载/CI 环境相关。
