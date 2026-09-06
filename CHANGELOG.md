# Changelog

## 0.7.4 (部署陈旧 dist 修复 + 中断语义修正 + `?` 透传 + hermes 二次对齐调研)

方案：`docs/panshalach/PLAN-0.7.4-FOR-CLAUDECODE.md`（控制人实测驱动）。用户跑的 zhulong 是 **09-06 00:03 的旧 dist**（0.7.1 批次 B 中途构建），0.7.2/0.7.3 全部修复只在 src——"莫名中断""explore/rollout 英文相位线""旧 `?` 输出"三个观测全是旧代码。"提交任务后莫名中断（235ms）"因果链：LM Studio 对 diffusion 模型（openpangu-7b-diffusion-base-i1）chat/completions 报 `Unexpected endpoint or method. Returning 200 anyway` → 200-garbage → `EMPTY_RESPONSE` → streamChat 回退裸 doComplete（无 withRetry/无 emptyResponse 捕获）穿透 → chaser catch 兜底硬编码 `stopReason='aborted'` → UI 渲染"已中断·现场已保留"。**模型错误被伪装成用户中断。**

**任务 A：部署修复**
- `npm run build` 重建 dist（0.7.1-0.7.3 全部 src 改动生效）。
- `src/cli.ts` 入口 `warnIfDistStale()`：任一 `src/**/*.ts` mtime 晚于 `dist/cli.js` 且交互模式（stdout TTY + 非 `PANSHA_HEADLESS`）时打一行黄字提醒"⚠ dist 落后于 src，请执行 npm run build"；headless/one-shot/生产无 src 场景静默；检查异常绝不阻塞启动。

**任务 B：中断语义修正（契约加性变更，REFACTOR-ASSESSMENT §4 申报 ⑦）**
- `src/cli/repl/types.ts`：`TurnStopReason`/`TurnOutcome` **加性新增 `'error'`**（模型/网络/解析异常），旧值语义不变。
- `src/loop/trajectory.ts`：`syntheticFailureTrajectory` 新增 `isAbortLikeError` 判定——`TASK_ABORTED`/`AbortError`/`aborted before dispatch` → `'aborted'`（真中断语义不变）；其余一切异常 → `'error'`（`lastError` 保留原始错误首行）。
- `src/model/openai-compatible.ts`：streamChat 三处裸 `doComplete` 回退（传输失败/非 200/流式无 delta）收敛为 `completeLikeFallback`——withRetry 包裹 + `emptyResponse` 重试耗尽转空串，与 `complete()` 同语义，消灭"三连发穿透"；`EMPTY_RESPONSE` 文案追加指引：`若使用 diffusion/embedding 类模型，LM Studio 对其 chat/completions 返回空体——请加载标准自回归对话模型`。
- UI 四态文案（`sseInteractive.ts` nextStepHint/mapSseToBridge/renderSseEvent、`Repl.ts`、`RunCommand.ts`）：`error` → "✗ 任务执行失败 · <lastError 首行截 120 字> · 下一步: 检查模型端点是否为对话模型（diffusion/embedding 不受支持）· 或重试"；`aborted` 保持"已中断·现场已保留"。
- `sseInteractive.ts` B6 死代码清理：`abortReject`/`abortPromise`/`Promise.race` aborted 分支整体移除（abortReject 从未被调用 → 分支永不可达）；真中断由 SIGINT → `currentAbort.abort()` → loop signal 检查 → `stopReason='aborted'` 链路承担；aborted turn 落盘并入统一路径，**顺带修复活路径不落 `partialText` 的缺口**。
- **队友注意**：`TurnStopReason` 枚举加性新增 `'error'`，rebase 后请同步本地认知；R6 schema（`scripts/eval/results/schema.mjs` `TURN_STOP_REASONS`）仍为 v0.6.5 方言（含 verification-failed-continue、缺 answered/error），评测 verdict 消费前需对齐（归 R6 域，本轮未动）。

**任务 C：`?` 行为（控制人裁决："输入问号也是给模型的信息，/help 再显示帮助"）**
- `sseInteractive.ts` 删除 line 主路径 `trimmed === '?'` 快捷帮助截获——`?` 作为普通任务文本透传给模型（taskIntent 分类为 chat → 单次直答）；`/help` 行为不变；`buildQuickHelpLines` 保留（/help 复用）；横幅第三行同步去掉 `? 快捷帮助` 字样。

**任务 D：hermes 二次对齐调研（纯调研不实施，`docs/panshalach/HERMES-ALIGN-0.7.4.md`）**
- 上轮未采纳项五项判定：telemetry 单行埋点 **推迟**（rollout jsonl 账本已承载，缺的只是观测粒度）；不对称压缩 **推迟**（须先给 Turn 加角色字段，与 R8 envelope 强耦合）；TurnController 抽取 **推迟**（sseInteractive 2152 行 L 级拆分须测试先行）；会话 append-only 化 **拒绝**（rollout jsonl 已提供崩溃安全，SessionStore 是非权威快照；hermes 自己已反向演进 JSONL→SQLite）；**模型切换计量重置 → 建议采纳最小面**（classic/Repl 路径 `solveIssue` 漏传 `windowTokens`，0.7.3 窗口预算在该路径不生效——遗留为独立小项）。

**问题 2 结论（登记不实施，ROADMAP-NEXT §3.2）**
- 6 工具 schema ≈2K token/请求（8K 窗口占 25%），对不支持 native FC 的模型（diffusion/1B 实测）纯开销且有行为牵引。低优先三项：toolSchemas 按 intent 过滤（search 只读三件，chat 已零工具）/ `PANSHA_TOOLS_MODE=text|native|off` 开关（兼评测消融维度）/ schema description 一行化。

**验证记录（Windows / Node 22，2026-09-06）**
- `npx tsc --noEmit` EXIT=0。
- 全量 `node --test --import tsx --test-concurrency=4 "tests/**/*.test.ts"`：**716 例：715 pass + 1 skip + 0 fail**（0.7.3 基线 664 例 + 新增 ErrorSemantics 7 例 / QuestionMarkPassthrough 3 例 / streamChat 回退重试 2 例；高并发偶发进程级崩溃假象复跑消失，最终一次全绿）。
- `node verify-panshalach-cleanup.mjs`：静态检查 PASS；0.7 段仅 `continueCount zero refs` FAIL——由 R6 域 `scripts/eval/{results/schema.mjs,smoke-eval.mjs}` 残留引用导致（判官语义字段进评测 schema 是 R6 合入 f9219ee 引入，**本轮 start 前已存在**，归 R6/赵天昂域销项，禁越界）。
- `node scripts/check-protected-files.mjs` PASS（TurnStopReason 六旧值全在 + 加性值不违约）。
- `npm run build` EXIT=0；dist 特征 grep：`VERIFICATION: APPLIED`/`buildBanner`/`completeLikeFallback`/`isAbortLikeError`/`warnIfDistStale` 均在，`trimmed === '?'` 为 0。

**真机复测指引（待控制人）**
- LM Studio 当前加载的 `openpangu-7b-diffusion-base-i1` **不支持 chat/completions**（返回 200-garbage）——请加载标准自回归对话模型后重试。
- dist 重建后启动横幅应显示 v0.7.3+ 三行（模型/档位/模式）；若 src 有未构建改动会出现"⚠ dist 落后于 src"黄字提醒。
- 四路径复测：`1` / `你好，回答我你是谁`（单次出正文）；Ctrl+C（网关停 POST）；`hello.txt`（先搜索搜不到询问）。

**Risks**
- fetch 发出后 abort 只中断读取/连接，网关侧生成可能仍算完（0.7 已知边界，如实声明）。
- sseInteractive 活路径 aborted turn 现依赖 runPromise settle 后的 `stopReason==='aborted'` 分支落 partialText——若 abort 发生在 runAgentTask 之外的更早窗口（如审批挂起），落盘路径仍走 catch 分支（无 partialText，可接受）。
- `?` 透传后，弱模型对 `?` 输入的回答质量取决于模型本身（1B 可能返回空泛答复）——语义上"给模型的信息"由模型消化，不再有本地兜底文案。

## 0.7.3 (主链确定性：真实成功信号入册 + 三入口审批/中断透传 + 窗口预算挂真值 + 中断现场落盘)

方案：`docs/panshalach/USABLE-PLAN-0.7.3.md`（5 份子智能体审查报告收敛——CC / dsh / hermes / oh-my-pi / 红队对抗自审）。红队用可复现探针实测出**两个被 629 例绿灯密封的 P0**：真实工具成功被误判为失败（唯一 PASS 产出方是 smoke mock，真实引擎的 `EXIT_CODE:0`/`WRITE_SUCCESS:` 被判 FAIL，勤奋模型被连败掐死、只说话的模型反而 `answered` 计成功）、completed 真机不可达导致记忆闭环死码；外加文档主验证命令的审批断链（A3）与 classic 假中止（A4）。本轮 13 项三梯队全部落地，回答一个问题：**砍掉什么、修什么，才能让评委/新用户明天拿真实模型跑通一天**。

**真实成功信号入册（T1#1，A1+A2 同修）**
- `src/tools/engineAdapter.ts` `describeResult` 按 `res.ok` + 工具类别**确定性追加**规范尾标（不做正文字符串扫描）：bash/write_file/edit_file → `VERIFICATION: PASS`（bash 的 `EXIT_CODE:0` 尾行已有）；read_file/glob/grep → `VERIFICATION: NEUTRAL`（只读，无验证效力）；失败分支不追加任何 VERIFICATION 行——失败永远不该长得像成功
- `src/loop/VerifyCritiqueLoop.ts` `classifySignal`：`VERIFICATION: NEUTRAL`/`PARTIAL` → PARTIAL（清零连败但不计 PASS、不触发 completed/产卡），子句置于 FAIL/ERROR 检查**之前**（只读输出正文可能偶然含 "error" 字样）；裸 `EXIT_CODE:0` 用尾部锚定 `/\nEXIT_CODE:0\s*$/` 判 PASS（排在 FAIL 之后，防正文内嵌字面量误判）；`didRealVerification` 的 `verification:` 松匹配收紧为 `verification: pass`（防 NEUTRAL 尾标误计真实验证）
- 效果：真实成功 → PASS → **completed 真机可达** → 记忆闭环（0.7.2 finalizeTaskMemory）激活

**三入口审批/中断透传（T1#2，A3+A4）**
- `RunCommand` / `Repl.executeTask` / `SimulateCommand` 向 solveIssue 透传 `approvalMode / sessionAllowlist / approvalBridge / signal`（照 runAgentTask 已有形态的**最小透传面**，每处 ≤10 行）；`types.ts` `CommandContext` 增可选 `approvalBridge?/signal?`，Repl.buildContext 与 sseInteractive resume 注册点注入现成审批桥
- 效果：`--approval full` 在 one-shot/headless **真实生效**（此前 flag 只改 session 字段、引擎收不到，写文件必被拒）；classic 路径独立 AbortController 贯穿 solveIssue → loop → 模型 fetch/工具执行，Ctrl+C 不再假中止；SimulateCommand 仅透传 approvalMode（dryRun 在 adapter 构造前返回，桥/信号无消费方，声明不做）

**集成测试去 mock 回环（T1#3）**：新增 `tests/integration/realEngineLoop.test.ts` / `tests/loop/RealSignal.test.ts`——用**真实引擎输出形状**（`EXIT_CODE:0` / `WRITE_SUCCESS:` 文本协议，mock 关闭）驱动 completed 判定与 finalizeTaskMemory 断言，锁定尾标行为

**中断现场落盘（T2#4）**
- `loop.run` 返回 `partialText`（aborted 时本步已流出的模型正文）；`Trajectory`/`Turn`/`RunResult` 增可选 `partialText`；sseInteractive 与 Repl classic 两路径的 aborted 回合都写 turn（session + rollout jsonl，`Repl.recordAbortedTurn`）——**"现场已保留"文案从此有数据支撑**（0.7 时该文案与现实相反）
- 中止检查从"complete 返回后立即 break"移到本地解析之后：解析是纯本地操作，先做它才能保全"已流出正文 + 已解析 toolCalls"的现场；已解析 toolCalls 补 `aborted before dispatch` 合成失败结果（call/result 成对进历史）

**answered 空转防呆（T2#5）**：execution 意图且从未做过真实验证时，"有正文却只说话不动手"的**第一次不终局**——注入一次格式提醒重试一步（消费型旗标，不引入新状态机）；第二次仍无动作按 `no-verification` 终局（不计 success）

**窗口预算挂真值（T2#6）**
- `ModelProvider.getModelContextLength` 未知回落 256000 → **32768 保守值**（把未知窗口当 256K 用会让 8K 模型长任务必爆；保守值只多压缩不误判）；预算侧（`runAgentTask.resolveWindowTokens` / `sseInteractive.resolveCtxWindowTokens`）把 `≤0` 与 `===256000` 哨兵一律视为 unknown → 32768（消化历史配置已写入的哨兵）
- `PANSHA_CTX_WINDOW||128000` const 常量废弃：上下文窗口每任务边界调 `getModelContextLength` 重取（去 const 化），`/model` 切换清零 ctxUsedChars 并立即重取；`PANSHA_CTX_WINDOW` 保留为显式覆盖
- loop 增 `windowTokens`：history 组装后超窗口 70%（chars/4 估算）裁中段——保前 2 步 + 后 2 步 + 显式裁剪标记（未提供时保持旧行为）
- `ModelCommand /model list` 未知上下文**持久化 null**（不再写 256000 假值）、列表显示"未知"（不再冒充 256K）

**finish_reason=length 防御（T2#7）**：`openai-compatible.ts` complete/streamChat 捕获 `finish_reason==='length'` → `truncated` 标记三层透传（非流式返回对象 / 流式尾 chunk `finishReason` / chaser 流式 wrapper 聚合）；loop 对截断响应**禁判 answered**，注入"上一条响应被 max_tokens 截断，请精简后继续"重试一步——残缺 tool_calls / 半句答复不再静默假完成

**首跑报错质量（T2#8）**：`resolveSharedClient` 报错改三选一中文指引（① 项目 `.panshalach.json` ② 用户级 `~/.panshalach/config.json` ③ `/model list`）；REPL 启动横幅预检无可用 provider 时打一行灰字配置指引（不阻塞、可热加载）

**结果截断改超阈值才剪（T2#9）**：`buildHistoryPrompt` 结果上限 200-300 字符 → **4000 阈值**：≤4000 原样保留；超限保留头 2500 + 尾 800 + 显式 `[...已修剪 N 字符...]` 标记与重读提示——read_file 输出不再被静默剪成"文件不完整"

**withRetry 对齐（T2#10）**：重试 3 → **5 次**（远程网关抖动窗口常超 3 次退避）；`isRetryableErr` 补传输类错误（`TypeError` / "fetch failed"）

**写集提取修正则（T3#11）**：新增 `extractShellWriteTargets`——重定向目标支持引号内空格（`> "my file.txt"`）与 Windows 盘符整体捕获（不再截成 `C:` 碎片）、tee/tee -a 按管道段解析、fd 前缀（`2>`）处理；`extractWrittenFilePaths` 导出供测试

**'a' 决策持久化（T3#12）**：审批"总是允许"best-effort 写入项目配置 `.panshalach.json` 的 `approvalAllowlist`（`ConfigManager.appendProjectApprovalAllowlist`，主 gate 与 MCP gate 同语义）；Session 构造器启动时并集加载回 sessionApprovalAllowlist——跨会话不再重复确认

**文档清漂（T3#13）**：DEPLOY-CN §2.4 验证命令按真实引擎行为重验重写（completed 预期 + 省略 `--approval` 的 readonly 拒写为门禁正确行为）、§3.1 `modelContexts` 表述改准（预算挂真值 + null 持久化）；`/agents` "并行 rollout" 文案删除（0.7 起恒单 rollout 串行）；`package.json` 版本 0.7.0 → **0.7.3**

**明确不进本轮（L 级，登记 ROADMAP-NEXT §3.2）**：消息数组协议重构（complete/streamChat 的 messages 入口）、sseInteractive 巨函数拆分、会话树指针化、subagent 委派、hooks 总线、后台 bash——均与"明天跑通一天"无直接因果且为跨文件大手术

**Tests**: `npx tsc --noEmit` EXIT=0；`node --test --import tsx --test-concurrency=4 "tests/**/*.test.ts"` **663 例：662 pass + 1 skip + 0 fail**（2026-09-06，Windows/Node 22）。新增 5 个测试文件：`tests/integration/realEngineLoop.test.ts`、`tests/loop/RealSignal.test.ts`、`tests/loop/Resilience073.test.ts`、`tests/model/openai-compatible.073.test.ts`、`tests/server/Resilience073.test.ts`；`tests/loop/CritiqueContext.test.ts`（T2#9 新契约：>4000 才剪 + 头尾保留断言）与 `tests/repl/ModelProviderEnv.test.ts`（未知回落 32768）随契约更新
**Risks**: 真机四用例待端点（LM Studio 恢复后按 F6 纪律执行，禁止预填 PASS）；记忆闭环本版仅 runAgentTask 路径（SSE/server/headless）生效，Repl 直调 PanshalachChaser 三口 finalize 待统一执行器收口；MCP 工具结果无验证尾标（尾标只覆盖内置工具，MCP 调用不参与 PASS 判定）；fetch 发出后 abort 网关侧生成可能仍算完（0.7 既有边界）

## 0.7.2 (反思迭代：意图分类前移接线 + 记忆落定主线版 + 集成测试锁死 + 提交物定稿)

反思审查（`docs/panshalach/REFLECTION-0.7.2.md`，8 维度）核心结论：**主线空心化**——0.7/0.7.1 在集成线上完成了终止语义与 UI 工程，但意图分类在富化文本上分类致 chat/search 恒不可达（0.7 宣称的修复运行时未生效）、记忆闭环 4 环只真 1 环（refine/markVerified 生产调用点为零）；625 例全绿里没有一条入口级意图路由或记忆落定的集成断言。本轮消灭前两个（commit ff6dce9）。

**意图前移（4/4 入口接线）**：`runAgentTask` / `Repl` / `RunCommand` / `SimulateCommand` 在 `buildForTask` 之前对**原始输入**分类，intent 同时传富化与 solveIssue——chat 直答 / search 只读 ≤3 步 / task 循环在运行时首次真正可达；`PANSHA_INTENT_GATE` 语义保持

**记忆落定（R1/R2 主线版）**：`finalizeTaskMemory` 单一落定点（runAgentTask result 前）——completed 时 refine→save（R1）+ `injectedCardIds ∩ 轨迹写集` → markVerified（R2），发 `memory.finalized` 事件；失败不影响任务返回。覆盖 sseInteractive/server/headless 路径（Repl 直调 PanshalachChaser 的三口未接，留统一执行器收口）

**集成测试 4 例**（`tests/integration/intentAndMemory.test.ts`，先红后绿实证：接线前 1/4 红、接线后 4/4 绿）：greeting→answered 无格式教学、.ts 整理→search readonly ≤3 步、completed→自动产卡 + markVerified、非 completed 守卫

**提交物定稿**：`SUBMISSION.md`（概述 922 字，创新点与代码事实逐条对齐，评测零数字）+ `DEPLOY-CN.md` 新建（已验证本机路径 + PANSHA_* 全集 13 项 + 昇腾/麒麟标注待实测）

**Tests**: `npx tsc --noEmit` 干净；全量 **629 例（628 pass + 1 skip + 0 fail）**；cleanup/protected-files PASS
**Risks**: 三队友分支合入（B1-B3 评审）与 R6 评测合入为本轮明确不做的最高优先移交项；Repl 直调三口 finalize 待统一执行器；真机手测待端点

## 0.7.1 (UI 手感两批次：信任级/反馈级 + 引导级/质感级 + backlog C/F/D 组)

对标 CC 2.1.88 源码解剖的 REPL 手感改造（方案：`docs/panshalach/UI-UX-REVAMP-0.7.1.md`），两批次全部落在 line 模式主路径（`sseInteractive.ts`）。

**批次 A——P0 信任级 + P1 反馈级（commit e88048a）**
- **P0-1 Ctrl+C 全链路**：SIGINT 兜底 / 空闲二次确认退出 / 幽灵窗口消除 / 审批即拒
- **P0-2 gerund 清行纪律**：renderer Proxy 单点，治"研磨中…⏱[Step 1]"输出拼接污染
- **P0-3 审批三连伤**：暂停 gerund 重绘 / Ctrl+C 即拒 / 每秒倒计时 / 拒绝附指导语 `n:<语>`
- **P1-1 真流式**：thinking 单行滚动∴ + 折叠统计、message.delta 逐字、`/verbose` 开关
- **P1-2 工具实时卡片**：`▸` 头行 + `⎿` 动词句结果行（pre/post 事件接线）
- **P1-3 结束总结块**：三态·步数·耗时·tokens·按 stopReason 分支的下一步建议
- 新增 25 例 UI 单测（`tests/repl/sseInteractiveUi.test.ts`）；评审后修复 'a' 决策回归 / 审批 stdin 泄漏 / 超时钩子残留 / denied 事件缺口等 7 项

**批次 B——引导级 + 质感级（commit 72bdf21）**：横幅 v2（模型/档位/模式/cwd 分层）、Tab 补全 + `?` 快捷面板 + 未知命令模糊建议、`/help` 三处统一（26 命令分组）、模式徽标 + shift+tab 切换 + `/mode` 回执、CJK 宽度治理（stringWidth 接入 table/截断/横幅）、文案纯中文化、情境 tip（≤2 条/会话）；顺带修复 `/mode plan` 落错档的既有 bug

**backlog C 组技术债 8 项**：C1 记忆文件 200KiB 上限执行、C2 compact 先写盘后改内存、C3 FeatureTracker 写失败告警、C4 walkFiles symlink 防御、C5 appendEvent auditStatus、C6 Reviewer 探测/执行两态（消假 passed:true）、C7/C8 bash abort 击杀树 + 跨平台 killTree 归一（Windows `taskkill /T /F`，POSIX `kill(-pid)`）

**F 组收尾 / D 组工程**：F2 abort 传播 4 例、F3 单次调用 + chat answered 断言、F4 answered 不产 success 卡 2 例、F7 PromptBuilder intent 参数化（不传 intent 逐字节等价）；D1 cleanup 脚本增强（8 项 0.7 检查）+ D3 `scripts/check-protected-files.mjs` 新建

**评审修复**：未知命令建议自指死循环（/exit 无限建议）、建议确认先过本地命令注册、后台 apply 失败 warn 级、`/rewind line` 提示真实路径（不再静默 no-op/误发任务）、rich 路径 phase 本地化

**文档**：`UI-UX-REVAMP-0.7.1.md` 新增；backlog 文档 8 项（CHANGELOG 复验补强、ROADMAP 销项 + 遗留、ARCHITECTURE §1/§3 重画 + §5 模板、README/USER-GUIDE 对齐 0.6.5+0.7、REFACTOR-ASSESSMENT 申报累计）

**Tests**: `npx tsc --noEmit` 干净；批次 A 后全量 **570 例（569 pass + 1 skip + 0 fail）**、批次 B 后 **625 例（624 pass + 1 skip + 0 fail）**（`--test-concurrency=4`）；cleanup PASS、protected-files PASS
**Risks**: chat 意图在富化文本上分类致 REPL 路径 chat 不可达（0.7 既有错位，0.7.2 消灭）；真机 TTY 手测待 LM Studio 端点恢复

## 0.7.0 (终止语义重构：判官摘除 + 意图分类 + AbortSignal 贯穿)

产品主实测复现的系统性问题修复：简单输入（"1"/"你好，回答我你是谁"）被重复执行十几次、单任务跑 905s 不收敛；运行中 Ctrl+C 停不下来（网关侧仍持续 POST）；纯问答显示"任务未通过验证"且看不到模型答复。方案文档：`docs/panshalach/FIX-0.7-TERMINATION.md`。

**判官摘除（0.6.4 双层终止收缩为单层）**
- `continuationJudge.ts` 归档至 `archive/2026-09-05-removals/`（判官是唯一外层续跑源——`maxRollouts` 已全档为 1）；回合上界从 ~20 步×3 轮压回单次 `maxSteps`
- `TurnStopReason` 移除 `verification-failed-continue`；`Trajectory` 移除 `continueCount`
- **TestTimeOrchestrator 一并移除**（runMultiple 恒单次后 count/sort/预算裁剪全为死路径）：`Trajectory` 类型迁至 `src/loop/trajectory.ts`，chaser 单次直调 `loop.run()`，空批保护（合成失败轨迹 + lastError）并入 chaser

**回合三态（CC 式自然停即成功）**
- `answered`（新增）：end_turn 无工具调用且**有面向用户正文**（剥结构块后非空）→ `success=true`，UI 显示"已回复"并把模型正文呈现给用户（此前纯问答被标失败且答复被吞）
- `no-verification`：end_turn 但无正文无工具（空白/空转）→ 仍失败
- `completed`：轨迹含真实验证 PASS（保留）
- **记忆信号收紧**：`refine`/compact 补漏的 success 卡信号从 `trajectory.success` 改为 `stopReason==='completed'`——纯问答/闲聊不再产生 success 卡（UI 成功 ≠ 记忆成功）

**意图分类（`src/cli/taskIntent.ts`，纯函数）**
- 四类：`execution`（工程动词/工具/命令/@path）/ `search`（文件后缀无动词——**先只读搜索，搜不到询问用户具体用意**，≤3 步、强制 readonly、禁写禁 bash）/ `chat`（问候/自我询问——单次 complete 直接回答，不进 agent 循环、不灌格式教学与工具 schema）/ `meta`
- `PANSHA_INTENT_GATE=0` 逃生门（全量按 execution 兜底）
- Prompt 组装按意图分支：`StructuredReasoner.buildChatDirective`/`buildSearchDirective` 与执行路径的格式教学彻底分离——消除"对话不调工具"与"每步必须输出工具块"的指令冲突（弱模型伪工具调用空转的直接诱因）

**AbortSignal 贯穿（真正的 Ctrl+C）**
- `solveIssue → VerifyCritiqueLoop → modelClient.complete(opts.signal) → openai-compatible fetchWithTimeout（外部 signal 合并进内部 controller）/ streamChat 读循环（abort 即抛 TASK_ABORTED）→ engineAdapter/executor`
- `runAgentTask` 把 `ctx.signal` 透传给 solveIssue（此前只用于丢事件——signal 到 runAgentTask 边界就断了）；UI 层 abort 后**等待底层 settle**，不再"UI 返回但网关继续刷 POST"
- loop 每步开头 + 模型调用返回后检查 signal → `stopReason='aborted'`
- 已知边界：fetch 发出后 abort 中断的是读取/连接，网关侧生成可能仍在后台算完（无 stream 关闭语义时）；bash 子进程强杀待后续版本

**预算累计修复**
- `estimatedUsedTokens` 按每次模型调用累加（prompt+响应长度估算；此前声明后从未累加 → `[最终预算 0%]` 恒 0 误导）

**文档/测试**
- 新增 `docs/panshalach/FIX-0.7-TERMINATION.md`（方案）；`tests/loop/Termination.test.ts`（6 例：answered/no-verification/completed/max-steps/consecutive-failures/aborted）、`tests/cli/taskIntent.test.ts`（7 例）、`tests/tools/withWriteLock.test.ts`（写互斥从 orchestrator 测试迁出保留）
- 删除 `ContinuationJudge.test.ts`/`TwoLayerTermination.test.ts`/orchestration 两测试；记忆测试正向卡用例随信号源更新（`stopReason='completed'`）
- 验证（2026-09-05，Windows/Node 22）：`npx tsc --noEmit` 干净（EXIT=0）；`node --test --import tsx --test-concurrency=4`（显式 glob 全目录）**545 例：544 pass + 1 skip + 0 fail**；`node verify-panshalach-cleanup.mjs` **OVERALL CLEANUP STATUS (static checks): PASS**（收尾复验 2026-09-05：三项命令原样重跑，结果与上述一致）
- 待实测（用户侧，需真实端点；负责人：翟苑皓 F6）：REPL 输入 `1`/`你好，回答我你是谁` → 单次出正文；运行中 Ctrl+C → 任务真停、网关停 POST；`hello.txt` → 先只读搜索、搜不到询问具体用意

## 0.6.5 (部署落地：全局唤起 + 原生 function calling 请求侧 + 写工具全档位 + CC 风格提示词)

产品主"部署后无法唤起"排查引出的全链路修复（本地 LM Studio openPangu-Embedded 实测驱动）：

**部署与配置**
- **全局部署**：`npm link` 生成 zhulong/panshalach bin（此前从未安装；旧名 `zorge` 孤儿 junction 指向无关项目，已清理）
- **配置播种缺口**：`session.model` 此前只认 `PANSHA_MODEL` env，配置文件的 `model` 字段从未生效（不带 env 必报"未配置可用的模型客户端"）。新增 `modelSeed.ts`：`applyConfigModel` 在 env 缺席时从配置兜底播种，接入 runOneShot / startRepl / sseInteractive / classicRepl 全部入口
- **ConfigManager 加载顺序修正**：原实现用户级 `~/.panshalach/config.json` 覆盖项目级 `.panshalach.json`（与注释意图相反）→ 改为项目级覆盖用户级；用户级目录支持 `PANSHA_USER_CONFIG_DIR` 重定向（测试隔离）
- **审批通道**：`--approval <readonly|default|full>` flag 与 `PANSHA_APPROVAL` env——headless/一次性执行此前锁死 readonly，写文件必然被拒

**原生 function calling（P1.1 请求侧闭环）**
- `CompleteOptions.tools`（OpenAI function schema）→ openai-compatible 客户端 `stream:false/true` 两条请求路径透传 `tools + tool_choice:auto`；抓包代理实证 6 schema 随每次请求下发
- `EngineAdapter.toolSchemas()`：内置 6 工具 + MCP 的 schema 导出（参数键与各实现严格一致）；VerifyCritiqueLoop 真实引擎自动携带，mock/旧引擎不受影响
- 响应侧 `tool_calls` 透传此前已就绪（0.6.x），至此请求-响应闭环

**工具与提示词**
- **写工具全档位注册**（产品主裁决）：write_file/edit_file 不再限于 high+，quick/standard 同样注册；安全性由审批门禁 + RBW 兜底，不靠隐藏工具（实测：隐藏工具 + 教学示例含 write_file → UNKNOWN_TOOL 空转烧满步数）
- **格式教学具体化**：`buildToolCallFormatEnforcementPrompt(toolNames?)` 按实际可用工具动态生成 few-shot 示例（抽象 `paramName1` 模板对小模型无效，实测改进后模型产出标准 `<> <write_file>` 调用）；任何档位首轮必注入
- **身份提示 CC 化**（参考 claude-code-2.1.88 / harness-engineering 调研）：双职责定义（对话 vs 执行）+ 意图门槛（模糊输入先澄清不调工具）+ 歧义不往高风险方向解读 + 简洁回答风格；效果待 7B+ 模型验证（1B 分不清示例与指令）

**验证边界（如实记录）**：openpangu-embedded-1b-i1 的 chat template 不支持 tool use（`tool_choice:required` 亦无法诱导 tool_calls）；文本协议 + few-shot 下可完成简单写文件任务（hello.txt 实测落盘、RBW/UNKNOWN_TOOL 反馈回路工作），但成功率与示例遵循度受 1B 能力限制。端到端验收建议使用支持 tool use / 指令遵循更强的模型（openPangu 7B+）。

全套 545 例通过（另：node --test 全量高并发在 Windows 下有进程级崩溃假象，单文件或 `--test-concurrency=4` 均绿）。

## 0.6.4 (R0：双层终止语义 + 三先决修复)

产品主批准的 R0 落地（对抗清单 #1/#6/T-22 + 终止语义双层化）：
- **契约 v3.1**：`TurnStopReason`（completed / verification-failed-continue / max-steps / consecutive-failures / aborted / no-verification）；`Trajectory` 增 `stopReason/continueCount/lastError`
- **双层终止**：loop 层 end_turn（无工具调用）即自然停——PASS 字符串降级为 evidence（计入 trajectory.success 但不再直接终止）；`consecutive-failures`/`max-steps` 保留对应 stopReason。闲聊类任务 1 步即停（实测 nihao 40s→3s）
- **外置判官**：新增 `src/loop/continuationJudge.ts`（CC Stop-Hook 等价）——turn 结束时若未验证完成且轨迹出现过工具调用，注入"验证未通过：原因，继续"有界续跑（≤2 次）；纯文本回合不判官
- **#1 修复**：`withRetry`（429/5xx/网络错误，Retry-After 头优先，±25% jitter，≤3 次）+ `EMPTY_RESPONSE` 可重试（耗尽返回空）+ reasoning_content 兜底（openPangu-Embedded 实测偶发 200 空 content）+ orchestrator 空批合成失败轨迹（不再返回 undefined 导致 TypeError）
- **#6 修复**：count 翻倍——createOrUpdateCard/addRemember 改脱离缓存克隆（count 预解析）、createPositiveCard 同 id 预解析、mergeAndCap 同 id 整卡替换（R1 写闭环前置）
- **T-22 修复**：`ProviderRegistry.createClientSync` 透传 streamChat（生产不再恒非流式）
- **registry 模型名前缀剥离**：`createClientSync` 兜底取 `config.model` 时原样发送 `openpangu:xxx` 路由串 → 网关 400（本地 LM Studio 实测发现并修复）
- **reasoning_content 兜底**：非流式响应 content 空但 reasoning_content 非空时采用之（openPangu-Embedded 实测偶发 200 空 content）
- 新增测试 14 例（judge/双层终止/retry/空批/count 回归），全套 542 例

## 0.6.3 (score 字段整体移除：成败唯一由验证信号判定)

承接 0.6.1/0.6.2 的打分器归档，`score` 概念彻底退出：
- `Trajectory.score` → `Trajectory.success?`（验证信号标注）；orchestrator 排序/早停/预算裁剪改按 success；`setScore`→`setSuccess`
- `solveIssue` 返回值移除 `score`（REFACTOR-ASSESSMENT §4 禁区二次申报）；`RunResult`/result 事件/SSE `done` 事件/CLI 与 SSE 显示全部去 score
- `Turn.result.summary` 从 `score=NN` 改为验证结果短文本（"已通过验证"/"未通过验证"）
- 记忆正向信号：`refine()` 由 `score≥85` 改为 **trajectory.success（验证通过）或正向反馈**；`POSITIVE_SCORE_THRESHOLD` 删除
- compact 补漏：信号源从"summary 正则抽 score≥85"改为 **result.success**；success 卡 evidence 改为该轮任务摘要（修复零信息量卡 + 高分 hash 撞卡问题）
- 前端 demo 得分显示改验证状态；测试随语义更新（525 例全绿）

## 0.6.2 (性能叙事装置摘除：单 rollout、去 critique/静态分析/锚点/风格头/FailureMemory 轨道)

产品主裁决（2026-09-05，探测报告 7 项）落地，全部归档至 `archive/2026-09-05-removals/`：
- **#1 全单次**：`maxRollouts` 六档收敛为 1（max 3→1、ex 4→1、pangu 5→1），`parallelRollouts` 显示口径同步 1；chaser 移除显式并行
- **#2 critique 摘除**：VerifyCritiqueLoop 不再发起自我批判模型调用（打分器归档后其打分激励已消失）；`LoopStep.critique` 恒 undefined；`decideShouldCritique` 移除；`buildCritiquePrompt`/上下文装配保留为休眠代码；critique 事件不再发射；TierConfig 删除 `critiqueFrequency`
- **#3 任务前仓库扫描+锚点注入摘除**：RepoExplorer.explore / AnchorMemory / ContextManager 从 chaser 移除并归档（`RepoExplorer.archived.ts`/`ContextManager.archived.ts`）——"仓库我知道什么"由记忆注入承担
- **#4 静态分析预跑摘除**：chaser 不再起跑即执行 tsc/eslint（`/review` 命令与 Reviewer 本体保留）
- **#5 任务风格头摘除**：`getPromptHeader`/`getVerificationHint` 删除，`scoringHints` 死配置删除（BenchmarkProfiles 保留 get/verifyFirstBias 供档位判断）；StructuredReasoner/PromptBuilder 档位契约去 Critique 行
- **#6 FailureMemory 轨道摘除**：chaser/loop/engineAdapter 全链不再注入/记录；FailureMemory.ts 保留（UserConfirmation/MemoryCommand 兼容）；失败信号唯一归口 = RefinedMemoryStore.refine 任务落定提炼
- **#7 解析恒走三路**：`useUniversal` 恒真，OpenAI JSON/文本/`<>` XML 容错探测统一；strictStructured 仅影响 XML 探测深度；`StrictStructuredToolAdapter` 独占路径退场（类与测试保留）
- 测试：删除 2 个 critique 装配用例（随机制归档）、改写 UNKNOWN_TOOL 用例（引导保留、不记录）；527 例全绿

## 0.6.1 (打分器摘除归档：记忆主线去性能叙事残留)

- **归档** `TrajectoryScorer` 七因子过程纪律打分器 + Chaser 内联启发式评分（88/35+2N/格式/早过加分）→ `archive/2026-09-05-scoring/`（含恢复说明）
- `score` 语义收敛为验证锚定两值：成功=100 / 未成功=0；下游不变式全部保持：success 闸门（≥80）、记忆 success 卡阈值（≥85）、compact 补漏（正则 score 抽取）行为不变
- 顺带修复：旧failure 分 `max(30, 35+步数×2)` 使 ≥23 步失败轨迹也能过 80 闸门的潜在 bug
- orchestrator 早停（≥92）现于首个成功 rollout 即停（token 节省）；缺分兜底 0（不猜）
- 文档：ARCHITECTURE 执行链路描述、REFACTOR-ASSESSMENT §4 禁区注记同步

## 0.6.0 (全面改名：烛龙 Zhulong / 盤沙拉克 Panshalach)

### 模型接入：tool_calls 透传 + 多模型源（2026-09-04 df7a119）
- `openai-compatible.complete` 返回 `string | {content, raw, toolCalls, detectedFormat:'openai-json'}`；SSE `delta.tool_calls` 按 index 增量拼装（修复 `[DONE]` 早退跳过拼装）；支持 `providers.<name>.headers`
- chaser 流式 wrapper 聚合 toolCalls chunk 后返回结构化对象；`VerifyCritiqueLoop` 的 `preParsedToolCalls` 消费通道零改动
- env 三件套泛化 `PANSHA_<PROV>_API_KEY/_BASE_URL/_MODEL`（`SCNET_API_KEY/SCNET_KEY` 保留为 scnet 历史别名，行为不变）；`getModelContextLength` 跨 provider；裸名路由泛化
- 新增 `providers.<name>.apiKeyCmd`（借鉴 claude-code apiKeyHelper：stdout 首行作密钥，成功缓存，显式 apiKey 优先）
- 删除死代码：`ScnetClient.ts`/`UniversalMaoyulinClient.ts`/`maoyulin-client.cjs`/`probe-scnet-real.mjs`（内含硬编码密钥，git 历史仍在，**需服务侧轮换**）/`probe-maoyulin-models.cjs`；`verify-scnet.mjs` 改配置驱动任意 provider
- 接口契约 v2 类型：`AgentEvent`/`Assertion`/`TaskState`/`SourceRef`（`src/cli/repl/types.ts`）；rolloutStore 增 `agent` 事件 schema

### 记忆与上下文 v3（2026-09-04 bf5f4a7，两轮对抗批判收敛）
- 修复衰减锚：`calculateEffectiveWeight` 取 `max(lastSeen, lastUsedAt)`（旧 `??` 短路使复发卡的 lastSeen 刷新对衰减不可见）
- `markUsed` 二态化：`markInjected`（注入纯记账，不影响衰减/count）/ `markVerified`（原位刷新 lastUsedAt+count+1，直写持久化）；markCited 推迟（[M1] 卡号引用协议已就位）
- `loadFiltered` 过滤 `archived` 卡（merge 软删真正退出注入）
- PromptBuilder：记忆卡注入带 `[M1]` 连续编号（顺序==lastInjectedCardIds，跨 L1/溢出块单一序列）；修复 `getRecentContext` "score=score=NN" 双前缀
- compact：`CompactResult` 增 `generation(turnCount,lastTurnId)`/`coveredTurnIds`/`summarySource`/`syntheticTurn`；apply 按覆盖账本安全合并（修复快照→apply 间新增轮静默丢失）；血统断开（rewind）拒绝 apply；摘要来源显式化
- rolloutStore：新增 `compact`（自足标记，replayInto 消费后 resume 无模型重建压缩态）与 `context`（逐任务注入审计：promptHash/injectedCardIds）事件；`readAgentEvents`/`readContextSnapshots` 有界读取；`listRecent` 单文件扫描上限
- `runAgentTask`：逐任务 ContextSnapshot + `memory_injected` 事件 + markInjected 双账本对齐（best-effort）
- 新增测试：`tests/memory/MemoryMark.test.ts`、`tests/repl/ContextMemoryV3.test.ts`、`tests/repl/ModelProviderEnv.test.ts`（全套 529 例）

### 文档（2026-09-04 6b7cb5e）
- `docs/panshalach/SUBMISSION.md` 国创赛项目书骨架（≤1000 字概述占位 + 大纲 + 创新点按"claim 指向已落地工件"表述）
- `docs/panshalach/EVALUATION.md`：C 档口径对齐（语义检索单列 C4 消融档）；记忆卡利用率口径二选一写死；测试数以 `npm test` 实际值为准
- `tasks/context-memory-proposals-2026-09-04.md`：两方案 + 两轮 3 视角对抗批判 + 终稿裁决 + 已知遗留 + 评测防线留档

### 模型层去模型品牌特化（openPangu 泛化）
- `src/cli/repl/ModelProvider.ts`：删除 bare `glm`/`glm5` magic shorthand、`_pickBestGLMModel` 及 `listModels` 里 `glm` 伪入口；泛化为 `_pickBestProviderModel(providerName)`（取指定 provider 模型列表第一个可用）；`getEffectiveModel` 对 `provider:model` / `provider:` / 裸 provider 名做通用解析
- `src/cli/repl/commands/ModelCommand.ts`：description/usage/提示文案去旧品牌特化（保留 `/model list` 与 scnet 密钥引导，scnet 作为合法 OpenAI 兼容 provider）
- 测试与脚本：`tests/repl/*` 示例模型名改中性（`openPangu-7B` 等）；旧 brand 专属验证脚本删除；`scripts/sandbox-test-runner.ts` 等脚本旧品牌注释清理

### 命名体系（用户指示）
- **外部产品名**（用户/市场看到）：**烛龙**（Zhulong）—— CLI 启动、欢迎语、模型身份串、对外文档标题
- **内部项目代号**（代码/存储/包名/env）：**盤沙拉克**（Panshalach）—— package name、类名、存储目录、`.env` 前缀
- **最高档位**：原 `zorge` 档位 id 改名为 `pangu`（呼应 openPangu），旧值 `zorge` 保留为 alias（TIER_ALIASES 兼容既有会话/配置）

### 全面改名落地
- 类/文件：`src/ZorgeChaser.ts` → `src/PanshalachChaser.ts`；UI 组件 `ZorgeApp.tsx` → `PanshaApp.tsx`；`src/Glm53SweProChaser.ts` 兼容别名 stub（早期模型试点时期的遗留）同步指向 `PanshalachChaser`
- bin：`{ zhulong, panshalach, zorge }` 三个别名指向 `dist/cli.js`；外部默认走 `zhulong`，旧别名保留
- 存储：`.zorge.json`→`.panshalach.json`；`.zorge-memory.json`→`.panshalach-memory.json`；`~/.zorge/`→`~/.panshalach/`（含 sessions/rollouts/file-history/skills）
- env：`ZORGE_*`→`PANSHA_*`（含 `PANSHA_HEADLESS/PANSHA_MODEL/PANSHA_SERVE_TOKEN/PANSHA_CTX_WINDOW/PANSHA_EXEC/PANSHA_SMOKE/PANSHA_SKILLS_USER/PANSHA_USE_LEGACY_PARSER`）
- 题面渲染：welcome `Zhulong Interactive Shell（烛龙）` + 提示符 `Zhulong [tier]` + 身份串"你是烛龙（Zhulong）…" + SSE log `[zhulong]` + MemoryManager 标题

### 文档同步
- 根 README、CHANGELOG、REFACTOR-ASSESSMENT 重写为双名体系
- docs/panshalach/* 六份命题交付文档（README/ARCHITECTURE/MEMORY-DESIGN/EVALUATION/USER-GUIDE/ROADMAP）标题与品牌段对齐"烛龙（Zhulong）· 内部代号 Panshalach"
- 配置示例 `.panshalach.json.example` 命名/路径同步

### 迁移
- 写出 `scripts/migrate-panshalach.mjs`（一次性）：读旧 `.zorge.json`/`.zorge-memory.json`/`~/.zorge/{sessions,rollouts,file-history,skills}` → 写入新 `~/.panshalach/...`（仅当目标不存在，避免覆盖）
- 用户首次升级运行：`node scripts/migrate-panshalach.mjs`

### 说明
- 类名 `PanshalachChaser` / bin `panshalach` / `ZORGE_*`→`PANSHA_*` / `Zorge`→`Panshalach` 全部由批量脚本一次完成（见 scripts/rename-panshalach-bulk.mjs 留档，可作后续一致性核验脚本）
- 兼容别名：`zorge` bin 与 TIER_ALIASES `zorge→pangu` 保留；`Glm53SweProChaser` 兼容 stub 与 `scripts/test-glm-shorthand.mjs` 已删除。
- 命题提交物 1/2 见 docs/panshalach/ARCHITECTURE.md 与 EVALUATION.md。

## 0.5.0 (Panshalach 命题化重构)

### 品牌与命题定位
- 上一阶段：项目对外品牌 Panshalach（package name/bin `panshalach`；保留 `zorge` bin 与内部存储名作为兼容别名）
- 定位改为：基于 openPangu 的记忆增强长程上下文智能体（软件工程长期维护场景），贴华为 openPangu 命题
- 可见层文案更名：欢迎语/提示符/模型身份串（你是 Panshalach…）/SSE server 文案/memory 管理器标题/pangu 档位描述/`/init` 文档指针

### 文档重建
- 新增 [REFACTOR-ASSESSMENT.md](REFACTOR-ASSESSMENT.md)：现有代码逐模块对照 openPangu 命题的重构评估与 P1–P6 改造路径
- 新增 docs/panshalach/ 命题文档集：README / ARCHITECTURE（提交物 1 雏形）/ MEMORY-DESIGN / EVALUATION（提交物 2 骨架，待真实 openPangu 数据）/ USER-GUIDE / ROADMAP
- **物理清理**旧 Panshalach/早期模型试点/30-rounds 文档（docs/ 下全部规划/复盘/归档）与过时流程元数据（docs/agents、.agents）
- `.panshalach.json.example` 改为 openPangu provider 示例

### 说明
- 内部存储名 `.panshalach.json` / `.panshalach-memory.json` / `~/.panshalach/` / `PANSHA_*` / `PanshalachChaser` 本轮保留（会话资产兼容），收敛计划见 docs/panshalach/ROADMAP.md P6
- openPangu 记忆写闭环 / 事件记忆 / 任务状态机 / 语义检索 / 真机评测 为 P1–P7 后续里程碑（见 ROADMAP）

## 0.4.0 (dogfooding 战役)

### 新增
- --headless 逃生口（PANSHA_HEADLESS=1 / pangu --headless：非 TTY 真实执行，SMOKE 仍最高优先）
- maxHunks 参数（diff 工具：ctx 不计 + 全替换豁免）

### 修复
- computeLineDiff contextLines=0 泄漏折叠标记
- looksBinary off-by-one 边界（31 vs 32）
- stringWidth ZWSP/ZWNJ/word-joiner 宽度（1 → 0）

### 测试
- 二进制边界测试（0x1F/0x20、0x08/0x09）+ 回归守卫
- --headless 4 用例；基线 303 → 309

### 工程
- dogfooding 实战检验（T1-T7，8 条短板；报告已随旧文档清理归档，历史见 git）
- 杂项清理（.sandbox-test/、根目录 test-*.mjs、probe-*.cjs 移出追踪；probe 保留于 scripts/ 且密钥剥离）

### 修复（短木板 #9）
- 负向工具清单注入（`<negative_tool_list>`：iron_law_check/thinking/plan/critique 声明非工具）
- UNKNOWN_TOOL 运行时护栏（TOOL_FORMAT_ERROR 记账 + 意图引导 + 连续 3 次硬停）
