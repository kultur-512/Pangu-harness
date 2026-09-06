# 交接声明 — U1/R1/R2 任务落定记忆闭环（refine→save 写闭环 + markVerified 信号源）

- **日期**：2026-09-05
- **发起分支**：wanghaoyu1（王浩宇）
- **commit**：157922a + b4b0388
- **性质**：常规（`solveIssue` 返回新增可选字段，向后兼容；已在 REFACTOR-ASSESSMENT §4 申报）

## 我需要别人确认的接口（resolved: false）
- 无。

## 我已经确认的接口（resolved: true）
- [x] 翟苑皓: refine 生产调用点接线（zhaiyuanhao1-2026-09-05.md:47 指派）——157922a 落地，`solveIssue` 收口统一调用 `finalizeTaskMemory`。
- [x] 赵天昂: R6 评测基建骨架（run-eval.mjs 契约留 `runOne()` TODO）——U4 王浩宇接入时消费本闭环返回的 `refined` 统计，无冲突。

## 我暴露的接口（别人依赖）
- `solveIssue()`（src/PanshalachChaser.ts）：返回对象新增可选 `refined?: { added; merged; written; capped }` + 内部使用 `verifiedCount`；原有 `success/bestTrajectory/.../message` 不变。
- `finalizeTaskMemory(store, input)`（PanshalachChaser.ts 导出）：统一收口服务 = `refine → save → markVerified`；输入 `{ trajectory; success; taskStyle; applicableTiers?; injectedMemoryCardIds?; attemptCount? }`；返回 `{ refined?; verifiedCount }`。三个生产入口（Repl / RunCommand / runAgentTask）共用，禁止各自复制判定。
- `collectToolFilePaths(trajectory, opts?)`（RefinedMemoryStore.ts 导出）：两代轨迹文件路径收集（当前 ToolCall `toolName/params[]` + legacy `name/args`），`opts: { writes?; reads? }`。
- `markVerified(cardIds, now?)`（RefinedMemoryStore.ts，接口契约 v3 二态之一）：原位直写持久化（lastUsedAt=now + count+1），不走 mergeAndCap，避免 count 翻倍。
- 信号源判定（R2）：仅「success + 真实验证步（didRealVerification / ALL_TESTS_PASSED / EXIT_CODE:0）+ 已注入卡 referencedFiles ∩ provenFiles≠∅」才刷新；provenFiles = changedFiles ∩ 验证覆盖文件集，验证命令无文件参数时轨迹级兜底 = changedFiles。

## 阻塞我
- 无。U2 真实端到端验收（真实任务注入卡→改文件→真实验证）由对应负责人/后续单位执行，不在本批范围。

## 各分支需要做什么
- 常规交接，无破坏性变更。rebase develop 后若 `solveIssue` 返回解构处报缺字段，只增不删即可。
- 门槛复验：`npx tsc --noEmit` EXIT=0；`npm test` 546 pass + 1 skip + 0 fail。
