# 0.7.4 执行计划：部署陈旧 dist 修复 + 中断语义修正 + `?` 行为（交付 Claude Code 执行）

> **执行状态：已全部执行**（commit bdcddd4，0.7.4）——任务 A/B1-B6/C/D 全部落地，验收记录见 CHANGELOG「0.7.4」段（716 例 715+1skip+0 fail，2026-09-06）。

> 执行者：Claude Code。本文件自包含，无需其他对话上下文。
> 仓库：P:\MY_codes\Pangu（Windows，Git Bash，TypeScript ESM，node --test + tsx）。起点分支 zhaiyuanhao1，HEAD=0088d87，工作区干净。
> 纪律：不 commit/push（留给控制人）；不碰王佐领地（src/memory/events.ts、taskState.ts、TaskCommand）、赵天昂领地（scripts/eval、src/memory/embed.ts）；不新增 npm 依赖；types.ts 允许**加性**变更（TurnStopReason 新增值，需在 REFACTOR-ASSESSMENT.md §4 申报）。

## 0. 背景诊断（已完成，直接采信）

1. **dist 陈旧**：dist/ 停在 09-06 00:03 构建（0.7.1 批次 B 中途），0.7.2/0.7.3 的全部修复只在 src。`npm link` 的 zhulong 命令指向 dist/cli.js → 用户实际跑的是旧代码。用户观察到的旧横幅、`?` 旧输出、英文 `explore/rollout` 相位线均源于此。
2. **"提交任务后莫名中断（235ms）"因果链**（LM Studio 日志 + 代码走查证实）：用户加载的模型 `openpangu-7b-diffusion-base-i1` 是 diffusion LLM，LM Studio 对其 chat/completions 请求报 `Unexpected endpoint or method. Returning 200 anyway` → 返回 **200 但 body 非标准 completions JSON** → `json.choices` 缺失 → `EMPTY_RESPONSE` 异常 → `streamChat` 的非流式回退调用是**裸 doComplete（无 withRetry、无 emptyResponse 捕获）** → 异常穿透 loop → `PanshalachChaser.ts:429-434` catch → `syntheticFailureTrajectory()`（`src/loop/trajectory.ts:49-57`）**硬编码 `stopReason:'aborted'`** → UI 渲染"已中断·现场已保留"。**模型错误被伪装成用户中断。**
3. **两个 src 真 bug（与 dist 无关，必须修）**：①上述 syntheticFailure 硬编码；②`src/cli/repl/sseInteractive.ts:1167-1168` 的 `abortReject` 声明后从未被调用——`Promise.race` 的 aborted 分支（:1307-1310）是死代码。

## 1. 任务 A：部署修复

1. `npm run build` 重建 dist（0.7.1-0.7.3 的全部 src 改动生效：横幅 v2、意图前移、真实信号、窗口预算等）。
2. **dist-fresh 启动检查**（防再发）：`src/cli.ts` 入口（rawArgs 解析后、import 引擎前）加约 15 行：递归比较 `src/**/*.ts` 与 `dist/cli.js` 的 mtime，若任一 src 文件晚于 dist/cli.js 且 `stdout.isTTY`，`console.warn('\x1b[33m⚠ dist 落后 src，请执行 npm run build 后再使用\x1b[0m')`（一次性，不阻塞启动）。注意 headless/CI（PANSHA_HEADLESS=1 或非 TTY）不打扰。

## 2. 任务 B：中断语义修正（核心）

### B1 契约扩展
`src/cli/repl/types.ts` 的 `TurnStopReason` 枚举新增 `'error'`。同步 `REFACTOR-ASSESSMENT.md` §4 追加申报条目（加性变更：新增枚举值，旧值语义不变；队友需 rebase 同步）。

### B2 syntheticFailure 区分
`src/loop/trajectory.ts:49-57`：`syntheticFailureTrajectory` 增加参数区分异常类别——
- 判定为 abort：错误名/message 含 `TASK_ABORTED` / `AbortError` / `signal.aborted===true` → `stopReason:'aborted'`（保持现文案）
- 其余一切异常（EMPTY_RESPONSE、网络、解析）→ `stopReason:'error'`（新增），`lastError` 保留原始错误首行
调用方 `src/PanshalachChaser.ts:429-434` 把 catch 到的 err 传入。

### B3 UI 文案
`src/cli/repl/sseInteractive.ts`（result 渲染 :1359 附近、:1755、nextStepHint :201）与 `src/cli/repl/Repl.ts`：
- `'error'` → `✗ 任务执行失败 · <lastError 首行，截 120 字符>` + 下一步提示 `检查模型端点是否为对话模型（diffusion/embedding 类不被支持）· 或重试`
- `'aborted'` 保持现"已中断 · 现场已保留"文案
- 更新 tests 里断言 aborted 的相关用例（`tests/loop/Resilience073.test.ts`、`tests/loop/Termination.test.ts` 中以 EMPTY_RESPONSE/异常驱动并断言 'aborted' 的，改断言 'error'；真 abort 用例保持 'aborted'）

### B4 streamChat 回退保护
`src/model/openai-compatible.ts` streamChat 内部回退到 `doComplete` 的三处（传输失败 :464-472、非 200/无 body :475-478、流式无 delta :573-575）——当前是裸调用。改为：与 `complete()` 同语义——`withRetry(() => doComplete(...))` 包裹 + 捕获 `emptyResponse===true` 时按 complete 的行为返回空串（不再穿透）。注意回退结果的返回形状与 streamChat 消费端（chunksFromCompleteOutput）保持一致。

### B5 EMPTY_RESPONSE 错误文案
`openai-compatible.ts` 抛 EMPTY_RESPONSE 前给 message 追加指引：`EMPTY_RESPONSE: 端点返回 200 但无有效内容。若使用 diffusion/embedding 类模型，LM Studio 对其 chat/completions 返回空体——请加载对话模型`。

### B6 死代码清理
`src/cli/repl/sseInteractive.ts:1167-1168` `abortReject`/abortPromise/race aborted 分支（:1307-1310,1332）整体移除（真中断已由 SIGINT→currentAbort.abort()→loop 信号检查→stopReason='aborted' 链路承担）。同步删除只被该分支使用的变量与文案。

## 3. 任务 C：`?` 行为改透传（控制人裁决）

控制人裁决原文："输入问号也是给模型的信息，/help 再显示帮助"。
- `src/cli/repl/sseInteractive.ts:2002-2011`：删除 `trimmed === '?'` → 快捷帮助面板的分支（`buildQuickHelpLines` 调用处），使 `?` 落入普通任务透传（发给模型）。
- `/help` 行为不变。
- 同步测试：`tests/repl/sseInteractiveBatchB.test.ts` 中 `?` 面板断言改为断言"`?` 不再截获"（或删除该组断言）；`buildQuickHelpLines` 函数本身保留（/help 可复用）不强制删。

## 4. 任务 D：hermes 二次对齐调研报告（纯调研，不实施）

新建 `docs/panshalach/HERMES-ALIGN-0.7.4.md`：对上轮 hermes 对齐报告未采纳项逐项给出判定（建议采纳/推迟/拒绝 + 依据 + 预估成本）：telemetry 单行埋点、不对称压缩（用户原文/固定头永不摘要）、TurnController 抽取（sseInteractive 现 2152 行）、会话存储 append-only 化、模型切换计量重置的剩余面。可用 WebFetch 对照 https://github.com/NousResearch/hermes-agent 的 docs/micro-compaction.md、ui-tui/README.md。**不改任何代码。**

## 5. 问题 2 的思考结论（写入本计划末尾或方案文档，不实施代码）

**是否有影响：有。** 6 个工具 schema 每请求约 2K token（8K 窗口模型占 25%）；对不支持 native function calling 的模型（diffusion、1B 实测）是纯开销（响应端 `tool_calls` 恒空），且工具描述文本对弱模型有行为牵引（实测诱导"凑工具调用"）。
**如果做（登记 ROADMAP-NEXT §6 低优先，本轮不做）**：
1. toolSchemas 按 intent 过滤：chat 已零工具（0.7.2）；search 收窄为 read_file/glob/grep 三件；task 全集——engineAdapter.toolSchemas 已是单点，改动小。
2. `PANSHA_TOOLS_MODE=text|native|off` 环境开关：off=请求体不带 tools（纯文本协议，适配不支持 FC 的端点）；同时是评测消融维度。
3. schema 压缩：description 一行化 + parameters 说明精简（次优，收益递减）。

## 6. 验证门（全部真实执行并记录输出）

1. `npx tsc --noEmit` 干净
2. 全量 `node --test --import tsx --test-concurrency=4 "tests/**/*.test.ts" 2>&1 | grep -E "^# (tests|pass|fail)"` 全绿（当前基线 664 例：663+1skip+0 fail；新增用例后应 ≥666）
3. `node verify-panshalach-cleanup.mjs` PASS、`node scripts/check-protected-files.mjs` PASS
4. `npm run build` 后 grep 确认 dist 特征：`VERIFICATION: APPLIED`、`buildBanner`、`'error'` 出现在 dist
5. 新增测试清单（必须）：
   - EMPTY_RESPONSE 异常 → syntheticFailure 判 'error'（非 'aborted'）
   - TASK_ABORTED 异常 → 'aborted'
   - streamChat 对"200 无效 body"端点：回退 doComplete 走 withRetry（≥2 次请求）且最终空串不穿透
   - `?` 输入作为任务文本透传（不再出帮助面板）
6. 真机复测指引（写给控制人，不阻塞交付）：LM Studio 当前加载的 openpangu-7b-diffusion-base-i1 不支持 chat/completions——请换成标准自回归对话模型（如 openpangu-7b 非 diffusion 版）后重试；dist 重建后横幅应显示 v0.7.3+ 模型/档位/模式三行。

## 7. 汇报要求

逐项（A/B1-B6/C/D）file:line 改动摘要 + 新增测试清单 + 验证门 1-4 的真实输出 + 与本计划的差异说明（做了/没做/为什么）。不 commit/push。
