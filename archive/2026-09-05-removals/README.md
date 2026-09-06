# 归档：性能叙事装置摘除（#1-#7，2026-09-05）

- **归档决定**：产品主（探测报告 7 项逐项裁决：#1 全单次、#2/#3/#4/#5/#6 摘除、#7 走三路）
- **主题**：记忆管理为重点的 harness，除去对性能（token/运行时）与叙事有影响的装置

> **0.7 追加归档（2026-09-05）**：`continuationJudge.archived.ts`（外置验证判官——0.6.4 双层终止的判官层。
> 摘除原因：判官是唯一外层续跑源（maxRollouts 已全档为 1），对"出现过工具但未验证"的回合注入
> 续跑 ≤2 次，弱模型伪工具调用下最坏 20 步×3 轮不收敛（实测 905s）。双层终止收缩为单层。
> `TestTimeOrchestrator.archived.ts`（runMultiple 编排器——count/sort/预算裁剪在恒单 rollout 下
> 全为死路径；Trajectory 类型已迁 `src/loop/trajectory.ts`，空批保护并入 chaser）。

## 裁决与落地对照

| # | 裁决 | 落地 |
|---|---|---|
| 1 | 多 rollout → 全单次 | `maxRollouts` 六档全 1；chaser 移除显式并行 |
| 2 | critique 摘除 | loop 不再发起自我批判模型调用；事件不再发射；`decideShouldCritique` 移除；休眠保留 `buildCritiquePrompt`/上下文装配（恢复即用） |
| 3 | 仓库扫描+锚点注入摘除 | chaser 的 explore/锚点/锚点上下文全部移除；本目录含两份归档文件 |
| 4 | 静态分析预跑摘除 | chaser 不再起跑执行 tsc/eslint；`/review` 命令与 Reviewer 本体保留 |
| 5 | 风格头摘除 | `getPromptHeader`/`getVerificationHint`/`scoringHints` 删除（BenchmarkProfiles 保留 get） |
| 6 | FailureMemory 轨道摘除 | chaser/loop/engineAdapter 全链移除注入与记录；FailureMemory.ts 保留（UserConfirmation/MemoryCommand 兼容）；失败信号唯一归口 = `RefinedMemoryStore.refine` 任务落定提炼 |
| 7 | 解析走三路 | `useUniversal` 恒真：OpenAI JSON/文本/`<>` XML 容错探测统一；strictStructured 仅影响 XML 探测深度；StrictStructuredToolAdapter 独占路径退场（类与测试保留） |

## 归档文件

- `RepoExplorer.archived.ts`（原 `src/context/RepoExplorer.ts`）：仓库扫描 + 锚点推荐 + `AnchorMemory`
- `ContextManager.archived.ts`（原 `src/context/ContextManager.ts`）：锚点注册 + 上下文预算估算（其估算职责已由 PromptBuilder/ContextSnapshot 承担）

critique 运行块、`decideShouldCritique`、`getPromptHeader` 等未落文件——完整原文见 git 历史 `09125b4`（本归档的前一版）。

## 恢复方法

1. 把两份 `.archived.ts` 复制回 `src/context/`（去掉 `.archived` 后缀）；
2. chaser 的 Phase 探索块按 git 历史 `09125b4` 版本的 `src/PanshalachChaser.ts:177-243` 恢复；
3. loop 的 critique 块/`decideShouldCritique` 按 `09125b4` 版本 `src/loop/VerifyCritiqueLoop.ts:418-487,577-612` 恢复；
4. `tests/loop/CritiqueContext.test.ts` 中被移除的 2 个用例按同版本恢复；
5. 跑 `npm test` + `npx tsc --noEmit`。

## 行为影响摘要

- **token**：单 rollout + 无 critique 调用 + 无风格头/锚点/静态分析注入 → 单任务成本约为原 max/ex/pangu 档的 1/3~1/5；
- **解析**：弱格式模型（openPangu-1B/7B）在 high 档不再被 `<>` 严格解析独占卡死——三路容错；
- **记忆语义**：失败信号唯一归口 RefinedMemoryStore（§7.1 refine 生产调用点接线后生效）；
- **早停**：score 两值化后首个成功 rollout 即停。
