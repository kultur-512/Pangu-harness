# 基本可用实施方案（0.7.3 · 2026-09-06）

> **执行状态：已执行**（0.7.3，工作区未单列提交）——T1（#1-#3）/T2（#4-#10）/T3（#11-#13）共 13 项全部落地，评审修订 5 条全部吸纳；L 级六项按方案明确不进本轮并登记 ROADMAP-NEXT §3.2。验收：`npx tsc --noEmit` EXIT=0，全量 **663 例（662 pass + 1 skip + 0 fail）**；真机四用例待端点（DoD#9，禁止预填 PASS）。分项落地记录见 CHANGELOG「0.7.3」段。

> 输入：5 份子智能体审查报告（CC / dsh / hermes / oh-my-pi / 红队对抗自审）。
> 红队用可复现探针实测出**两个被 629 例绿灯密封的 P0**：真实工具成功被误判为失败（A1）、completed 真机不可达导致记忆闭环死码（A2）；外加文档主验证命令的审批断链（A3）与 classic 假中止（A4）。
> 本方案回答一个问题：**砍掉什么、修什么，才能让评委/新用户明天拿真实模型跑通一天。**

## 一、五报告收敛结论（为什么是这几件事）

三份外部报告（dsh/hermes/CC）与红队在一个判断上完全一致：烛龙的功能面不缺（记忆/意图/审批/compact 骨架都在），缺的是**主链确定性**——

1. **计量单位错了**：字符/4 ÷ 128000 常量，与所连模型的真实窗口零耦合（8K 模型 25 步必爆，红队实测 33K 字符打爆）。
2. **成功信号错了**：验证只认字面 `ALL_TESTS_PASSED`/`VERIFICATION: PASS`——唯一产出方是 smoke mock；真实引擎的 `EXIT_CODE:0`/`WRITE_SUCCESS:` 被判 FAIL，勤奋模型被 consecutive-failures 掐死，只说话的模型反而 `answered` 计成功（红队实测复现，"讽刺反转"）。
3. **中断没有数据语义**：abort 后正文不落盘、工具调用无合成结果、turn 不写 rollout——"现场已保留"文案与现实相反。
4. **审批只在主路径生效**：one-shot/classic/simulate 三个入口不透传 approvalMode/signal——文档第一条验证命令必翻车，classic Ctrl+C 假中止。
5. **防御在解析层不在协议层**：finish_reason=length 截断静默通过 → 残缺 tool_calls → 有正文即 `answered` 假完成。
6. **om-pi 补充的两个低成本正道**：稳定 system 前缀（缓存+角色正确性）、技能渐进披露（token 大头）。

**明确不进本轮（L 级，登记路线不走）**：消息数组协议重构（complete/streamChat 的 messages 入口）、sseInteractive 巨函数拆分、会话树指针化、subagent 委派、hooks 总线、后台 bash。理由：都与"明天跑通一天"无直接因果，且均为跨文件大手术。

## 二、执行项（三梯队，全部 S/S-M）

### T1 梯队：P0 修复（红队实测复现，演示级翻车）

| # | 项 | 落点 | 领地声明 |
|---|---|---|---|
| 1 | **真实成功信号入册**：engineAdapter 对 `ok:true` 且带 `EXIT_CODE:0`/`WRITE_SUCCESS:`/`READ_SUCCESS:`/`EDIT/` 的结果，`describeResult` 统一追加规范尾标 `VERIFICATION: PASS`；classifySignal 同步纳入 `EXIT_CODE:0`（双保险）。效果：真实成功 → PASS → completed 真机可达 → 记忆闭环激活（A1+A2 同修） | `src/tools/engineAdapter.ts` describeResult、`src/loop/VerifyCritiqueLoop.ts` classifySignal | 两文件无主（Leader 裁决权） |
| 2 | **三入口透传补齐**：RunCommand / Repl.executeTask / SimulateCommand 向 solveIssue 透传 `approvalMode: session.approvalMode、sessionAllowlist、approvalBridge、signal`（照 runAgentTask 抄最小四项，不重构） | `src/cli/repl/commands/RunCommand.ts`、`src/cli/repl/Repl.ts`、`src/cli/repl/commands/SimulateCommand.ts` | 王浩宇领地——**最小透传面**（每处 ≤10 行），合并日声明 |
| 3 | **集成测试去 mock 回环**：新增/改造测试用**真实引擎输出形状**（EXIT_CODE:0 / WRITE_SUCCESS 文本协议）驱动 completed 判定与 finalizeTaskMemory 断言；锁定项 1 行为 | `tests/integration/`、`tests/loop/` | 翟苑皓（tests/） |

### T2 梯队：S 级高影响（外部报告一致推荐）

| # | 项 | 落点 | 来源 |
|---|---|---|---|
| 4 | **中断现场落盘**：aborted 时已流出正文写入 rollout（turn 事件带 `partialText`，stopReason=aborted 的 turn 也 appendTurn）；步边界 abort 时为已解析 toolCalls 补 `aborted before dispatch` 合成结果（call/result 成对） | `rolloutStore.ts`、`VerifyCritiqueLoop.ts`、`sseInteractive.ts` | dsh#1/#2 |
| 5 | **answered 空转防呆**：execution 意图下第一步"有正文无工具调用"不立即终局——注入一次格式提醒重试，再无动作才 no-verification（不计 success） | `VerifyCritiqueLoop.ts:413-421` | 红队 A5 + CC 弱模型防御 |
| 6 | **窗口预算挂真值**：compact 阈值与主路径 ctx 表从 `PANSHA_CTX_WINDOW||128000` 改为 provider `getModelContextLength`（已有通道，默认回落 32768 保守值）；loop history 超 70% 窗口时裁中段（保头尾） | `compactService.ts`、`sseInteractive.ts:526/1076`、`VerifyCritiqueLoop.ts` | 红队 A7 + hermes#3 + dsh#3 |
| 7 | **finish_reason=length 防御**：complete/streamChat 捕获 finish_reason，`length` → 结果标 `truncated`；loop 对截断响应禁判 answered，注入"响应被 max_tokens 截断"继续 | `openai-compatible.ts`、`VerifyCritiqueLoop.ts` | CC#10 |
| 8 | **首跑报错质量**：resolveSharedClient 文案改 openpangu/example//model 三提示；REPL 启动预检无可用 provider 打印配置指引 | `ModelProvider.ts`、`sseInteractive.ts` 横幅处 | 红队 A8 |
| 9 | **结果截断改超阈值才剪**：resultLimit 200-300 → 阈值 4000 字符，超限保留头 2500+尾 800+显式 `[...已修剪 N 字符...]` | `VerifyCritiqueLoop.ts` buildHistoryPrompt | dsh#6 + hermes#4 |
| 10 | **withRetry 对齐**：3→5 次；`isRetryableErr` 补传输类错误（fetch failed/TypeError） | `openai-compatible.ts` | dsh#7 |

### T3 梯队：S 级选做（时间允许，按序）

| # | 项 | 落点 | 来源 |
|---|---|---|---|
| 11 | 写集提取修正则（带空格引号/tee/Windows 盘符） | `runAgentTask.ts` extractWrittenFilePaths | 红队 A10 |
| 12 | 'a' 决策持久化到项目配置（会话启动加载回 sessionAllowlist） | `approval.ts`、`ConfigManager.ts` | CC#2 |
| 13 | 文档清漂：DEPLOY §2.4 命令重验重写、§3.1 modelContexts 表述改准、/agents 并行文案删、package.json 版本 0.7.0→0.7.3 | `docs/panshalach/DEPLOY-CN.md`、`sseInteractive.ts`、`package.json` | 红队 A13（翟苑皓领地） |

## 三、领地与协调声明（"涉及最少他人任务"）

- **零触碰**：王佐（events.ts/taskState.ts/TaskCommand）、赵天昂（scripts/eval/embed）、王浩宇的 memory 方法主体。
- **最小触碰（透传级，每处 ≤10 行，合并日声明）**：Repl.ts / RunCommand.ts / SimulateCommand.ts（王浩宇领地）——只补 approval/signal 透传，这正是其 runAgentTask 已有形态的推广，方向一致。
- **本方领地**：tests/、docs/panshalach/、scripts/；**无主文件**（VerifyCritiqueLoop/engineAdapter/openai-compatible/compactService/ModelProvider/rolloutStore）按惯例 Leader 裁决，本方案即裁决记录。

## 四、验收门（Definition of Done，红队 B 清单可测子集）

1. `classifySignal` 对 `WRITE_SUCCESS: ...\nEXIT_CODE:0` 形状返回 PASS（新单测）；completed 在真实形状脚本下可达。
2. `zhulong --headless --approval full run "写文件并验证"` 在 mock 关闭的真实形状集成测试中 completed + 自动产卡（LM Studio 恢复后真机复验）。
3. RunCommand 透传后：one-shot 写文件任务在 `--approval full` 下真实写出（集成测试）。
4. aborted 任务后 rollout 存在带 partialText 的 turn（新单测）。
5. execution 意图首步纯文本 → 第二步收到格式提醒（新单测）。
6. modelContexts=8192 时 compact 阈值≈6553 token 而非 128000（新单测）。
7. finish_reason=length → 响应不判 answered（新单测）。
8. 全量测试绿（基线 629+新增）+ tsc 干净 + 两契约脚本 PASS。
9. LM Studio 端点恢复后执行真机四用例（F6 纪律，禁止预填 PASS）。

## 五、执行切分

- **评审修订（2026-09-06 方案评审 5 条，全部吸纳）**：
  1. T1#1 尾标**确定性追加**：describeResult 按 `res.ok`+工具类别追加——bash→`EXIT_CODE:0` 尾标已有，另追加 `VERIFICATION: PASS`；write/edit→`VERIFICATION: PASS`；read/glob/grep→`VERIFICATION: NEUTRAL`。不做正文字符串扫描。classifySignal 新增 NEUTRAL→PARTIAL 分支（置于 FAIL/ERROR 子句**之前**——PARTIAL 清零连败但不计 PASS、不触发 completed/产卡）；裸 `EXIT_CODE:0` 子句用尾部锚定 `/\nEXIT_CODE:0\s*$/` 且排在 FAIL 检查之后。多调用步一成一败仍判 PASS（可接受粒度，写入测试注释）。
  2. T1#2 bridge/signal 来源写明：CommandContext（types.ts）增可选 `approvalBridge?/signal?`，sseInteractive 注册点注入现成桥；classic/Repl 用 `createCliApprovalBridge` + 新增 AbortController（约 3 行）；SimulateCommand 仅透传声明不实现（dryRun 在 adapter 前返回）。
  3. T2#5 门控改为 `!hasPerformedRealVerification`（非"第一步"）。
  4. T2#6 哨兵治理：ModelCommand /model list 对未知上下文**持久化 null**（不写 256000 哨兵，ModelProvider.ts:522 回落改 32768）；budget 路径把 ≤0/256000 哨兵视为 unknown→32768；`CTX_WINDOW_TOKENS` 去 const 化（按任务边界调 getModelContextLength 重取）+ /model 切换清零 ctxUsedChars。DoD#6 修正：8192×80%≈6553 token 阈值。
  5. 切分改**单子智能体串行**（sseInteractive/VerifyCritiqueLoop 双属批次 X/Y，并行必冲突）；T2#4 落点补 Repl.ts aborted 路径（classic 现场保留）；Turn 类型加 partialText（types.ts）。DoD 增注：记忆闭环本版仅 runAgentTask 路径（SSE/server/headless）生效。
- **执行**：单子智能体按 T1→T2→T3 顺序串行；完成后 debug → review×3 → 命题偏离报告。
