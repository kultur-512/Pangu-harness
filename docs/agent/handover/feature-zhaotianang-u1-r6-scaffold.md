# Handover — zhaotianang U1 R6 评测基建骨架（v0.6.4 对齐）

> 起草日：2026-09-05（周六前置 · leader v0.6.4 推送当晚）
> 工作分支：zhaotianang1
> 关联 commit：`e362de4` feat(eval): R6 评测基建骨架 / `53c1d02` chore(deps): package-lock.json v0.6.4 同步
> 状态：**U1 9/7-8 骨架完成**（runOne 真实 openPangu 接入留 U4 王浩宇）
> 代码位置：
> - `scripts/eval/results/schema.mjs`（契约源头）
> - `scripts/eval/{smoke-eval,run-eval}.mjs`
> - `tasks/T1-T5/{README.md,fixture.md,verify.sh}`

---

## 1. 范围（U1 R6 已落地）

| 子项 | 文件 | 状态 |
|---|---|---|
| results 契约源头 | `scripts/eval/results/schema.mjs` | ✅ 含 TurnStopReason 6 态 + ABLATIONS + FAILURE_TAXONOMY + JSON Schema + validateResult/newResult |
| mock 自检 | `scripts/eval/smoke-eval.mjs` | ✅ A/B/C/C4 × T1-T5 = 20/20 通过 schema 校验 |
| 主入口 | `scripts/eval/run-eval.mjs` | ✅ CLI + 路径隔离 + dry 模式；runOne() 占位 |
| T1-T5 fixture 占位 | `tasks/T1-T5/{README,fixture,verify.sh}` | ✅ 5 任务族定义 + 验收 rubric + stub |
| .gitignore | 新增 eval results 排除 | ✅ `scripts/eval/results/*` 排除生成物，`schema.mjs` 白名单 |

---

## 2. 我暴露的接口（v0.6.4 对齐）

### 2.1 `scripts/eval/results/schema.mjs` 导出

```js
// 冻结常量（运行时不允许新增）
export const TURN_STOP_REASONS    // 6 态：completed/verification-failed-continue/max-steps/consecutive-failures/aborted/no-verification
export const EVAL_SOURCES         // 'real-openpangu' | 'mock-smoke'
export const ABLATIONS            // {A:'baseline', B:'memory on', C:'B+budget', C4:'B+semantic'}
export const FAILURE_TAXONOMY     // 9 类（none/verification-failed/tool-error/parse-failed/budget-exhausted/aborted/overflow-skipped/line-defense-failed/unknown）
export const VERIFICATION_SIGNALS // PASS/FAIL/ALL_TESTS_PASSED/TESTS_FAILED/NO_VERIFICATION/UNKNOWN

// JSON Schema（runtime 校验用）
export const RESULT_SCHEMA        // Ajv 兼容子集，14 字段 + 3 嵌套对象

// 工具
export function validateResult(obj)            // {ok, errors[]} — 检查 required + enum + type
export function newResult(init)               // 工厂：生成 result 骨架（init 必填 source/ablation/taskFamily/taskId/seed）
export function hashPrompt(s)                 // SHA-256 of normalized prompt
export function stopwatch()                   // () => ms 计时
```

### 2.2 契约关键字段（与 v0.6.4 同步）

| 字段 | 类型 | 来源 | 备注 |
|---|---|---|---|
| `verdict` / `stopReason` | TurnStopReason | `src/cli/repl/types.ts:237` | **6 态必须双向同步** |
| `continueCount` | number | `TestTimeOrchestrator.ts` | 判官续跑次数（0 = 未续跑） |
| `lastError` | string | `TestTimeOrchestrator.ts` | 单 rollout 失败保留 |
| `verification.{signal,exitCode,commands}` | object | verify-critique-loop | 沿用 |
| `memory.{injectedCardIds,verifiedCardIds}` | string[] | ROADMAP-NEXT §3.1 R6 合同 | B 档要求 `injectedCardIds.length >= 1` |
| `prompt.{chars,estimatedTokens,hash}` | object | R6 合同 | `chars` 永不改写为 token |
| `failureTaxonomy` | enum | R6 合同 | **运行时冻结**，新增需改 schema + ROADMAP-NEXT |
| `source` | enum | R6 合同 | `real-openpangu` / `mock-smoke`（路径隔离） |

### 2.3 `scripts/eval/run-eval.mjs` CLI

| flag | 默认 | 行为 |
|---|---|---|
| `--source <real-openpangu\|mock-smoke>` | real-openpangu | 决定输出路径前缀 |
| `--ablation <A\|B\|C\|C4>` | 全部 | 单档运行 |
| `--task-family <T1..T5>` | 全部 | 单族运行 |
| `--seed <int>` | 42 | 跨 ablation seed 对齐（seedSupport=true） |
| `--model-id <provider:model>` | default-from-config | 覆盖默认模型 |
| `--dry` | false | 只打印计划，不写盘（修过：flag 后无值不再吞） |
| `--help` | — | 帮助 |

退出码：`0` 全绿 / `1` schema 校验失败 / `2` provider/fixture 加载失败 / `3` 路径隔离违规

---

## 3. 路径隔离硬约束（R6 合同）

```
real-openpangu → results/<date>.json            （禁止 smoke-* 前缀）
mock-smoke     → results/smoke-<date>.json       （smoke-eval.mjs 唯一产出路径）
```

违规检测在 `runOne()` 之前预检（exit 3）。**这是 ROADMAP-NEXT §3.1 R6 合同点名条款：mock 永不入真实结果表。**

---

## 4. 给王浩宇（W2 / Doer）—— U4 R6 runner 接入点（王浩宇 R1/R2 已确认 2026-09-05）

### 4.1 替换 `runOne()` 占位

`scripts/eval/run-eval.mjs` 当前 `runOne()` 返回 stub 结构，U4 由王浩宇替换为真实 `PanshalachChaser.solveIssue()` 调用。

**契约**（按 ablation 注入差异）：

| ablation | 行为 | 期望 `verdict` | `memory.injectedCardIds` |
|---|---|---|---|
| A | 禁用记忆注入（force empty）| `no-verification`（真溢出）/ `aborted`（超时）| `[]` |
| B | 默认记忆 + markVerified 信号源 | `completed` | `>= 1`（line-defense）|
| C | B + 注入预算上限（按 tier） | `completed` | `>= 1` |
| C4 | B + n-gram 语义检索（R7 `LocalNGramHashProvider`，已在 zhaotianang 分支 3f0d40b 落） | `completed` | `>= 1` |

### 4.2 王浩宇需要新增/补的（U4 范围）

- `runOne()` 真实实现（~80 行替换 + 错误处理 + 超时）
- T1-T5 fixture 实化（issue 正文 + verify.sh 实体化）
- `verify.sh` 返回 0/非 0 映射到 `verification.{exitCode,signal}`
- 报告脚本：配对差 + Wilson 区间（统计单位 = 任务实例）
- 失败分类枚举对照（运行前冻结，本文件 §2.1 已给）

### 4.3 评测防线（ROADMAP-NEXT §3.1 已定）

- **A 档必须真溢出**：mock 不溢出标 `overflow-skipped`（不进长程结论）；真实 openPangu 未溢出需人工裁决
- **B 档零注入 = 防线失败**：标 `line-defense-failed`，不计为有效样本
- **T1×7B×A/B/C 最小 9 runs**：U6 真端点跑通最低门槛
- **envelope 触发率**（T5）：作为过程指标入结果表

### 4.4 王浩宇 R1/R2（commit `157922a`）已落地的契约（2026-09-05 review）

| 项 | 王浩宇答复 | U4 runner 接入方式 |
|---|---|---|
| `finalizeTaskMemory` 返回结构 | **选 A**：改返回 `verifiedCardIds: string[]`（替代 `verifiedCount: number`），仅动 `finalizeTaskMemory` 自身 + 单测 4 处断言，`solveIssue` 只消费 `.refined` 零波及 | runner 从 `chaser.solveIssue()` 返回的 `bestTrajectory.stopReason` + 注入的 `injectedMemoryCardIds` 计算；`verifiedCardIds` 由 `finalizeTaskMemory` 直接返回（落定层语义）|
| `PromptBuilder.lastInjectedCardIds` 暴露 | **无需提 public/getter**；已有 `lastBuildMeta?.injectedCardIds` public | `buildForTask` → `pb.lastBuildMeta?.injectedCardIds ?? []` → `config.injectedMemoryCardIds` 传进 `solveIssue` |
| verdict 映射规则 | 收到，schema 侧我落地 | 见 §2.1 表 + schema.mjs 内嵌映射规则注释 |
| `attemptCount` 防伪造 | 收到；U4 会确保 runOne 里有 attempt 计数来源，避免"缺省 → no-verification"误伤 B 档 | runner 显式传 `attemptCount: 1`（B/C/C4 成功时），A 档不传（强制 no-verification）|
| `signal` 透传 | U4 时一起定 | runner 接 `AbortSignal.timeout(ms)` 传 `config.signal` |

**关键警告**（王浩宇特意强调）：`verifiedCardIds`（真实复用）≠ `injectedCardIds`（注入），schema 别互填。已在 `schema.mjs §2.1 memory` 注释中明确两层语义。

---

## 5. 给王佐（W3 / Main-A）—— TaskState 注入位置（王佐 R5 已落 2026-09-05）

✅ **王佐 R5（commit `c7a1eca`）已落地**：TaskState 持久化层——版本乐观锁 + originalRequirement 锚定 + 事件重建。

U3 王佐原计划把 `TaskState` 注入 `PromptBuilder`（槽位：env/feature 之后、recent-context 之前，KV-cache 友好）。

**对 R6 的影响**：王佐 taskState.ts 已落，`runOne()` 调用 `PanshalachChaser.solveIssue()` 时会自动消费 TaskState——R6 runner 不需要单独处理。验证方法：在 fixture 中显式构造 `TaskState`，跑 B 档看 `injectedCardIds` 是否反映 TaskState 影响。

---

## 6. U2 `/task` CLI + U4 runner 实现注意（王佐 R5 review 沉淀，2026-09-05）

### 6.1 必须处理的 4 项注意（不阻塞王佐 R5，U2/U4 落地时改）

| # | 问题 | 来源 | U2/U4 落地要求 |
|---|---|---|---|
| 1 | `taskId` 命名空间冲突 | 王佐 create() taskId 冲突即抛 | **评测用前缀**：`eval-${taskFamily}-${ablation.toLowerCase()}-${seed}`（如 `eval-T1-a-42`），避免污染用户 taskId |
| 2 | 路径污染 | 王佐默认 `.panshalach-task-state.json` 写 workspace 根 | **U4 runner 必传** `customFilename: '.panshalach-task-state.eval.json'`（或放在 `.tmp/` 已 gitignored 下）|
| 3 | `nextStep` 选填 | 王佐 nextStep?: string | **runner 选填**：成功跑完可写 `TaskState.nextStep = 'verification done'`；失败/异常不写（避免误导） |
| 4 | `memory_injected` 不折叠 | 王佐 STATE_KINDS 故意不含 memory_injected | **R6 schema 注释明确**：TaskState 是任务控制面，记忆注入是 prompt 层瞬时指标，两者语义分离（与王浩宇警告"verifiedCardIds ≠ injectedCardIds"同源原则）|

### 6.2 TaskState 与 R6 schema 字段对应（并存，可叠加）

| R6 schema 字段 | TaskState 字段 | 关系 |
|---|---|---|
| `verification.{signal,exitCode,commands}`（本次）| `TaskState.verified[]`（历史累积）| 维度不同，**并存**：U4 runner 写 R6 后调 `applyEvents` 折叠本次 verified |
| `failureTaxonomy`（本次 enum）| `TaskState.risks[]`（历史累积）| 同上：失败时写 R6 + applyEvents 折叠 failure 事件 |
| `memory.injectedCardIds` | （不在 TaskState）| **设计正确分离**：注入层 vs 控制面 |
| `memory.verifiedCardIds` | （不在 TaskState）| 同上（落定层不进 TaskState，因为卡本身在 RefinedMemoryStore） |
| `attemptCount` | （不在 TaskState）| 评测元数据，与任务控制无关 |

### 6.3 与王浩宇警告呼应（同源原则）

王浩宇警告 `verifiedCardIds ≠ injectedCardIds`（注入层 vs 落定层）。
王佐 `STATE_KINDS` 不含 `memory_injected`（控制面 vs 注入面）。
**两条警告实为同一条原则的实例**：TaskState 是任务控制面，与 prompt 注入层、记忆卡落定层**三者语义分离**。这是项目的一致设计。

### 6.4 U2 `/task` CLI 子命令草案

待 U2 开工细化（按王佐 TaskState 接口）：

| 子命令 | 行为 | R6 影响 |
|---|---|---|
| `/task status [taskId]` | 显示 TaskState 结构 | 无 |
| `/task risks [taskId]` | 显示 risks[] | 可选同步写 `result.tags.push('risk-shown')` |
| `/task next [taskId]` | 显示 nextStep | 无 |
| `/task decide X` | 调 `TaskState.update(taskId, s => ({...s, decisions: [...s.decisions, {ts, what: X}]}))` | 写 `result.tags.push('user-decision')` |
| `/task orig X` | 调 `TaskState.create(taskId, X)`（首次）| 写 `result.tags.push('original-set')` |

### 6.5 R6 评测 × TaskState 集成检查清单（U4 王浩宇实现 runOne 时必查）

- [ ] U4 runner 调 `solveIssue` 前 `TaskStateStore.get(taskId)`（不存在则 `create`）
- [ ] runner 用 `customFilename` 隔离路径
- [ ] runner 用 `eval-` 前缀 taskId
- [ ] runner 跑完后调 `applyEvents` 折叠 verified/failure/progress
- [ ] runner 显式传 `attemptCount`（A 档不传，B/C/C4 显式 1）
- [ ] runner 接 `AbortSignal.timeout(ms)` 透传 `config.signal`

---

## 7. 给翟苑皓（W1 / Leader）—— 评审要点

| 决策点 | 我的选择 | 备选 | 状态 |
|---|---|---|---|
| `RESULT_SCHEMA` 是 Ajv 子集还是完整 Draft-07 | **Ajv 子集**（手写 validateResult，零依赖）| 完整 Draft-07 + ajv 依赖 | 默认（U6 可升级 ajv）|
| `runOne` 接入是同仓还是子进程 | **预留子进程入口**（fork `panshalach run`）| in-process import | 默认 in-process（性能优先）|
| TurnStopReason 同步策略 | **本文件 §2.1 手工同步** + CI gate | 自动 codegen | 手工（避免工具链）|
| mock-smoke 是否保留 `--seed` | **是**（保证 mock 与 real 用同 seed）| 否（mock 不需要）| 默认 |
| 路径隔离粒度 | **前缀 + 退出码 3** | 共享目录 + tag 区分 | 前缀（强约束更稳）|

待 Leader 拍板：无（默认即选）。

---

## 8. 待对齐项

- [ ] **王浩宇** U2 启动前：确认 `runOne()` 的 in-process vs 子进程选择（§4.4）
- [ ] **王佐** U3 启动前：TaskState 注入后 `injectedCardIds` 反映方式
- [ ] **Leader** U4 周日 9/14 接口契约评审：本文件 §2 接口签名全员对齐

---

## 9. 测试状态（U1 已跑通）

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` | EXIT 0 |
| `smoke-eval.mjs` | 20/20 通过 schema，分布 A/B/C/C4 × T1-T5 各 1 |
| `verify-panshalach-cleanup.mjs` | PASS |
| `npm test` | 542 / 541 pass / 0 fail / 1 skip（无退化） |
| `run-eval --help` / `--dry` / 错误参数 | 全部正常 |

---

## 10. 风险与降级

| 风险 | 触发 | 降级 |
|---|---|---|
| 王浩宇 U4 runner 实现拖延 | U4 周日 9/14 未合入 | smoke 仍可跑（mock 模式），不阻塞 U5/U6 验收 |
| openPangu 端点 U6 不可用 | U6 周四 9/18 端点 503 | mock 模式 + 真实开放端口清单由翟苑皓确认 |
| TurnStopReason 在 v0.6.4 后再次扩展 | leader 加新态 | schema.mjs + types.ts 双向同步（注释已点名）|
| run-eval 误写 smoke 路径 | 子进程残留 source='real-openpangu' | exit 3 + pre-write 检查（已落）|
| R7 `LocalNGramHashProvider` 与 C4 消融时机冲突 | 王浩宇 U4 与我 U5 时序错位 | C4 暂走 keyword-only fallback，结果表如实写 |

---

## 11. 9/14 评审目标（U1 R6 这块的 3 个接口对齐）

- [ ] `schema.mjs` 导出签名（`validateResult` / `newResult` / `RESULT_SCHEMA`）
- [ ] `run-eval.mjs` CLI 行为表（本文件 §2.3）
- [ ] 路径隔离硬约束（本文件 §3）

---

## 12. 我的下一步

- [x] 9/5 周六：v0.6.4 推送后落地 R6 骨架（commit e362de4 + 53c1d02）
- [x] 9/5 周六：handover 落库（commit 688f8ae）
- [x] 9/5 周六：push + 提 PR（已合并入 PR #1，因 Gitee 单一源→目标限制）
  - **PR #1** https://gitee.com:Kultur/pangu-harness/pulls/1 升级为 `feat(memory+eval): W4 Main-B 提前工作 — P4 EmbeddingProvider v0 + R6 评测基建骨架`
- [ ] 9/6 周日：等 Leader 评审 PR #1；按意见调整
- [ ] 9/7 周一 U1 D1：等 Leader 评审 + 王浩宇 R6 runner 启动协调
- [ ] 9/8 周二 U1 D2：跟进 PR 评论 + handover 收口
- [ ] 9/9-10 U2：`/task` CLI 启动（依赖王佐 U1-U2 taskState.ts）
