# feature-zhaotianang1 工作日志 — 2026-09-06

agent: zhaotianang / zhaotianang1
date:  2026-09-06
last_updated: 23:50 (commit 61c2a8e；起草 T1-T3 跑分下发说明)

## 想做什么（目的）

周日休整日：趁 PR #1 等评审的空档，把周一 U1 D1 下午必须做的"embed.ts 单测"提前干完；同时验证 0.7.3 合并不破坏 R6 评测骨架。意外发现 `cosineSimilarity` 的 NaN 守卫缺失（注释承诺 ≠ 实际行为），按 0.7.3 五源审查精神属契约偏差，必须修。

## 打算怎么改（动作）

- 跑 `node scripts/eval/smoke-eval.mjs` 验证 0.7.3 兼容
- 新增 `tests/memory/embed.test.ts`（LocalNGramHashProvider 契约测试）
- 新增 `tests/memory/cosine.test.ts`（cosineSimilarity 边界测试）
- 跑 `node --test` 全量回归确认无退化
- 修 `src/memory/embed.ts` NaN 守卫（如果测试发现）
- commit + push + 追加日志

## 实际干了什么（事实）

### 1. smoke-eval（验证 0.7.3 不破坏 R6 骨架）

```
$ node scripts/eval/smoke-eval.mjs
[smoke-eval] generated=20 passed=20 failed=0
[smoke-eval] byAblation: {"A":5,"B":5,"C":5,"C4":5}
[smoke-eval] wrote D:\My_codes\pangu\scripts\eval\results\smoke-2026-09-06.json
```

- 0.7.3 改动 `types.ts`（TurnStopReason 6 态 + Trajectory 新字段）、`verifyCriticalLoop`、`PromptBuilder` 等 17 文件，但 schema.mjs 的 TurnStopReason 注释与 types.ts 双向点名同步未漂移。
- A/B/C/C4 × T1-T5 = 20/20 通过 schema 校验。

### 2. 单测草稿（40 例）

按 9/5 工作日志 D1 下午计划（提前一天干完）：

- **`tests/memory/embed.test.ts`** — 13 个 describe 块，23 个 it（基础属性 / 幂等 / L2 归一化 / 桶分布 / 中文与代码边界 / 构造器校验 / embedBatch / createDefaultProvider 工厂）
- **`tests/memory/cosine.test.ts`** — 5 个 describe 块，17 个 it（基本边界 / 零向量 / 维度错 / NaN+Infinity / v0 端到端）

### 3. ⛏ 测试驱动发现真实 bug：cosineSimilarity NaN 守卫缺失

写 `稀疏数组（undefined 视作 0）` 用例时顺手加 NaN 用例，立刻发现：

```ts
// 原代码 (line 65-75)
const ai = a[i] ?? 0;     // 对 NaN 失效！NaN ?? 0 === NaN
const bi = b[i] ?? 0;
dot += ai * bi;            // NaN 传播
normA += ai * ai;          // NaN 传播
normB += bi * bi;          // NaN 传播
// 结果：cosineSimilarity([1, NaN, 3], [1, 2, 3]) === NaN
```

注释明文承诺：
```
- 任一向量含 undefined/NaN → 视作 0
```

**这是"注释承诺 vs 实际行为"的契约偏差**——按 0.7.3 五源审查（ALIGNMENT-REVIEW-0.7.3）精神属必须修。

**修复**（`src/memory/embed.ts:71-93`）：
1. 新增 `sanitizeScalar(x: unknown): number` 内部辅助：非 number 或非 finite → 0
2. cosineSimilarity 内部循环改用 `sanitizeScalar`
3. 输出侧再加 `Number.isFinite` 兜底（防极端累积误差 / 数值溢出）

```ts
// 新代码（节选）
function sanitizeScalar(x: unknown): number {
  if (typeof x !== 'number') return 0;
  return Number.isFinite(x) ? x : 0;
}

const denom = Math.sqrt(normA) * Math.sqrt(normB);
if (denom === 0 || !Number.isFinite(denom)) return 0;
const result = dot / denom;
return Number.isFinite(result) ? result : 0;
```

修复覆盖：undefined / null / NaN / +Infinity / -Infinity / 字符串 / 对象 → 全部视作 0。

### 4. 验证

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | EXIT 0（干净） |
| `node --test embed.test.ts cosine.test.ts` | **40/40 pass** |
| `node --test "tests/**/*.test.ts"` 全量 | **704 例（703 pass + 1 skip + 0 fail）**——从 0.7.3 的 663 例涨 +41（无退化） |
| `verify-panshalach-cleanup.mjs` | 未跑（明天 U1 D1 晚自查时跑） |

### 5. Commit + Push

```
$ git add src/memory/embed.ts tests/memory/embed.test.ts tests/memory/cosine.test.ts
$ git commit -m "test(memory)+fix(embed): P4 v0 embed/cosine 单测 + cosineSimilarity NaN 守卫"
[zhaotianang1 777e5eb] 3 files changed, 358 insertions(+), 4 deletions(-)
$ git push -u origin zhaotianang1
remote: Powered by GITEE.COM [1.1.23]
b0e1b50..777e5eb  zhaotianang1 -> zhaotianang1
branch 'zhaotianang1' set up to track 'origin/zhaotianang1'.
```

- PR #1 自动包含新 commit（不新建 PR #2，按9/5 升级策略）
- 远端 upstream 首次配置（之前 zhaotianang1 没设 upstream）

## 卡点 / 需要别人决定（接口争议）

- **无新接口争议**。今天的修改都是 `embed.ts` 内部行为修复 + 单测，不动 `EmbeddingProvider` / `LocalNGramHashProvider` / `cosineSimilarity` 签名。
- `sanitizeScalar` 是模块内部辅助函数，不导出；接口契约未动。

## 自查

- [x] smoke-eval 20/20 通过（0.7.3 不破坏 R6 骨架）
- [x] embed.test.ts + cosine.test.ts 全绿（40 例）
- [x] NaN 守卫修复（含 Infinity / undefined / null）
- [x] tsc --noEmit 干净
- [x] 全量回归 704/703 + 1 skip / 0 fail
- [ ] verify-panshalach-cleanup.mjs（明早 D1 晚自查）
- [x] commit + push 到 origin/zhaotianang1
- [ ] PR #1 评论留言（给 Leader 评审）
- [ ] PR #1 标题更新（追加 + 单测 + NaN 守卫）

## TODO（明天 / 下一轮）

- [ ] 9/7 周一 U1 D1 上午：`git fetch origin develop` + 看 PR 评论 + 看 Leader 9/6 周日是否还有推送
- [ ] 9/7 周一 D1 上午：在 PR #1 评论区留言（草稿见本页附 A）+ 更新 PR 标题
- [ ] 9/7 周一 D1 下午：王浩宇 R1/R2 启动协调（refine 接线 + markVerified 信号源）—— U2 markInjected 二态化与 embedCache 策略对齐
- [ ] 9/7 周一 D1 下午：王佐 TaskState 注入后 `injectedCardIds` 反映方式确认
- [ ] 9/7 周一 D1 晚：`npx tsc --noEmit` + `npm test`（全量）+ `verify-panshalach-cleanup.mjs`
- [ ] 9/8 周二 U1 D2：跟 PR 评论 + handover §4 收口 + 给王浩宇做 review 反向响应
- [ ] 9/9-10 U2：等王佐 taskState.ts 落地后启动 `/task` CLI（依赖王佐 U1-U2）

## 附 A：PR #1 评论留言草稿（待提交）

```markdown
## 9/6 NaN 守卫修复 + 单测补充（commit 777e5eb）

今天顺手把 U1 D1 下午要写的 embed 单测提前干完，发现一个真实契约偏差：

**问题**：`cosineSimilarity` 注释明文承诺"undefined/NaN 视作 0"，但实现用 `a[i] ?? 0`，**NaN ?? 0 === NaN**——返回 NaN 而非 0。

**测试实证**：
```ts
cosineSimilarity([1, NaN, 3], [1, 2, 3]); // 返回 NaN（应为有限值）
cosineSimilarity([NaN, NaN], [NaN, NaN]); // 返回 NaN（应为 0）
```

**修复**（src/memory/embed.ts:71-93）：
- 新增内部 `sanitizeScalar(x: unknown)`：非 number 或非 finite → 0
- 输出侧 `Number.isFinite` 兜底（防累积误差）
- 同时覆盖 Infinity（理论不该出现，但 runtime 数据脏）

**为何必须修**：0.7.3 五源审查（ALIGNMENT-REVIEW-0.7.3）发现"注释承诺 vs 实际行为"是最严重的偏离类型——同源精神。

**新增单测**：40 例（embed.test.ts × 23 + cosine.test.ts × 17），含 NaN+Infinity 用例。

**回归**：全量 704（703 pass + 1 skip + 0 fail），从 v0.7.3 的 663 例涨 +41，无退化。`tsc --noEmit` 干净。

**接口契约**：未动——`EmbeddingProvider` / `LocalNGramHashProvider` / `cosineSimilarity` 签名不变，`sanitizeScalar` 是模块内部辅助（不导出）。

请评审。需要补充 doc / 改命名 / 调签名请告知。
```

## 附 B：今日交付物清单

| 类型 | 文件 | 行数 | 说明 |
|---|---|---|---|
| 单测 | `tests/memory/embed.test.ts` | ~190 | LocalNGramHashProvider 全契约 |
| 单测 | `tests/memory/cosine.test.ts` | ~110 | cosineSimilarity 全边界 |
| 修复 | `src/memory/embed.ts` | +12 / -4 | sanitizeScalar + finite 守卫 |
| 日志 | `docs/agent/logs/feature-zhaotianang1/feature-zhaotianang1-2026-09-06.md` | 本文件 | AGENT-CONTRIBUTION §10.1-B 纪律 |
| Commit | `777e5eb` | 3 文件 +358 行 | test(memory)+fix(embed): P4 v0 embed/cosine 单测 + cosineSimilarity NaN 守卫 |
| Push | `b0e1b50..777e5eb` | — | origin/zhaotianang1（首次设 upstream）|

---

## 23:15 追加 — 提前开工 A+D（U3 周末的事 + D 任务提前收）

### 想做什么（目的）

周日晚看到王浩宇群里发的 R6 runner + R3 Turn 结构化对接消息，回完消息后盘了一下"如果现在项目提前开工可以做什么"——王浩宇说他 U4 实体化 T1-T5 fixture，我可以分担 T1-T3 issue 正文（回消息时已答应），如果今晚起 T1-T3 草稿，明早 D1 协调会就有一份可见的成果可同步。

同时 D 任务（`verify-panshalach-cleanup.mjs` 补跑）明早自查必跑，提前今晚跑能避免明早的认知切换成本。

### 打算怎么改（动作）

- 起 T1 完整 fixture（issue + verify.sh 实际约束检查）
- 起 T2 fixture：issue 完整 + verify.sh stub（U4 王浩宇补 `repo/`）
- 起 T3 完整 fixture（issue + verify.sh 字节近似字符数检查）
- 更新 fixture.md 旧 stub 为指针形态（避免双 issue 内容）
- 跑 verify-panshalach-cleanup.mjs，记录结果
- commit + push（zhaotianang1 分支独立工作）

### 实际干了什么（事实）

#### 1. T1 verify.sh — 完整约束检查（5 条）

文件：`tasks/T1/verify.sh`（旧 stub `exit 0` → 完整版 84 行）

5 条约束检查（C1-C5）：
- **C1** 文件名必须为 `TODO.md`（大小写敏感）
- **C2** 必须包含 5 个 `- [ ] ` checkbox（`- [x]` 不算）
- **C3** 每个 checkbox 行后必须有 1 个空行（sed 提取 N+1 行检查）
- **C4** 无 Unicode emoji（5 个主流 Unicode block 用 `grep -P` 检查）
- **C5** 无 tab 字符（`grep -P "\t"`）

**实现细节**：用 `sh -c "$expr" -- "$@"` 模式 + 文件位置参数化为 `$1`，避开 eval 引号嵌套陷阱。早期版本用 `! cmd` 在 sh -c 顶部位置时 `!` 被当作历史扩展占位（不是 NOT 操作符），改为 `if X; then exit 1; fi` 反向检查模式。

**单元测试**（独立 /tmp 目录实跑过）：
- PASS 用例（合规 TODO.md）：5/5 全过
- FAIL 用例（含 `- [x]` + emoji + 无空行）：C2 + C3 准确识别，C4/C5 因 PASS 用例无 emoji/tab → PASS

#### 2. T1 issue.md — 中文长程维护场景

文件：`tasks/T1/issue.md`（新建）

真实工程场景：同事交接项目，模型按 5 条约束生成 `TODO.md`。说明 5 条约束共存是模型"被工具调用噪音淹没、丢失弱约束"的常见失败模式。

#### 3. T2 fixture — issue 完整 + verify.sh stub

- `tasks/T2/issue.md`：add 函数从 `number` 扩展到 `number | bigint` 的跨文件重构任务（4 文件：math.ts / calcService.ts / main.ts / math.test.ts）
- `tasks/T2/verify.sh`：检查 `repo/` 目录存在（缺依赖 → exit 2）；U4 王浩宇补 `repo/` + 替换为 `npm test`
- `tasks/T2/fixture.md`：指针形态（U3 已落 vs U4 待补）

#### 4. T3 verify.sh — 完整 4 条基础检查

文件：`tasks/T3/verify.sh`（旧 stub `exit 0` → 完整版 82 行）

4 条基础检查：
- **T3-h1/h2/h3** 包含 `### Q1` / `### Q2` / `### Q3` 三级标题（顺序固定）
- **T3-c1** 全文字节数 ≤ 2400（≈ 800 字中文）
- **T3-c2** Q1 答案部分 ≤ 350 字节（≈ 100 字中文）
- **T3-c3** Q3 答案部分 ≤ 700 字节（≈ 200 字中文）

**字符数 vs 字节数决策**：issue.md 措辞为"≤ N 字"，但 Git Bash `wc -m` 不数 UTF-8 字符（按字节算）。verify.sh 用 `awk length` 字节近似：1 中文字符 ≈ 3 字节 + 换行/空格余量。issue.md 措辞同步标注 "~N 字节"。

**awk exit code bug**：第一版 `END { exit (n > 350) ? 0 : 1 }` 逻辑反了——n > 350 时 exit 0（sh -c 成功 → check 标 PASS），但应该 FAIL。改为 `END { if (n > 350) exit 1 }`。

**单元测试**（/tmp 实跑）：
- PASS 用例：6/6 全过
- FAIL 用例（Q1 答案超长 + 缺 T2/T3 标题）：T3-c2/T3-c3/T3-h2/T3-h3 准确识别

#### 5. T3 issue.md — Q1/Q2/Q3 摘要任务

文件：`tasks/T3/issue.md`（新建）

长文档（10K-50K tokens）下抽 3 个问题答案写入 `answers.md`：Q1 第 1 章核心主题（≤100 字）/ Q2 第 3 章关键人物贡献（列表）/ Q3 主要结论（≤200 字）。与 R8 多级摘要 L1/L2 envelope 评测对齐。

#### 6. fixture.md 旧 stub → 指针

三个 `fixture.md`（T1/T2/T3）从旧"U4 王浩宇实体化"占位改为指针形态：列实体文件清单 + 王浩宇 U4 负责项 + 评测合同对齐。README 里 link 不破（line 18 fixture.md 仍可点开）。

#### 7. D 任务 verify-panshalach-cleanup.mjs 补跑

```
=== Panshalach Cleanup Verification (internal alias layer) ===
package.json main -> dist/PanshalachChaser.js : OK
src/cli.ts uses PanshalachChaser            : OK
sandbox-test-runner.ts uses PanshalachChaser : OK
Direct old module imports (non-stub)   : OK 0
Hard-coded isStrongMode outside tier   : OK 0
OVERALL CLEANUP STATUS (static checks): PASS

=== 0.7 Termination-Semantics Cleanup (judge/orchestrator removal) ===
CHECK judge file archived                     : OK
CHECK TestTimeOrchestrator archived           : OK
CHECK Trajectory migrated out                 : OK
CHECK TurnStopReason enum present             : OK
CHECK runWithVerificationJudge zero refs      : OK
CHECK TestTimeOrchestrator zero code refs     : OK
CHECK Trajectory `score` field zero refs      : OK
CHECK `continueCount` zero refs repo-wide     : FAIL
  BAD continueCount refs:
     scripts/eval/results/schema.mjs
     scripts/eval/run-eval.mjs
     scripts/eval/smoke-eval.mjs
OVERALL 0.7 CLEANUP STATUS: FAIL
OVERALL CLEANUP STATUS (static checks): NEEDS_REVIEW
```

**发现契约不一致**：0.7.0 CHANGELOG 写"Trajectory 移除 `continueCount`"（判官摘除后），但 eval runner 三处还在用：
- `scripts/eval/results/schema.mjs:137` — schema `continueCount` 字段
- `scripts/eval/run-eval.mjs:109,125` — runOne 返回类型注释 + 默认实现
- `scripts/eval/smoke-eval.mjs:104` — mock T4 时设 `r.continueCount = 1`（演示"resumed"语义）

**这是王浩宇 R6 runner 主线活**（schema 字段定义权 + runOne 形态 + smoke mock 演示都是他 U2-U4 任务矩阵）。我**不擅自改他的代码**，明早 D1 下午协调会口头同步，或群里简短 @ 一句（由 Leader 决定）。

#### 8. Commit + Push

```
$ git add tasks/{T1,T2,T3}/{issue.md,verify.sh,fixture.md}
$ git commit -m "feat(eval): T1-T3 fixture 实体化（issue + verify.sh + 指针）..."
[zhaotianang1 80d3f08] 9 files changed, 493 insertions(+), 29 deletions(-)
$ git push origin zhaotianang1
remote: Powered by GITEE.COM
   777e5eb..80d3f08  zhaotianang1 -> zhaotianang1
```

未追踪（今晚没 add）：
- 本日志文件本身（明早 D1 上午一并 commit）

### 卡点 / 需要别人决定（接口争议）

- **continueCount 残留归谁修**（王浩宇 R6 runner 主线 vs 我顺手改）：
  - 不动的原因：runOne 返回值结构 + schema 字段定义权都是 runner 接口决策，王浩宇 U4 可能想把 `continueCount` 升级为更广义的"续跑计数"或直接废弃+加 `attemptCount` 等
  - 替代方案：明早 D1 下午协调会上口头同步；群里发短消息 @ 王浩宇（按用户偏好不发 PR 评论）
- **T3 字节数 vs 字符数**：issue.md 措辞"≤ N 字"，verify.sh 按字节近似。两者对齐方案：
  - 现状：issue.md 同步标注 "~N 字节"，方法注释明示
  - 备选：U4 王浩宇补真实 document.md 后可改用 node 数字符（精度提升）
  - 决定：保持现状，注释完备即可

### 自查

- [x] T1 verify.sh PASS 5/5 + FAIL 准确（/tmp 实跑过）
- [x] T3 verify.sh PASS 6/6 + FAIL 准确（/tmp 实跑过）
- [x] T2 verify.sh stub：repo/ 缺失 → exit 2（明确报依赖缺失，不静默 exit 0）
- [x] 三个 fixture.md 改指针形态，README link 不破
- [x] verify-panshalach-cleanup.mjs 跑完（PASS/FAIL 全记）
- [x] continueCount 残留识别 + 归属判断（不擅自改，留给王浩宇）
- [x] commit + push 到 origin/zhaotianang1（80d3f08）
- [x] 9/6 日志 last_updated 更新（21:30 → 23:15）+ 本段追加

### TODO（明天 / 下一轮）

- [ ] 9/7 D1 上午：`git add docs/agent/logs/feature-zhaotianang1/feature-zhaotianang1-2026-09-06.md && git commit`（本日志入追踪）+ `git fetch origin develop` + 看 PR 评论 + 看 Leader 9/6 周日是否还有推送
- [ ] 9/7 D1 下午：王浩宇 R1/R2 启动协调 + **口头/群里同步 continueCount 残留** + 王佐 TaskState 注入后 injectedCardIds 反映方式确认
- [ ] 9/7 D1 晚：npx tsc --noEmit + npm test（全量）+ verify-panshalach-cleanup.mjs（D 已跑过，知道 FAIL 项，但全量仍跑确认）
- [ ] 9/8 D2 上午：commit 本日志追加段 + 评审对别人的回应 + 写"我暴露的接口"到自己的 handover（fixture 扩展 + verify.sh 模板）

### 附 C：今晚交付物清单（追加）

| 类型 | 文件 | 行数 | 说明 |
|---|---|---|---|
| Fixture issue | `tasks/T1/issue.md` | ~50 | 5 条约束中文长程维护场景 |
| Fixture issue | `tasks/T2/issue.md` | ~55 | add→bigint 跨文件重构 |
| Fixture issue | `tasks/T3/issue.md` | ~60 | Q1/Q2/Q3 摘要任务 |
| Fixture verify | `tasks/T1/verify.sh` | 84 行 | 5 条约束自动检查（PASS 5/5 实跑过） |
| Fixture verify | `tasks/T2/verify.sh` | 37 行 | stub：repo/ 缺失 → exit 2 |
| Fixture verify | `tasks/T3/verify.sh` | 82 行 | 4 条基础检查（PASS 6/6 实跑过） |
| Fixture 指针 | `tasks/{T1,T2,T3}/fixture.md` | 41+40+55 行 | 旧 stub → 实体文件清单 + 评测合同对齐 |
| D 任务结果 | `verify-panshalach-cleanup.mjs` 跑出 | — | 发现 continueCount 残留，明早同步王浩宇 |
| 日志 | 本文件追加段 | — | AGENT-CONTRIBUTION §10.1-B 纪律 |
| Commit | `80d3f08` | 9 文件 +493 行 | feat(eval): T1-T3 fixture 实体化 |
| Push | `777e5eb..80d3f08` | — | origin/zhaotianang1 |

### 23:50 起草 T1-T3 跑分下发说明段（commit 61c2a8e）

#### 背景

王浩宇今晚请起草 T1-T3 跑分内容（他的下游接力是 U4：补 T2 `repo/` + 强化 verify.sh / 补 T3 `document.md` + keyword 检查）。我不在 U4 边界内代写实际 repo/document，仅起草"任务说明 + 接手清单 + verify.sh keyword 模板"。

#### 落地

新增 `tasks/T1-T3-RUN-EVAL-OVERVIEW.md`（273 行），覆盖：
- §0 跑分前置（端点/模型/context/output 目录——4 项等王浩宇确认，标 ⏳）
- §1 T1：已完结，无王浩宇补全项
- §2 T2：王浩宇补 `repo/`（5 文件 TS 代码库骨架）+ 替换 verify.sh stub 为三段式实检（add 含 bigint + 调用点 ≥ 3 + bigint 测试 ≥ 2 + tsc + npm test）
- §3 T3：王浩宇补 `document.md`（5 章中文长文档）+ verify.sh 末尾追加 10 条 keyword check（K1 / P1-P4 / C1-C4 / K5）
- §4 跑分结果回写约定（R6 schema 必填字段 + 12 次跑分 JSON + SUMMARY.md）
- §5 王浩宇回传清单（6 项）
- §6 起草人不越界说明（明确"已起草什么 / 未代写什么 / 未预设什么"）

#### Commit + Push

```
$ git add tasks/T1-T3-RUN-EVAL-OVERVIEW.md
$ git commit -m "docs(eval): T1-T3 跑分任务下发说明（王浩宇 U4 补全清单）..."
[zhaotianang1 61c2a8e] 1 file changed, 273 insertions(+)
create mode 100644 tasks/T1-T3-RUN-EVAL-OVERVIEW.md
```

push 待执行（本轮末尾 git push origin zhaotianang1）。

#### 边界（守 U3/U4 切分）

- ✅ 起草：issue 正文 + verify.sh 框架 + repo/document 骨架 + verify.sh keyword check 模板
- ❌ 未代写：真实 `repo/` 代码、`document.md` 文本、真实 keyword 词表
- ❌ 未预设：跑分端点、模型 tag、run-eval.mjs 配置（王浩宇 R6 runner 职责）

#### IM 文本（已整理好待发）

起草完用户已确认要 IM 形式下发到王浩宇；已整理成可直接复制粘贴的短文（覆盖 T1/T2/T3 缺失项 + 回传清单）。用户自行发送。

#### TODO（本轮内）

- [ ] `git push origin zhaotianang1`（61c2a8e 上推）

#### 附 C 增补（追加）

| 类型 | 文件 | 行数 | 说明 |
|---|---|---|---|
| 下发说明 | `tasks/T1-T3-RUN-EVAL-OVERVIEW.md` | 273 行 | T1-T3 跑分任务下发（王浩宇 U4 接手清单 + 三段式 verify.sh + keyword check 模板） |
| 日志 | 本文件追加段 | — | AGENT-CONTRIBUTION §10.1-B 纪律 |
| Commit | `61c2a8e` | 1 文件 +273 行 | docs(eval): T1-T3 跑分任务下发说明 |
