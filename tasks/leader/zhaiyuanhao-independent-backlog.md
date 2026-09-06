# 翟苑皓（Leader）独立任务 backlog

> 筛选标准：不被钳制 × 不影响别人 × 长期可做。所有任务都附文件、不撞谁论证、产出描述。
> 不携带时间估算——节奏由翟苑皓自定。

---

## A. 文档 / 项目书 / 架构（纯写，不动代码）

| # | 任务 | 文件 | 不被钳制论证 |
|---|---|---|---|
| A1 | 0.7.0 CHANGELOG 段完整撰写（按方案书 §9 草稿 + 实测命令输出，禁止预填 PASS） | `CHANGELOG.md` | 你卡上 R9 收口总责；master 上 0.6.4/0.6.5 段已定稿，不重写 |
| A2 | ROADMAP-NEXT §3 R0 验收行追加（"判官 + TestTimeOrchestrator 摘除"）+ §4 已摘除清单追加 + §3.2 遗留表更新 | `docs/panshalach/ROADMAP-NEXT.md` | 改一处追加，不动主体段落；王浩宇/赵天昂的 diff 是 9/4 旧版 |
| A3 | ARCHITECTURE.md §1 执行链路图重画（判官 + Orchestrator 摘除后的单 loop.run + 终止语义三态） | `docs/panshalach/ARCHITECTURE.md` | §1 你负责；§5 赵天昂负责 |
| A4 | ARCHITECTURE.md §3 推理流程图重画（去掉 TestTimeOrchestrator / 多 rollout / early-stop 预算裁剪） | `docs/panshalach/ARCHITECTURE.md` | 同上 |
| A5 | ARCHITECTURE.md §5 资源消耗表模板（占位"待赵天昂 U7 实测"） | `docs/panshalach/ARCHITECTURE.md` | 占位写法；赵天昂后续回填 |
| A6 | README.md 总入口改写对齐 0.7 | `docs/panshalach/README.md` | 你卡上 R9 收口 |
| A7 | USER-GUIDE.md 改写对齐 0.6.5 部署（npm link / zhulong bin / config 播种 / `--approval`） | `docs/panshalach/USER-GUIDE.md` | 0.6.5 文档更新挂在你名下 |
| A8 | SUBMISSION.md 项目书终稿（≤1000 字概述 + 完整方案 + 创新点 + 部署 + 评测占位 + 总结） | `docs/panshalach/SUBMISSION.md` | 完全独立 |
| A9 | DEPLOY-CN.md 昇腾 310P/910 + vLLM-ascend/MindIE + 麒麟/其他国产 OS 接入步骤 | `docs/panshalach/DEPLOY-CN.md` | 完全独立 |
| A10 | EVALUATION.md §5 分析叙事（按 ROADMAP-NEXT §3.1 R6 合同 + 中期遗忘曲线预期，**数据由赵天昂回填**） | `docs/panshalach/EVALUATION.md` | 占位叙事，不填数据 |
| A11 | MEMORY-DESIGN.md §3.1 字段表追加 Turn `goal/changedFiles/verifyCmd`（R3 落地后）+ §4 写入源状态更新 | `docs/panshalach/MEMORY-DESIGN.md` | R3 字段新增在 §3.1；§4 状态更新一句话 |
| A12 | REFACTOR-ASSESSMENT.md §4 三次申报累计（0.6.4 R0 / 0.6.5 部署 / 0.7.0 终止语义重构） | `REFACTOR-ASSESSMENT.md` | 你持续维护 |
| A13 | AGENT-CONTRIBUTION.md §7 分支命名规则细化（`<pinyin>N` 单调递增 / `<pinyin>1` 合 master 后冻结 / 后续开 `<pinyin>2`） | `AGENT-CONTRIBUTION.md` | 你 Leader 独改 |
| A14 | `tasks/postmortem/2026-09-24-submission.md` 复盘模板建立（章节、字段、定性定量分区） | `tasks/postmortem/` | 完全独立 |

---

## B. 评审（Leader 本职）

按提交顺序排：

| # | 任务 | 对象 | 产出 |
|---|---|---|---|
| B1 | 评审王浩宇 PR #1（R1/R2 finalizeTaskMemory + signal 子集）| 11 commits / +442 行 | `Reviewed-by: zhaiyuanhao1 (date)` + 评审纪要（评审四问逐条答） |
| B2 | 评审王佐 PR #3（R4 MemoryEventStore 只读查询层） | 1 commit / +264 行 | 同上 |
| B3 | 评审赵天昂 PR #4（R6 评测骨架 + R7 embed n-gram） | 3 commits / +1616 行 | 同上 |
| B4 | 自我对照评审清单（0.7 收尾 PR #2）+ 写给 kultur 的合入备忘 | 你的 0.7 改动 | 同上 |
| B5 | 评审 `.github/workflows/agent-branch-guard.yml` + `scripts/protect-protected-branches.sh` 改动（如有） | 4 主力分支 push | CI gate 通过 / 失败记录 |
| B6 | 持续被动评审：每日 fetch + cat handover 巡检 | 所有人 | 发现未 resolved 项 → 通知当事人 |

---

## C. 技术债 / 鲁棒性补丁

每条都附 `ROADMAP-NEXT §3.2` 的来源标注。个人小领地，独立可测。

| # | 任务 | 文件 | 不撞谁 |
|---|---|---|---|
| C1 | `MAX_FILE_SIZE_BYTES`(200KiB) 声明执行（save 时检查，超限 reject + 告警） | `src/memory/RefinedMemoryCard.ts` | 与王浩宇分支的 `collectToolFilePaths` 不重叠；rebase 时解决 |
| C2 | `compactService` marker 先写盘成功再改内存（防双源分歧） | `src/cli/repl/compactService.ts` | 不碰事件层、不碰 TaskState |
| C3 | `FeatureTracker.markFeatureDone` 检查 save 返回值（写失败告警，不静默成功） | `src/cli/repl/FeatureTracker.ts` | 不碰他人 |
| C4 | glob `walkFiles` 不跟随符号链接（声明受信工作区假设 + 补 realpath 防御） | `src/tools/glob.ts` | 不碰他人 |
| C5 | `rolloutStore.appendEvent` 异常不再吞，加 `auditStatus` 字段（"零事件"区分"没注入/写失败"） | `src/cli/repl/rolloutStore.ts` | 不碰他人；事件 schema 增字段，向后兼容 |
| C6 | `Reviewer.ts:122-170` "探测到测试脚本"语义改 `detected`，执行后才 `executed-pass` | `src/review/Reviewer.ts` | `/review` 命令不在任务路径，无依赖 |
| C7 | `bash.ts` abort signal 监听（executor 层 + tree-kill 联动，0.7.1） | `src/tools/bash.ts` | 依赖 0.7.0 signal 字段已落 |
| C8 | `bash.ts` detached 子进程 SIGKILL 跨平台一致性（POSIX 用 `process.kill(-pid, SIGKILL)`、Windows 已有 taskkill /T，验证两边一致） | `src/tools/bash.ts` | 不碰他人 |

---

## D. CI / 工具链 / 工程基础设施

一次性投资，长期受益。

| # | 任务 | 文件 | 不撞谁 |
|---|---|---|---|
| D1 | `verify-panshalach-cleanup.mjs` 增强：判官文件已归档 / TestTimeOrchestrator 已归档 / Trajectory 已迁出 / TurnStopReason 5 态 / `runWithVerificationJudge` 全仓库零引用 / `TestTimeOrchestrator` 全仓库零引用 / `score` 字段零引用 / `continueCount` 零引用 | `scripts/verify-panshalach-cleanup.mjs` | 不撞人 |
| D2 | `scripts/lint-md.mjs`：所有 md 文件检查（链接、表对齐、章节标题规范、handover 引文链接有效） | `scripts/` 新建 | 不撞人 |
| D3 | `scripts/check-protected-files.mjs`：merge 时强制检查 `src/PanshalachChaser.ts` solveIssue 签名 / `src/cli/repl/types.ts` TurnStopReason 枚举 / `src/memory/RefinedMemoryCard.ts` 字段不被无声明改 | `scripts/` 新建 | 不撞人 |
| D4 | `scripts/eval-preflight.mjs`：跑评测前检查（端点可达 / 配置就绪 / 路径隔离契约） | `scripts/` 新建 | 不撞人 |
| D5 | `scripts/handover-cross-ref.mjs`：handover README 章节顺序 / 必填字段 / 跨引用完整性 | `scripts/` 新建 | 不撞人 |
| D6 | CI 工作流：auto-merge develop → master gate（仅 kultur 推，校验 fingerprint） | `.github/workflows/` | kultur 决策 |
| D7 | `npx tsc --noEmit` CI 强制（strict 模式 + 任何 src 改动必须通过） | `.github/workflows/` | 不撞人 |
| D8 | PR 模板改进（加 handover 强制引用 + 评审四问勾选 + base 分支声明） | `.github/PULL_REQUEST_TEMPLATE.md` | 不撞人 |
| D9 | 提交钩子：commit-msg 校验（`<scope>: <subject>` 格式 / 引用 handover / 不允许 "wip"/"tmp"/"asdf"） | `.husky/commit-msg` 或 `.git/hooks/` | 不撞人 |

---

## E. 长期架构 / 1.x 路线

思考性，独立于当前 sprint。

| # | 任务 | 文件 | 不撞谁 |
|---|---|---|---|
| E1 | 1.x 路线图草稿（基于 0.7.0 现状的下一阶段目标） | `docs/panshalach/ROADMAP-NEXT.md` §5 新增 | 完全独立 |
| E2 | 0.7.1 / 0.8.0 候选功能清单（按"价值密度 × 实现成本"打分） | `docs/panshalach/ROADMAP-NEXT.md` §6 新增 | 完全独立 |
| E3 | P6 存储名迁移方向裁决（推 kultur 拍板 PANSHA_*→PANG_* vs 维持现状） | `tasks/agents/zhaiyuanhao.md` 推进 | 完全独立 |
| E4 | 国创赛提交材料格式对齐（如果赛方有模板，写适配说明） | 新文件 | 完全独立 |
| E5 | `tasks/incidents/` 复盘记录模板（事故 / 决策 / 推延项的统一格式） | 新建 | 完全独立 |
| E6 | `REFACTOR-ASSESSMENT.md §5` 新增：三次申报累计的影响汇总（性能 / 可测 / 可审计 三维度） | `REFACTOR-ASSESSMENT.md` | 持续维护 |
| E7 | 国产软硬件亲和调研笔记（昇腾 310P/910 部署兼容性 / 麒麟 OS 兼容性 / vLLM-ascend vs MindIE 选型对比） | `docs/panshalach/` 新建 | 完全独立 |

---

## F. 0.7.0 收尾未完成（你自己的卡上挂的）

按上一轮盘点结果还差：

| # | 任务 | 文件 | 备注 |
|---|---|---|---|
| F1 | `RefinedMemoryStore.test.ts:218-222` 成功信号断言改写（旧 `trajectory.success=true → 喂卡` 改 `stopReason==='completed'`） | `tests/memory/RefinedMemoryStore.test.ts` | 旧断言在收紧后必挂；不修测试假阳性 |
| F2 | `tests/model/openai-compatible.abort.test.ts` 新增（外部 signal abort 传播，fetch + streamChat 两层） | `tests/model/` 新建 | 方案书 §8 列 |
| F3 | chaser 级"判官摘除后单次调用"断言（loop.run 只被调一次）+ chat 单次路径 returns answered 断言 | `tests/` 新建 | 方案书 §8 列 |
| F4 | memory/compact answered 不产 success 卡断言（refine 信号 + compact 补漏各一例） | `tests/memory/` + `tests/repl/` | 方案书 §8 列 |
| F5 | `npx tsc --noEmit` + `node --test` 全跑（结果原样记录，禁止预填 PASS） | 命令 | 方案书 §8 验证命令 |
| F6 | 真实 REPL 手测 4 个用例（`1` / `你好，回答我你是谁` / 运行中 Ctrl+C / `hello.txt`） | REPL | 方案书 §8 验证命令 |
| F7 | PromptBuilder.buildForTask 按 intent 分支注入（taskIntent 写了但没接进 PromptBuilder） | `src/cli/repl/PromptBuilder.ts` | 上一轮报告 §10.4 缺口 |
| F8 | handover 给王浩宇/王佐/赵天昂（告诉他们 0.7 落地后他们的分支要 rebase + 冲突预案） | `docs/agent/handover/feature-zhaiyuanhao1-0.7.0-comms.md` | 同步沟通 |

---

## G. 持续性 / 节奏性

每天 5-30 分钟。

| # | 任务 | 频次 | 单次时长 |
|---|---|---|---|
| G1 | `tasks/agents/zhaiyuanhao.md` 滚动更新（每完成一项打 ✅ / 🔄） | 每天 | 5 分钟 |
| G2 | `docs/agent/logs/zhaiyuanhao1/zhaiyuanhao1-YYYY-MM-DD.md` 当日日志 | 每天 | 10-15 分钟 |
| G3 | `git fetch origin master develop` + `cat docs/agent/handover/*.md` 巡检未 resolved 项 | 每天 | 5 分钟 |
| G4 | 评审 3 人当日 push（被动触发，CI gate 失败时介入） | 每天 | 0-30 分钟 |
| G5 | `git diff --stat origin/zhaiyuanhao1..HEAD` 自查（避免误改他人领地） | 每次 commit 前 | 1 分钟 |
| G6 | 周 stand-up 同步阻塞点（周一/三/五） | 每周 3 次 | 30 分钟 |

---

## 任务依赖图（仅看你→你，不看他人）

独立可启动（无前置）：A1-A14 全部、B 全部、C 全部（C7 依赖 0.7 收尾，但 0.7 是你自己的卡）、D 全部、E 全部、F 全部、G 全部。

你的内部依赖（你做这件事前先做那件事）：
- F1 → F5（测试改写后再跑全测）
- F7 → F5（PromptBuilder 接通后再跑全测）
- F8 与 A1-A7 重叠，去重即可
- A8 评测段落依赖 A10 叙事段落

---

## 个人领地地图（避免误撞）

| 你（翟苑皓） | 王浩宇 | 王佐 | 赵天昂 |
|---|---|---|---|
| `docs/panshalach/` | `src/memory/` 部分 | `src/memory/events.ts` | `scripts/eval/` |
| `tasks/` | `src/PanshalachChaser.ts` 末尾 | `src/memory/taskState.ts` | `tasks/T1-T5/` |
| `AGENT-CONTRIBUTION.md` | `src/server/runAgentTask.ts` | `src/cli/repl/commands/TaskCommand.ts` | `src/memory/embed.ts` |
| `REFACTOR-ASSESSMENT.md` | `src/cli/repl/{Repl,RunCommand,sseInteractive}.ts` 部分 | `tests/memory/EventStore.test.ts` | `tests/memory/embed.test.ts` |
| `scripts/verify-*.mjs` | `tests/memory/TaskFinalizeMemory.test.ts` | `tests/repl/TaskState.test.ts` | `docs/agent/handover/feature-zhaotianang*` |
| `.github/workflows/` | `docs/agent/handover/feature-wanghaoyu*` | `docs/agent/handover/feature-wangzuo*` | `scripts/eval/results/schema.mjs` |

唯一交叉点（合并日处理）：
- `src/PanshalachChaser.ts`：你（0.7 改动）+ 王浩宇（finalizeTaskMemory）
- `src/memory/RefinedMemoryStore.ts`：你（C1 技术债）+ 王浩宇（collectToolFilePaths）
- `CHANGELOG.md`：你（0.7.0 段）—— 0.6.4/0.6.5 已在 master 上有定稿，不重写

---

## 不建议接的（会被钳制 / 不属于你 / 浪费时间）

- ❌ `src/PanshalachChaser.ts` solveIssue 主体逻辑（0.7 收尾后）—— 与王浩宇 finalize 撞
- ❌ `src/cli/repl/types.ts` 主契约（除 TurnStopReason 已有改动外）—— 契约定稿后所有人依赖
- ❌ `src/memory/RefinedMemoryStore.ts` refine 之外的方法 —— 王浩宇分支的 `collectToolFilePaths` 是他写的
- ❌ 重写 `ROADMAP-NEXT.md` 主体 —— 多人改过，冲突风险大；只追加 §3/§4/§5/§6 新段
- ❌ `src/memory/events.ts` 写入逻辑 —— 王佐负责（R4 U2）
- ❌ `src/memory/taskState.ts` —— 王佐负责（R5 U2-U3）
- ❌ `scripts/eval/` 主体 —— 赵天昂负责（R6）
- ❌ `src/memory/embed.ts` 主体 —— 赵天昂负责（R7）
- ❌ 跑 9/24 真端点评测 —— 赵天昂 U6 责任 + 端点由 kultur 提供
- ❌ 直接 push master —— 你无权限（kultur 独享）

---

## 价值密度排序（前 10 项，建议优先级）

按"高价值 × 低撞人风险 × 长期受益"排序：

1. **D1 verify-panshalach-cleanup.mjs 增强** — 一次性投资，永久受益；不撞人
2. **A8 SUBMISSION.md 项目书** — 9/24 提报必交付
3. **F1 旧测试改写** — 0.7 收尾必做（不做测试假阳性挂）
4. **A1 0.7.0 CHANGELOG 段** — 9/24 提报必交付
5. **B1-B3 评审 3 人 PR** — Leader 本职
6. **C1 / C2 / C5 技术债** — 0.7 后顺手清
7. **A3-A4 ARCHITECTURE.md 执行链路图重画** — 9/24 提报必交付
8. **A9 DEPLOY-CN.md** — 9/24 提报必交付
9. **E1 1.x 路线图草稿** — 长期受益
10. **D3 check-protected-files.mjs** — 防止后续合并破坏契约
