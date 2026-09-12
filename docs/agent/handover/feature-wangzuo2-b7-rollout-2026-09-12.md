# 交接声明 — B7 事件层销项（wangzuo2 → 各分支）

- **日期**：2026-09-12
- **发起分支**：wangzuo2（王佐）
- **性质**：常规（内部语义修复 + 内部降复杂度；导出签名不变，`directBranches` 仅增可选参数）

## 背景
ROADMAP-NEXT §B7 登记的三项 `rolloutStore.ts` 工程遗留，本批销项。均为**真实缺陷或性能问题**，非风格整理。

## 我改变了什么（行为差异，依赖方需知）
1. **rewind 事件现在被 replay 消费**（此前只写审计、resume 时跳过）
   - 影响：`resumeSession` / `--resume` 恢复出的会话，在曾执行过 `/rewind` 的会话上**会比以前短且正确**——
     此前已回退的轮次会在 resume 时复活（会话比真实历史长）。**这是修复，不是回归**；若你的测试断言依赖"回退后 resume 仍见旧轮"，需更新。
2. **compact 标记回放幂等**：同一标记重放两次不再产生重复合成轮。在线 `applyCompactResult` 语义不变。
3. **分支解析成本**：`listBranches` / `listSessionTree` 从 O(文件数 × 链深) 次整文件读降为 O(文件数)。返回结果语义不变。

## 我暴露的接口（可选依赖）
- `directBranches(sessionId, index?)`：新增**可选**第二参数（预建索引）。不传时行为与旧版一致（内部自建）。
  预建索引用 `listSessionTree` 内部复用，调用方无需感知。
- 导出面其余不变：`listBranches` / `listSessionTree` / `renderSessionTree` / `isBranch` 签名同旧。

## 依赖我的人需要知道
- **王浩宇（R6 评测 runner）**：评测会生成大量 rollout 文件；本批后 `listBranches`/`/tree` 在大目录下不再退化。
  评测若曾因 `/rewind` 会话 resume 长度异常导致断言困惑，本批已修。
- **赵天昂**：无影响（`/task`、eval fixture 与 rolloutStore 分支解析无交集）。
- **Leader**：`CHANGELOG` 加 0.8.1 段、`ROADMAP-NEXT §B7` 标销项、`MEMORY-DESIGN` L3 行文档滞后同步。

## 各分支需要做什么
- 无强制动作。基准验证：`npx tsc --noEmit` EXIT=0 + `npm test` 1017 例（1016 pass + 1 skip + 0 fail）。

## 阻塞我
- 无。等 Leader 评审合入 develop。
