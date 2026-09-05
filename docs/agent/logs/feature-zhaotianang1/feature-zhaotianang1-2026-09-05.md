# feature-zhaotianang1 工作日志 — 2026-09-05

agent: zhaotianang / <待填写>
date:  2026-09-05
last_updated: 21:00 (R6 骨架 + handover 落 commit 后追加)

## 想做什么（目的）
周六前置日：把 v0 的 `EmbeddingProvider` 接口 + LocalNGramHashProvider 搬进项目 + 提 PR 给 Leader 评审，赶在 9/14 接口契约 gate 前把签名对齐。

## 打算怎么改（动作）
- 新增 src/memory/embed.ts：EmbeddingProvider + cosineSimilarity + LocalNGramHashProvider + EmbeddingCache + createDefaultProvider
- 新增 docs/agent/handover/feature-zhaotianang-handover.md（含 v3 兼容性段落）
- commit + push origin/zhaotianang1 + 提 PR（目标 develop，不是 master）

## 实际干了什么（事实）
- 在 D:\My_codes\test\ 起草 embed.ts（135 行）+ handover.md 草案
- 读 Leader 的 memory v3 commit bf5f4a7 的 diff：
  - RefinedMemoryStore.loadFiltered 现在过滤 archived 卡 → 我的 semanticScore 计算必须在 archived 过滤之后
  - markUsed 二态化（markInjected / markVerified）→ 我的 embedCache 也要类似二态化
  - CompactResult 扩展字段（generation/coveredTurnIds/summarySource/syntheticTurn）→ 我的 compactSessionL1/L2 必须兼容
  - PromptBuilder [M1] 卡号单一序列 → 不能破坏
  - runAgentTask 新增 memory_injected 事件 → U6 集成要走
- 写 src/memory/embed.ts（原样搬，独立无依赖）
- 写 docs/agent/handover/feature-zhaotianang-handover.md（加 §3 v3 兼容性影响）
- commit 3f0d40b（3 文件，464 行）→ push origin/zhaotianang1
- 解决 SSH key 缺失：ed25519 生成 + ssh-agent + 加公钥到 gitee soney101
- 解决账号安全评级低：绑定第三方账号（用微信）
- **PR #1 创建成功**：https://gitee.com/Kultur/pangu-harness/pulls/1（源 zhaotianang1 → 目标 develop）

## 卡点 / 需要别人决定（接口争议）
- 王浩宇（Doer）wanghaoyu1 仍 0 commit → U2 markInjected 二态化与 embedCache 策略待对齐
- 王佐（Main-A）origin/wangzuo1 仍未建 → U4 compactSessionL1/L2 与 TaskState/Event 注入顺序待对齐
- Leader 已写 memory v3，P5 三级摘要是否继承 v3 CompactResult（默认继承；待 Leader 9/14 评审拍板）

## 自查
- [x] embed.ts 独立模块，零依赖
- [x] 不破坏 v3 卡号序列（embed.ts 不读 RefinedMemoryStore）
- [x] 命名/类型/导出风格对齐现有 src/memory/ 模块
- [ ] npx tsc --noEmit（待 PR 合并后跑）
- [ ] npm test 相关子集（待 U1 写测试时跑）

## TODO（明天 / 下一轮）
- [ ] 9/6 周日（今天后）：等 Leader 评审 PR #1；可能要求改命名/补 doc/调整签名
- [ ] 9/7 周一 U1 D1 上午：git fetch origin develop + cat handover/* + 看 PR 评论
- [ ] 9/7 周一 D1 下午：写 tests/memory/embed.test.ts + tests/memory/cosine.test.ts
- [ ] 9/7 周一 D1 晚：npx tsc --noEmit + npm test 子集 + verify-panshalach-cleanup.mjs
- [ ] 9/8 周二 D2 上午：commit 测试 + push + 提 PR-2（追加测试 + 关闭 PR #1 时合并或关联）

## 开工前必查
- [x] git fetch origin master develop（周六上午已做）
- [x] cat docs/agent/handover/feature-*.md（翟苑皓 2 份 + README）
- [x] git log origin/master -5（确认 Leader 9/5 提交了 4 个新 commit）

---

## 傍晚批次（v0.6.4 落地 + R6 评测基建骨架）

### 想做什么（目的）
- 等待 leader 推送 develop（leader 之前说"等他上新的一版再进行开发"）
- v0.6.4 推送后：验证本地不坏 + 立刻开工 U1 R6 评测基建骨架（无依赖路径，对齐 v0.6.4 新字段）
- 同步落当日工作产物（commit + handover + 工作日志）

### 实际干了什么（事实）

#### 1. 测试 leader 给的 frp-boy.com 测试端点
- curl 发现 501 Not Implemented（FRP 强制 HTTPS 隧道）
- 切 https 后通：返回 `{output:[{type,content}]}`，**非 OpenAI 兼容协议**
- leader 确认是测试玩具（1B embedded），真实部署是 OpenAI 兼容——结论：项目内置 provider 直接兼容，无需 adapter

#### 2. 等 leader 推送 develop + 验证
- 第一次 fetch：HEAD 仍在 1966aec（未推）
- 第二次 fetch：HEAD 跳到 3db3422 = v0.6.4（R0 双层终止语义 + 三先决修复）
- v0.6.4 关键改动：types.ts 增 TurnStopReason 6 态 + Trajectory 增 stopReason/continueCount/lastError + 19 文件 +677 行
- 本地验收：`tsc --noEmit` EXIT=0 / `npm test` 542 例（541 pass + 1 skip + 0 fail） / cleanup PASS
- 注：npm install 后 package-lock.json 被动同步（v0.6.4 改了 package.json 加 zhulong bin，lockfile 漏改）

#### 3. U1 R6 评测基建骨架落地（无依赖路径）
按 tasks/agents/zhaotianang.md U1 任务：评测基建骨架先行（R6，无依赖）

- `scripts/eval/results/schema.mjs`（170 行）—— 契约源头：
  - TurnStopReason 6 态（与 src/cli/repl/types.ts 同步，注释双向点名）
  - ABLATIONS（A/B/C/C4）+ FAILURE_TAXONOMY 9 类（运行前冻结）
  - RESULT_SCHEMA（Ajv 子集）+ validateResult/newResult/hashPrompt
  - 纯 Node + 内置 crypto，零依赖
- `scripts/eval/smoke-eval.mjs`（120 行）—— mock 自检：20 合成结果（A/B/C/C4 × T1-T5），路径隔离写 `smoke-<date>.json`
- `scripts/eval/run-eval.mjs`（200 行）—— 主入口：CLI（--source/--ablation/--task-family/--seed/--model-id/--dry/--help）+ 路径隔离硬约束（real-openpangu 禁写 smoke-*）+ runOne() 占位 + TODO(U4 王浩宇)
- `tasks/T1-T5/{README.md,fixture.md,verify.sh}` × 5 = 15 个占位文件（每个 ~30 行）
- `.gitignore` 增 `scripts/eval/results/*`（白名单 schema.mjs）

#### 4. 验收全绿
- `tsc --noEmit` EXIT=0
- `smoke-eval` 20/20 通过 schema，分布 A/B/C/C4 × T1-T5 各 1
- `verify-panshalach-cleanup.mjs` PASS
- `npm test` 542 / 541 pass / 0 fail / 1 skip（**无退化**）
- `run-eval --help` / `--dry` / 错误参数 全部正常（修了 dry 模式吞 flag 的小 bug）

#### 5. 三个 commit（不 push，等用户点头）
- `53c1d02 chore(deps): package-lock.json 同步 v0.6.4（zhulong bin + version bump）`
- `e362de4 feat(eval): R6 评测基建骨架（schema + smoke + run-eval + T1-T5 fixture）`（19 文件 / +878 行）
- `688f8ae docs(agent): U1 R6 评测基建骨架 handover`（189 行）

#### 6. Handover 落点（`docs/agent/handover/feature-zhaotianang-u1-r6-scaffold.md`）
- §2 暴露的接口（schema.mjs 导出 + 契约字段表 + CLI 行为表）
- §3 路径隔离硬约束
- §4 给王浩宇 U4 runner 接入契约（A/B/C/C4 行为表 + 评测防线 4 条）
- §5 给王佐 TaskState 注入位置
- §6 给翟苑皓 5 决策点默认已选
- §9 风险与降级 / §10 9/14 评审目标 / §11 我的下一步

### 卡点 / 需要别人决定（接口争议）
- **无新接口争议**。handover §6 列了 5 个默认决策（Ajv 子集/in-process 接入/手工同步 TurnStopReason/mock-smoke 保留 --seed/前缀粒度路径隔离），默认即选无需 Leader 拍板。
- 待 Leader 9/14 评审：3 个接口签名对齐（schema.mjs 导出 / run-eval CLI / 路径隔离约束）。
- 待王浩宇 U2 启动前对齐：runOne() 的 in-process vs 子进程选择。
- 待王佐 U3 启动前对齐：TaskState 注入后 `injectedCardIds` 反映方式。

### TODO（明天 / 下一轮）
- [ ] 9/6 周日：等 Leader 评审 PR #1（已升级合并两批工作）；可能要求改命名/补 doc/调整签名
- [ ] 9/7 周一 U1 D1 上午：`git fetch origin develop` + 看 PR 评论 + 看 leader 9/6 周日是否还有推送
- [ ] 9/7 周一 D1 下午：王浩宇 R1/R2 启动协调（refine 接线 + markVerified 信号源）
- [ ] 9/7 周一 D1 晚：`npx tsc --noEmit` + `npm test` + `verify-panshalach-cleanup.mjs`（PR 合并后必跑）
- [ ] 9/8 周二 U1 D2：跟 PR 评论 + handover §4 收口 + 给王浩宇做 review 反向响应
- [ ] 9/9-10 U2：等王佐 taskState.ts 落地后启动 `/task` CLI

### PR 提交结果（晚间）
- push 后 Gitee 提示"已存在相同源分支、目标分支的 Pull Request !1"——因 PR #1 早 13:30 已用同源→目标提交
- 选择**升级 PR #1**（不拆不 force-push），标题改为 `feat(memory+eval): W4 Main-B 提前工作 — P4 EmbeddingProvider v0 + R6 评测基建骨架`，描述保留 PR #1 原 P4 内容追加 R6 部分
- 后续若有更多 P4/R6 相关工作可继续追加到 PR #1