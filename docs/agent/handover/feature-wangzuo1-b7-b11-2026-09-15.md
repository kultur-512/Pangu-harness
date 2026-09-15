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
- 无强制动作。基准验证：`npx tsc --noEmit` EXIT=0 + `npm test` **1396 例（1395 pass + 1 skip + 0 fail）**
  + `verify-panshalach-cleanup` / `check-protected-files` / `verify-m2-e2e` 三契约 PASS（后者需先 `npm run build`）。

## 阻塞我
- 无。等 Leader 评审合入 develop。
