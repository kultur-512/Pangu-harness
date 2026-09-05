# WORK-PLAN-2DAY-UNITS.md — 9/7–9/24 18 天 4 主力并行计划

> 配套：`AGENT-CONTRIBUTION.md`（规范）/ `docs/panshalach/ROADMAP-NEXT.md`（P0–P5 技术路线）/ `tasks/agents/`（4 主力注册卡）。
> 基线：翟苑皓（Leader）的 `docs/agent/handover/feature-zhaiyuanhao-long-context-memory-review.md` 修订报告（READY-FOR-REVIEW）—**记忆卡降级为 prompt 投影，事件 / 状态 / 投影 三层事实源分离**。

## 0. 时间线与硬约束

```
9/7-8   | 9/9-10  | 9/11-12 | 9/13-14 | 9/15-16 | 9/17-18 | 9/19-20 | 9/21-22 | 9/23-24
U1      | U2      | U3      | U4      | U5      | U6      | U7      | U8      | U9
周一    | 周三    | 周五    | 周日    | 周二    | 周四    | 周六    | 周一    | 周三
```

**硬约束**：
- **9/24 交付端到端 MVP**：CLI 接真 openPangu + AgentEvent 事实源 + TaskState 上下文管理 + MemoryProjection 经验复用 + eval runner + 项目书
- **9/24 项目书 ≤1000 字概述 + 完整解决方案 + 创新点 + 部署 + 评测 + 总结**（国创赛需求）
- **kultur 在国创赛系统提报**（走国创赛后台，不在 git 流程里）
- **4 主力每 2 天 = 一个独立可交付单位**（不能跨单位跨主力强依赖）
- **每单位完成 = 代码 + 测试 + 文档 + 当日日志 + handover 更新 + PR 描述引 handover**

**4 主力对应人**（按注册卡）：
- 翟苑皓（zhaiyuanhao）— Leader / W1 / P0 重构 + P1 openPangu 接入
- 王浩宇（wanghaoyu）— Doer / W2 / P0 markUsed 二态收尾（已落大半）+ ContextCompiler + P6 runner
- 王佐（wangzuo）— Main-A / W3 / P0 AgentEvent + TaskState + 状态机
- 赵天昂（zhaotianang）— Main-B / W4 / P0 ContextSnapshot + MemoryProjection 增强

---

## 1. 重排后的 9 单位任务矩阵（按审查报告 P0-P3 重排）

| 单位 | 翟苑皓（Leader / P0 重构 + P1） | 王浩宇（Doer / W2 / P0 拆解 + P6 runner） | 王佐（Main-A / W3 / P0 事件+状态） | 赵天昂（Main-B / W4 / P0 投影+快照） |
|---|---|---|---|---|
| **U1 9/7-8** | 接口契约 v2（✅ types.ts/rolloutStore schema/tool_calls 透传已提前落地 2026-09-04，见 df7a119）；`memory/events.ts`、`memory/taskState.ts` 落地 | MemoryCard v2 字段按对抗评审裁决**不做**（伪 provenance），provenance 走 rollout `context` 事件（✅ 已落）；~~markUsed 拆三态~~ ✅ 二态已落（bf5f4a7） | `MemoryEventStore` 在现有 rolloutStore JSONL 之上扩展 schema（追加 `taskId / kind / refs`） | `TaskState` 持久化：`tasks/agents/<pinyin>/task_state.json`；`/task status/risk/decide` CLI |
| **U2 9/9-10** | ✅ 透传已提前落地（df7a119）；转 U3 剩余项 | `MemoryProjection`：5 维评分**按对抗评审裁决推迟**（量纲不同构/utility 无信号源）；保留 `0.7w+0.3rel`；`markVerified` 信号源接线 | `EventExtractor`：trajectory → 增量 `AgentEvent`，保留原始轨迹不删除 | `Assertion` schema（scope/confidence/validFrom/validUntil/evidenceEventIds/provenance） |
| **U3 9/11-12** | ModelProvider env 注入泛化（`PANSHA_<PROV>_*`）+ `getModelContextLength` 跨 provider | `ContextCompiler`：统一预算装箱，替代 `PromptBuilder` 拼接逻辑；`ContextSnapshot` 每次模型调用产出 | TaskState 注入 PromptBuilder L1：`[原始需求] → [记忆卡] → [事件摘要] → [当前任务]`；CLI `/task` 子命令 | `MemoryProjection` 加载：`RefinedMemoryStore.loadFiltered` 改读 Projection 卡片，保留兼容 API |
| **U4 9/13-14** | 评审 W2/W3/W4 接口契约 v2；`npx tsc --noEmit` EXIT=0；分支对齐 stand-up | `scripts/eval/run-eval.mjs` 骨架：A/B/C/C1-C4 五档 + T1-T5 stub | `/task` CLI 集成 + `EventStore` 落盘验证 | `compactService` 三级摘要（以事件 + 状态为投影源，不再仅摘要原始轨迹） |
| **U5 9/15-16** | 远端 hook + CI gate 验证；本批 README/CHANGELOG 加 v0.6.0 入口；`docs/agent/` 骨架修订 | `smoke-eval.mjs` mock 模式跑通 | `tests/memory/EventStore.test.ts` + `tests/repl/TaskState.test.ts` 绿 | `tests/memory/Projection.test.ts` + `tests/repl/ContextSnapshot.test.ts` 绿 |
| **U6 9/17-18** | 合并所有分支到 develop；架构文档 ARCHITECTURE.md 改成"AgentEvent 事实源 + TaskState 控制 + MemoryProjection 投影 + ContextCompiler 管理"五层图 | 真 openPangu 端点跑 A/B/C/C1-C4 出 `scripts/eval/results/<date>.json` | M3 集成：trajectory → AgentEvent → Projection 落盘 + TaskState 注入 | M4 集成：ContextCompiler + ContextSnapshot 落盘 |
| **U7 9/19-20** | 端到端评审 + 修复 + 收口 | 5 任务族端到端验证（T1 约束 / T2 跨文件 / T3 长文档 / T4 resume / T5 compact） | 事件流图人工验收 + 任务状态演示 | 注入预算 + ContextSnapshot 资源消耗实测 + ARCHITECTURE.md §5 填表 |
| **U8 9/21-22** | `docs/panshalach/SUBMISSION.md`（项目书 ≤1000 字概述 + 完整解决方案 + 创新点 + 部署 + 评测 + 总结）+ `EVALUATION.md` §4 填真实数据 + `DEPLOY-CN.md` 终版 | 评测 CSV + runner 报告 + 用例统计 | 事件/状态演示数据 + 截图 | 投影/快照演示数据 + 多级摘要资源数据 |
| **U9 9/23-24** | kultur 在国创赛系统提报；终轮 test 全绿；`npx tsc --noEmit` EXIT=0；529+ 用例全绿；`verify-panshalach-cleanup.mjs` PASS；CHANGELOG 条目齐；项目复盘 | 529+ 用例全绿 + verify-panshalach-cleanup PASS + ARCHITECTURE.md 五层图完成 | 事件/状态测试全绿 + EVALUATION.md 完整 | 投影/快照测试全绿 + DEPLOY-CN.md 完整 + SUBMISSION.md 项目书完成 |

---

## 2. 18 天里程碑（4 主力必须对齐的日期）

| 日期 | 里程碑 | 4 主力共同交付 | 评审
|---|---|---|---|
| **U4 周日 9/14** | 接口契约 v2 PR 全合入 develop | `types.ts` / `openai-compatible.ts` / `MemoryCard` v2 / `MemoryEventStore` / `TaskState` / `Assertion` / `ContextSnapshot` / `ContextCompiler` 接口签名落定 | Leader 评审 + 互评 |
| **U5 周二 9/16** | 当日日志 + handover 全绿 | 525+ 用例 + smoke-eval + verify-panshalach-cleanup 全 PASS | CI gate 自动 |
| **U6 周四 9/18** | 真 openPangu 端点跑通 A/B/C/C1-C4 | results/&lt;date&gt;.json 落盘 | Leader 评审 |
| **U7 周六 9/20** | 端到端评审收口 | 5 任务族 + 五件套全联通（事件/状态/投影/快照/编译器） | 全员 stand-up |
| **U8 周一 9/22** | 项目书 + 三份交付物 | SUBMISSION.md ≤1000 字概述 + 完整方案 + ARCHITECTURE/EVALUATION/DEPLOY-CN | Leader 终审 |
| **U9 周三 9/24** | **交付日** | kultur 在国创赛系统提报；develop 收口；项目复盘 | — |

---

## 3. 五层事实源（叙述骨架）

> 与翟苑皓（Leader）审查报告一致：`RefinedMemoryCard` 从唯一事实源降级为派生 prompt 投影；事实分层如下。

```
User / Tool / Verification / Trajectory
       │
       ▼
append-only AgentEvent       ← 事实源（仅追加，可重放）
       │
   ┌───┴───┐
   ▼       ▼
Assertion  TaskState     ← 事实校验 + 当前控制面
   │       │
   └───┬───┘
       ▼
MemoryProjection          ← 经验复用层（RefinedMemoryCard 兼容 API）
       │
       ▼
ContextCompiler            ← 统一预算装箱
       │
       ▼
ContextSnapshot           ← 每次模型调用的强制审计产物
       │
       ▼
Model Run
```

- **AgentEvent**：append-only，关联 sessionId + taskId，类型已定稿 `src/cli/repl/types.ts`（AgentEventKind）：`user_requirement / decision / constraint / requirement / verified / failure / progress / preference / memory_retrieved / memory_injected / memory_cited / memory_verified / context_compacted`
- **Assertion**：scope/confidence/validFrom/validUntil/status/evidenceEventIds/provenance
- **TaskState**：原始需求/决策/未决/里程碑/已验证/风险/next step
- **MemoryProjection**：由 AgentEvent + Assertion 派生出的 prompt 卡片
- **ContextSnapshot**：每次模型调用的输入审计（assetId / source / priority / tokenCount / validity / renderedPromptHash）

---

## 4. 单位内每日节奏（每人 2 天一单位）

| 时间 | 行动 |
|---|---|
| **D1 上午** | `git fetch origin master develop` + `cat docs/agent/handover/*.md`（有未 resolved 项指向我先解决） |
| **D1 下午** | 写代码 + 当日工作日志第一条 |
| **D1 晚** | 自查：`npx tsc --noEmit` + `npm test`（相关子集）+ `verify-panshalach-cleanup.mjs` |
| **D2 上午** | commit + 追加日志 + push + 提 PR + PR 描述引用 handover |
| **D2 下午** | 评审对别人的回应 + 写"我暴露的接口"到自己的 handover |
| **D2 晚** | 周 stand-up（如在周一/周三/周五）— 同步阻塞点给 Leader |

---

## 5. 风险与降级

| 风险 | 触发 | 降级 |
|---|---|---|
| openPangu 端点不可用 | U3 末仍无法 ping | 改用 mockFetch 模式；U6 真端点可后移到 U7 |
| 跨主力契约 v2 未对齐 | U4 周日 review fail | 周一/二集中协调；K+1 学习位加入做对接 |
| AgentEvent/TaskState 数据流不通 | U5 单测 fail | 退到 rolloutStore 旧 4 事件，临时保持兼容 |
| 项目书超 ≤1000 字概述 | U8 周一 | Leader 砍冗余技术细节到附录；概述保留"目标/产品/技术愿景/创新点/差异化" 5 段 |
| kultur 9/24 提报前发现 git 未合 develop | U9 周一/二 | Leader 立即 `--no-ff` 合并所有 feature 分支 + force-push master（如授权） |

---

## 6. 学习位（K）加入窗口

- U5 周二 stand-up 上拍 K（默认 0，可 +1~2）。
- 挂靠方向：通常 1 个挂 Leader（DEPLOY-CN.md + 文档同步）、1 个挂 Doer（runner 测试 + CHANGELOG）。
- 学习位**不**接 W1-W4 owner 任务；做"看、学、改小"。

---

## 7. 提交后动作（9/24 后）

- 各主力删除自己的工作分支并打 `<pinyin>1.submission-v0.6.0` tag 归档
- kultur 在仓库内打 `v0.6.0-submission-mvp` tag
- 复盘会：4 主力 + kultur，写 `tasks/postmortem/2026-09-24-submission.md`
- 项目书 SUBMISSION.md 与 3 份交付物保留在 `docs/panshalach/`，作为后续 1.x 迭代基线
