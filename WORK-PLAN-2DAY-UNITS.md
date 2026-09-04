# WORK-PLAN-2DAY-UNITS.md — 9/7–9/24 18 天 4 主力并行计划

> 配套：`WORK-PLAN-MAIN-LEARN.md`（4 主力 + K 学习位人力模型）/ `AGENT-CONTRIBUTION.md`（规范）/ `docs/panshalach/ROADMAP-NEXT.md`（P1–P8 路线）。

## 0. 时间线与硬约束

```
9/7-8   | 9/9-10  | 9/11-12 | 9/13-14 | 9/15-16 | 9/17-18 | 9/19-20 | 9/21-22 | 9/23-24
U1      | U2      | U3      | U4      | U5      | U6      | U7      | U8      | U9
周一    | 周三    | 周五    | 周日    | 周二    | 周四    | 周六    | 周一    | 周三
```

**硬约束**：
- **9/24 交付端到端 MVP**：CLI 接真 openPangu + 记忆闭环 + 事件+状态机 + 语义检索 + 多级摘要 + eval runner + 项目书
- **9/24 项目书 ≤1000 字概述 + 完整解决方案 + 创新点 + 部署 + 评测 + 总结**（国创赛需求）
- **kultur 在国创赛系统提报**（走国创赛后台，不在 git 流程里）
- **4 主力每 2 天 = 一个独立可交付单位**（不能跨单位跨主力强依赖）
- **每单位完成 = 代码 + 测试 + 文档 + 当日日志 + handover 更新 + PR 描述引 handover**

**4 主力对应人**（按注册卡）：
- 翟苑皓（zhaiyuanhao）— Leader / W1 / P1 openPangu
- 王浩宇（wanghaoyu）— Doer / W2 / P2 记忆闭环 + P6 runner
- 王佐（wangzuo）— Main-A / W3 / P3 事件+状态机
- 赵天昂（zhaotianang）— Main-B / W4 / P4 语义 + P5 多级摘要

---

## 1. 4 主力 9 单位任务矩阵

| 单位 | 翟苑皓（Leader / W1） | 王浩宇（Doer / W2） | 王佐（Main-A / W3） | 赵天昂（Main-B / W4） |
|---|---|---|---|---|
| **U1 9/7-8** | openai-compatible 透传 `message.tool_calls` / `delta.tool_calls`；返回 `ModelClientOutput` | `RefinedMemoryStore.markUsed`；PromptBuilder 注入前 markUsed | `src/memory/events.ts`：`MemoryEvent` 类型 + `MemoryEventStore`（jsonl append/query） | `src/memory/embed.ts`：`EmbeddingProvider` 接口 + `LocalNGramHashProvider` + 余弦 |
| **U2 9/9-10** | ModelProvider env 注入泛化（`PANSHA_<PROV>_*`）；`getModelContextLength` 跨 provider | `PanshalachChaser.solveIssue` 落定调 `refine+save`；返回 `refined: {added,merged}` | `src/memory/taskState.ts`：`TaskState` 接口 + 持久化 | `RefinedMemoryStore.loadFiltered` 加 `semanticScore`；`embedCache` 持久化 |
| **U3 9/11-12** | `/model list` 通用化；Adapter 去品牌（`getEngineeringIronLawsHeader` 等，保 alias） | m1-acceptance 升级到真 openPangu 路径；`runAgentTask.done` 下发 `refined` | `src/memory/eventExtractor.ts`：从 trajectory 抽事件 | `.panshalach.json.example` 加 `embedding.provider` 字段 |
| **U4 9/13-14** | 评审 W2/W3/W4 接口契约 PR；`npx tsc --noEmit` EXIT=0；分支对齐 stand-up | `scripts/eval/run-eval.mjs` 骨架：A/B/C 三档 + T1-T5 stub | `/task` CLI 子命令（`src/cli/repl/commands/TaskCommand.ts`） | `compactService` 三级摘要 L0（保持）+ L1（中期 12k+ 摘要） |
| **U5 9/15-16** | 远端 hook 部署协调（kultur 在服务器侧 `chmod +x` + 替换 `KULTUR_KEY_FINGERPRINT`）；CI gate 端到端验证 | `scripts/eval/smoke-eval.mjs` mock 模式跑通 | `tests/memory/EventStore.test.ts` + `tests/repl/TaskState.test.ts` 绿 | `tests/memory/SemanticSearch.test.ts` + `tests/repl/MultiLevelCompact.test.ts` 绿 |
| **U6 9/17-18** | 合并所有分支到 develop（`git merge --no-ff feature/<pinyin>1`） | 真 openPangu 端点跑 A/B/C 出 `scripts/eval/results/<date>.json` | M3 集成测试：trajectory → event 落盘 + TaskState 注入 | M4 集成：embed 缓存 + 三级摘要联动 + `memory search-semantic` |
| **U7 9/19-20** | 端到端评审 + 修复 + 收口 | 5 任务族端到端验证（T1 约束 / T2 跨文件 / T3 长文档 / T4 resume / T5 compact） | 事件流图人工验收 + 任务状态演示 | 注入预算 + 资源消耗实测 + ARCHITECTURE.md §5 填表 |
| **U8 9/21-22** | `docs/panshalach/SUBMISSION.md`（项目书）+ 完整解决方案 + `EVALUATION.md` §4 填真实数据 + `DEPLOY-CN.md` 终版 | 评测 CSV + runner 报告 + 用例统计 | 事件/状态演示数据 + 截图 | 语义检索 demo + 多级摘要资源数据 |
| **U9 9/23-24** | kultur 在国创赛系统提报；终轮 test 全绿；`npx tsc --noEmit` EXIT=0；525+ 用例全绿；`verify-panshalach-cleanup.mjs` PASS；CHANGELOG 加 0.6.0 条目；项目复盘 | 525+ 用例全绿 + verify-panshalach-cleanup PASS + ARCHITECTURE.md 闭环图完成 | 事件/状态测试全绿 + EVALUATION.md 完整 | 摘要/语义测试全绿 + DEPLOY-CN.md 完整 + SUBMISSION.md 项目书完成 |

---

## 2. 18 天里程碑（4 主力必须对齐的日期）

| 日期 | 里程碑 | 4 主力共同交付 | 评审
|---|---|---|---|
| **U4 周日 9/14** | 接口契约 PR 全合入 develop | types.ts / openai-compatible.ts / events.ts / taskState.ts / embed.ts 5 文件签名落定 | Leader 评审 + 互评 |
| **U5 周二 9/16** | 当日日志 + handover 全绿 | 525+ 用例 + smoke-eval + verify-panshalach-cleanup 全 PASS | CI gate 自动 |
| **U6 周四 9/18** | 真 openPangu 端点跑通 A/B/C | results/&lt;date&gt;.json 落盘 | Leader 评审 |
| **U7 周六 9/20** | 端到端评审收口 | 5 任务族 + 三件套全联通 | 全员 stand-up |
| **U8 周一 9/22** | 项目书 + 三份交付物 | SUBMISSION.md ≤1000 字概述 + 完整方案 + ARCHITECTURE/EVALUATION/DEPLOY-CN | Leader 终审 |
| **U9 周三 9/24** | **交付日** | kultur 在国创赛系统提报；develop 收口；项目复盘 | — |

---

## 3. 单位内每日节奏（每人 2 天一单位）

| 时间 | 行动 |
|---|---|
| **D1 上午** | `git fetch origin master develop` + `cat docs/agent/handover/feature-*.md` + 写 `docs/agent/handover/feature-<pinyin>-handover.md`（如果有未 resolved 项指向我，去解决） |
| **D1 下午** | 写代码 + 当日工作日志第一条 |
| **D1 晚** | 自查：`npx tsc --noEmit` + `npm test`（相关子集）+ `verify-panshalach-cleanup.mjs` |
| **D2 上午** | commit + 追加日志 + push + 提 PR + PR 描述引用 handover |
| **D2 下午** | 评审对别人的回应 + 写"我暴露的接口"到自己的 handover |
| **D2 晚** | 周 stand-up（如在周一/周三/周五）— 同步阻塞点给 Leader |

---

## 4. 风险与降级

| 风险 | 触发 | 降级 |
|---|---|---|
| openPangu 端点不可用 | U3 末仍无法 ping | 改用 mockFetch 模式；U6 真端点可后移到 U7 |
| 跨主力契约未对齐 | U4 周日 review fail | 周一/二集中协调；K+1 学习位加入做对接 |
| 评测 runner 不稳定 | U5 smoke-eval fail | 切到 L1+L2（去掉本地 v0 语义检索）；先保 CLI+记忆闭环能跑 |
| 项目书超 ≤1000 字概述 | U8 周一 | Leader 砍冗余技术细节到附录；概述保留"目标/产品/技术愿景/创新点/差异化" 5 段 |
| kultur 9/24 提报前发现 git 未合 develop | U9 周一/二 | Leader 立即 `--no-ff` 合并所有 feature 分支 + force-push master（如授权） |

---

## 5. 学习位（K）加入窗口

- U5 周二 stand-up 上拍 K（默认 0，可 +1~2）。
- 挂靠方向：通常 1 个挂 Leader（DEPLOY-CN.md + 文档同步）、1 个挂 Doer（runner 测试 + CHANGELOG）。
- 学习位**不**接 W1-W4 owner 任务；做"看、学、改小"。

---

## 6. 提交后动作（9/24 后）

- 各主力删除 `feature/<pinyin>1` 分支归档到 `feature/<pinyin>1.submission-v0.6.0` tag
- kultur 在仓库内打 `v0.6.0-submission-mvp` tag
- 复盘会：4 主力 + kultur，写 `tasks/postmortem/2026-09-24-submission.md`
- 项目书 SUBMISSION.md 与 3 份交付物保留在 `docs/panshalach/`，作为后续 1.x 迭代基线