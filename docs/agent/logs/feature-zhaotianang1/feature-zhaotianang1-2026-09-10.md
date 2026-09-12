# feature-zhaotianang1 工作日志 — 2026-09-10

agent: zhaotianang / zhaotianang1
date:  2026-09-10
last_updated: D3 早间收口

## D3 早间 — R6 follow-up #1 落地 + 与 wanghaoyu1 U5 集成

### 想做什么(目的)

承接翟苑皓 9/9 晚群反馈 follow-up #1(**B 档记忆 seeding + memory 隔离**):
> "干净 workspace 下 B/C/C4 档必 0 注入全标 invalid——真实跑分前必修。"

落地三件事:
1. RefinedMemoryStore 加 `PANSHA_MEMORY_FILE` env 钩子(对齐 TaskStateStore 已有
   `PANSHA_TASK_STATE_FILE` 模式)
2. run-eval.mjs per-run 隔离 + 默认 seed + `--seed-memory` CLI
3. verdict 落源:`line-defense-failed → 'invalid'`、`overflow-skipped → 'not_applicable'`
   (不再依赖 tags 二次映射)

### 实际干了什么(事实)

#### 1. 早间 fetch + 摸清 R6 域(9/10 0:30-1:30)

- `git fetch --all` 拿到 overnight 新提交:
  - **wanghaoyu1**:+1 commit 2445182(Repl 三口接线 + TurnStopReason 7 态 + smoke-eval gate)
  - **zhaiyuanhao1**:+6 commit 0.8 大迭代(M1-PROTOCOL messages 双通道、
    M2-5 执行层、0.8.1 摘除生产 smoke mock 门)
  - **origin/develop**:仍 `b4093f1`(未合入新分支)
- 派 Agent 扫描 R6 域 5 个具体缺口:
  1. 无 seeding 机制
  2. 无 workspace 隔离(全部 cwd=ROOT,跨 run 泄露)
  3. `fixture.workspace` 死字段(无 fixture 声明)
  4. verdict 传播 gap(line-defense-failed 不在 source 落 verdict)
  5. 无 0 注入路径单测

#### 2. R6 follow-up #1 实施(1:30-3:00,commit 4c7c838)

`src/memory/RefinedMemoryStore.ts`(+6/-1):
- 构造函数优先级:`customFilename > PANSHA_MEMORY_FILE env > DEFAULT_FILENAME`
- 对齐 TaskStateStore 模式(王佐 9/7 落地)
- 6 个生产调用点零改动(env 透明)

`scripts/eval/run-eval.mjs`(+161/-29):
- `memFileRel = .panshalach-memory.eval-<runId8>.json`(per-run 隔离)
- `evalAblationEnv` 追加 `PANSHA_MEMORY_FILE` 注入
- `writeSeedMemory`:B/C/C4 档预填(`--seed-memory <json>` 或默认合成 2 张 success/lesson 卡,
  summary 含【seed】前缀提醒用户覆盖);A 档不写(依赖 `PANSHA_NO_MEMORY=1`)
- `cleanupRunMemory` 在 `finally` 删除 per-run 文件(防半文件遗留污染下 run)
- verdict 落源:`line-defense-failed → 'invalid' + failureTaxonomy.primary='memory-not-cited'`、
  `overflow-skipped → 'not_applicable' + failureTaxonomy.secondary='prompt-too-short'`
- `verdictToEvalVerdict` 简化为 `EVAL_VERDICTS` 透传(completed → pass;其它 fail)
- 入口守卫 `isDirectRun`:import 时跳过 `main()`,避免测试触发真实评测

`tests/eval/run-eval-verdict.test.ts`(新增 14 例):
- verdictToEvalVerdict:7 例(invalid / not_applicable / completed 透传;其它 → fail)
- defaultSeedMemory:4 例(meta + 2 卡、字段对齐 RefinedMemoryCard v3、ID 稳定、【seed】前缀)
- validateResult 兼容:3 例(verdict 双方言接受、failureTaxonomy.memory-not-cited 合法)

踩坑:第一次 test 触发 main() 真实评测(20 runs aborted),"main() 双调用" + import 时未守卫。
修复:`isDirectRun` 检测 `import.meta.url` 等于 `argv[1]` 才执行 main(),其它 import 跳过。

验证:
- `npx tsc --noEmit` EXIT=0
- `npm test` 全量 **780 例 / 779 pass / 1 skip / 0 fail**(基线 766 + 14 新增)
- `node scripts/eval/smoke-eval.mjs` 20/20 全绿
- `node scripts/eval/run-eval.mjs --dry` 正常
- `node scripts/eval/run-eval.mjs --help` 含新 `--seed-memory`

#### 3. push origin + 群里同步(3:00-3:30)

`git push origin zhaotianang1` → 4c7c838 上 origin

群消息草稿(给翟苑皓 + 王浩宇):
- 三件事概述 + 真实跑分入口 `node scripts/eval/run-eval.mjs --tier B --seed-memory ./tasks/T1/memory-fixture.json`
- 测试锚(14/14 + 780/780 + tsc/smoke)
- 等 B 档跑分回归数据

#### 4. 与 origin/wanghaoyu1 U5 集成(4:00)

`git merge origin/wanghaoyu1 --no-edit`:
- Auto-merge `src/cli/repl/Repl.ts`(王浩宇加 `finalizeTaskMemory` 调用,
  我的 TaskCommand 注册保留)
- `scripts/eval/results/schema.mjs`:`TURN_STOP_REASONS` 加 `error` 态(7 态对齐 types.ts 0.7.4)
- `src/server/runAgentTask.ts`:`finalizeTaskMemory` + `normalizeRelPath` 改为 export
- `.github/workflows/agent-branch-guard.yml`:smoke-eval gate
- 零冲突,merge commit 5bf6811

兼容性验证:
- `npx tsc --noEmit` EXIT=0
- `npm test` 全量 780/780 仍绿
- `tests/eval/run-eval-verdict.test.ts` 14/14 仍绿
- `tests/repl/{TaskCommand,TaskState,TaskStateInjection}` 29/29 仍绿
- `smoke-eval.mjs` 20/20 仍绿
- TaskCommand 注册完整保留(import:26 + register:90)

TURN_STOP_REASONS 7 态对齐:`schema.mjs` 加 `error`(王浩宇 2445182),`types.ts` 0.7.4
已有 `error`(先存在)。我的 verdict 路径走 `EVAL_VERDICTS` 双层兼容(`invalid` /
`not_applicable`),不受 `TURN_STOP_REASONS` 加性影响。

#### 5. 推 merge + 群里再同步(4:15-4:30)

`git push origin zhaotianang1` → 5bf6811 上 origin

群消息草稿(给翟苑皓 + kultur):
- zhaotianang1 已与 wanghaoyu1 U5 集成(commit 5bf6811,自动合并 Repl.ts 零冲突)
- schema.mjs 7 态兼容我的 R6 verdict 路径
- 780/780 + 14/14 + 29/29 全绿
- 等 develop 合入窗口,建议顺序:wanghaoyu1 增量 → zhaotianang1 → zhaiyuanhao1

### 自查(D3 早间)

- [x] fetch + 摸清 R6 域(派 Agent 找 5 缺口)
- [x] PANSHA_MEMORY_FILE env 钩子(RefinedMemoryStore)
- [x] per-run 隔离 + 默认 seed + cleanup
- [x] verdict 落源(line-defense-failed → invalid)
- [x] 14 例单测覆盖(verdict 透传 + 默认 seed 结构 + validateResult 双方言)
- [x] import 时守卫,避免 main() 被触发
- [x] merge origin/wanghaoyu1 零冲突
- [x] 群消息已发(翟苑皓 + 王浩宇 / 翟苑皓 + kultur)
- [x] push 5bf6811 上 origin

### Commit 链(D3 早间)

```
5bf6811 Merge remote-tracking branch 'origin/wanghaoyu1' into zhaotianang1
2445182 feat(U5): Repl 三口接线 + TurnStopReason 同步 + smoke-eval CI gate (王浩宇)
4c7c838 feat(R6): B 档记忆 seeding + 隔离 + 0 注入 → invalid 落源 (我的)
0dd1e96 feat(R5): /task risks | next | decide 三子命令 own 端落地 (我的)
d70aefc docs(handover): R5 /task CLI risks|next|decide 三子命令设计稿 (我的)
389e43a feat(R5): /task status 最小版 own 端落地 (我的)
f6c1e9c Merge branch 'zhaiyuanhao1' of ...gitee.com into develop
```

---

## 当前状态

### zhaotianang1 分支(9/10 4:30 推后)

```
5bf6811 Merge remote-tracking branch 'origin/wanghaoyu1' into zhaotianang1
2445182 feat(U5): Repl 三口接线 + TurnStopReason 同步 + smoke-eval CI gate (王浩宇)
4c7c838 feat(R6): B 档记忆 seeding + 隔离 + 0 注入 → invalid 落源
0dd1e96 feat(R5): /task risks | next | decide 三子命令 own 端落地
d70aefc docs(handover): R5 /task CLI risks|next|decide 三子命令设计稿
389e43a feat(R5): /task status 最小版 own 端落地
```

领先 origin/develop 5 commit。

### Task 列表(D3 早间收口)

| # | 任务 | 状态 |
|---|---|---|
| 1 | fetch + 派 Agent 扫描 R6 域 5 缺口 | ✅ |
| 2 | PANSHA_MEMORY_FILE env 钩子 | ✅ RefinedMemoryStore |
| 3 | per-run 隔离 + 默认 seed + cleanup | ✅ run-eval.mjs |
| 4 | verdict 落源(invalid / not_applicable)| ✅ run-eval.mjs |
| 5 | 14 例单测 | ✅ tests/eval/ |
| 6 | tsc + npm test 全绿 | ✅ 780 例 |
| 7 | push 4c7c838 上 origin | ✅ |
| 8 | merge origin/wanghaoyu1 零冲突 | ✅ 5bf6811 |
| 9 | 全量再验证(780 + 14 + 29 + smoke 20)|) | ✅ |
| 10 | push 5bf6811 上 origin | ✅ |
| 11 | 群消息 × 2 已发 | ✅ |

---

## TODO(下一轮)

- [ ] 等翟苑皓/kultur回应合入窗口
- [ ] D3 晚:9/9 日志(已起草在 `feature-zhaotianang1-2026-09-09.md`)
- [ ] D3 晚:同步 merge `origin/zhaiyuanhao1` 0.8 链做全量集成测试
  (可能 Repl.ts 三次 merge 冲突,谨慎)
- [ ] D4+: R7 语义检索 / R8 多级摘要 / 提交物收口

## 附:今日交付物清单

| 类型 | 文件 | Commit | 说明 |
|---|---|---|---|
| env 钩子 | `src/memory/RefinedMemoryStore.ts`(+6/-1 行)| 4c7c838 | `PANSHA_MEMORY_FILE` 透明注入 |
| 隔离 + seed | `scripts/eval/run-eval.mjs`(+161/-29 行)| 4c7c838 | per-run 文件 + cleanup + verdict 落源 |
| 单测 | `tests/eval/run-eval-verdict.test.ts`(新增 182 行)| 4c7c838 | 14 例:verdict 透传 + seed 结构 + 双方言兼容 |
| merge | `5bf6811 Merge origin/wanghaoyu1`(8 行净增)| 5bf6811 | 自动合并王浩宇 U5 |
| 当日日志(9/9) | `feature-zhaotianang1-2026-09-09.md` | (本轮待 commit) | D2 全天收口 |
| 当日日志(9/10) | `feature-zhaotianang1-2026-09-10.md` | (本轮待 commit) | 本文件 |