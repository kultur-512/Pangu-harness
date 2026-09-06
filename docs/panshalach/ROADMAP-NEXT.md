# Panshalach / 烛龙 Zhulong —— 命题开发路线（2026-09-05 修订版）

> 内部代号 盤沙拉克 Panshalach（包名/类名/存储/env）/ 外部产品 烛龙 Zhulong（CLI/欢迎/身份串/对外文档）。
> 命题：华为《基于 openPangu 的记忆增强智能体架构设计与优化》。场景：软件工程长期维护。
> 当前版本 **v0.7.3**：0.7.0 摘除判官/TestTimeOrchestrator（单层终止 + 单次 loop.run）；0.7.2 意图前移接线（4/4 入口）+ 记忆落定主线版（finalizeTaskMemory）；0.7.3 主链确定性——真实成功信号入册（completed 真机可达）、三入口审批/中断透传、窗口预算挂真值（未知回落 32768）、中断现场落盘（partialText）。打分体系与性能叙事装置已全部摘除（archive/2026-09-05-*），成败唯一由验证信号判定。
> 交付时间盒：`WORK-PLAN-2DAY-UNITS.md`（U1-U9，9/24 交付）。技术审查基线：`docs/agent/handover/feature-zhaiyuanhao-long-context-memory-review.md`。

## 0. 当前执行管线（已定型）

```
用户任务
  ▼ taskIntent 分类（0.7：execution / search / chat / meta）
     chat → 单次 complete 直接回答（stopReason='answered'，不进 agent 循环）
     search → 受限只读循环（≤3 步，强制 readonly，搜不到询问用户）
  ▼ PromptBuilder.buildForTask（唯一记忆注入口）
     [M1] 卡号记忆卡注入（参照文件/关键词/tier 过滤 + 预算）
  ▼ PanshalachChaser.solveIssue（0.7：单次 loop.run，判官/编排器已摘除）
     VerifyCritiqueLoop 步进：三路自适应解析（JSON/文本/XML，#7）
       → 真实工具执行 + 四档审批 → 验证信号（PASS/FAIL，唯一成败来源）
       终止：end_turn 自然停（answered/no-verification）/ PASS+end_turn（completed）
             / maxSteps / 连错上限 / signal abort —— 单层，无判官续跑
  ▼ 任务落定
     finalizeTaskMemory（0.7.2 主线版）：completed 时 refine → save（R1）
       + injectedCardIds ∩ 轨迹写集 → markVerified（R2），发 memory.finalized 事件
     （覆盖 sseInteractive/server/headless；Repl 直调三口待统一执行器收口）
     会话 addTurn + rollout append（turn 含 aborted+partialText / approval/agent/compact/context 事件）
     （需要时）后台预压缩：generation + coveredTurnIds + 安全合并
  ▼ 下一回合 L1 注入读到"上一轮沉淀"
```

**已摘除**（恢复路径见 `archive/2026-09-05-*/`）：过程纪律打分器与 score 字段、critique 自我批判、任务前仓库扫描与锚点注入、静态分析预跑、任务风格提示头、FailureMemory 轨道、多 rollout best-of-N、`<>` 严格解析独占路径、**外置验证判官与 TestTimeOrchestrator（0.7——单层终止 + 单次 loop.run）**。

## 1. 事实源与记忆分层（现状）

| 层 | 载体 | 状态 |
|---|---|---|
| **事件账本** | rollout jsonl：`turn/approval/rewind` + `agent`（契约 v2）+ `compact`（自足标记，replay 消费）+ `context`（逐任务注入审计：promptHash/injectedCardIds） | ✅ 已落（df7a119/bf5f4a7）；`appendAgentEvent`/`readAgentEvents`/`appendContextSnapshot`/`readContextSnapshots`（有界） |
| **事件查询层** | `src/memory/events.ts` MemoryEventStore（kind/topic/session 查询） | R4（W3 王佐），底座已就绪 |
| **TaskState** | `src/memory/taskState.ts` + `/task` CLI | R5（W3 王佐 / W4 赵天昂）；类型契约已定稿 types.ts |
| **Assertion** | types.ts 契约保留；抽取器/冲突检测 | **推迟到 9/24 后**（对抗评审：1B 抽取不可控、无 supersede 机制） |
| **记忆卡投影** | `RefinedMemoryStore`：二态使用语义（markInjected/markVerified）、衰减锚 max(lastSeen,lastUsedAt)、archived 过滤、[M1] 编号契约 | ✅ 已落（bf5f4a7）；markCited 推迟 |
| **注入审计** | ContextSnapshot 按任务落 rollout `context` 事件 | ✅ 已落；ContextCompiler 独立模块**推迟**（PromptBuilder 保持拼接器 + 统一账本） |
| **检索** | refs 硬过滤 + 关键词 + `0.7w+0.3rel` | 现状即交付；n-gram 语义召回只作 C4 消融档（R7） |
| **压缩** | 单次摘要 + generation/coveredTurnIds/安全合并/血统拒绝/来源显式化 | ✅ 已落；多级摘要 L1/L2 = R8（前置 Turn 结构化） |

## 2. 已定稿里程碑（0.6.0 → 0.6.3）

| 版本 | 内容 | commit |
|---|---|---|
| 0.6.0 | 全面改名（烛龙/盤沙拉克）+ 模型层去品牌 + 契约 v2 类型 + tool_calls 透传 + env 三件套 + apiKeyCmd/headers + 死代码清理 + 记忆 v3（二态/衰减锚/compact 账本/事件扩展）+ SUBMISSION 骨架 | 17851f9/df7a119/bf5f4a7/6b7cb5e |
| 0.6.1 | 打分器摘除归档（TrajectoryScorer + Chaser 内联启发式）→ score 两值化 | 09125b4 |
| 0.6.2 | 性能叙事装置摘除（#1-#7：单 rollout、去 critique/静态分析/锚点/风格头/FailureMemory、三路解析恒开） | 8998efe |
| 0.6.3 | score 字段整体移除——成败唯一由验证信号判定；记忆正向信号切到 trajectory.success | 0576ae0 |

## 3. 剩余路线（对齐 U1-U9）

| ID | 交付 | Owner | 验收 | 时间 |
|---|---|---|---|---|
| **R0 双层终止 + 三先决** | ~~终止语义双层化（end_turn 自然停 + 判官有界续跑）~~ **0.7 修订**：判官已摘除（弱模型伪工具调用下续跑×3 不收敛，实测 905s），收缩为**单层终止**（end_turn 自然停 + maxSteps/连错上限）；TurnStopReason 契约（completed/answered/max-steps/consecutive-failures/aborted/no-verification）；count 翻倍修复 + withRetry/空批保护 + streamChat 透传 | Leader | 测试：Termination/taskIntent/retry/count 回归全绿（✅ 0.6.4 落地、0.7 重构）；**判官 + TestTimeOrchestrator 摘除（0.7.0 已落，archive/2026-09-05-removals/，回合上界=单次 maxSteps）** | U1-U2（✅） |
| **R1 回合写闭环**（**最紧要**） | 任务落定统一 hook：`refine({trajectory, taskStyle, attemptCount, userFeedback})` → `save()` → `invalidateProjection()`；接 `Repl.executeTask`/`runAgentTask`/`sseInteractive` 三入口；正向 = 正向反馈 OR `trajectory.success` | 王浩宇 | 连续 3 个同风格任务后 `/memory list` 自动出现教训/成功卡（无需 /remember） | U1-U2（✅ 0.7.2 主线版已落：`finalizeTaskMemory` 单一落定点，completed 时 refine→save；**仅 runAgentTask 路径**（SSE/server/headless），Repl 直调三口待统一执行器） |
| **R2 markVerified 信号源** | 任务落定取"本任务工具写入/验证过的文件集 ∩ 卡.referencedFiles"→ `markVerified(cardIds)`；`runAgentTask` 已持 lastBuildMeta.injectedCardIds | 王浩宇 | 卡被真实复用后 lastUsedAt/count 刷新（单测） | U2（✅ 0.7.2 主线版已落：`injectedCardIds ∩ 轨迹写集` → markVerified，随 finalizeTaskMemory） |
| **R3 Turn 结构化最小集** | `Turn.result` 增 `goal/changedFiles/verifyCmd`（summary 保留兼容）——多级摘要 envelope 的前置 | 王浩宇 | 落盘字段存在 + 旧格式兼容读 | U2（分支已落：`origin/wanghaoyu1` c139528 Turn.result 结构化 + outcome，**已 rebase 至 0.7.3 主线，待评审合入**） |
| **R4 MemoryEventStore** | `src/memory/events.ts`：在 rolloutStore 之上做 kind/topic/session 查询（有界）；任务落定/审批/验证/用户声明等**显式写入点**产事件（禁止 NLP 抽取） | 王佐 | `tests/memory/EventStore.test.ts` 绿 | U1-U3（分支已落：`origin/wangzuo1` 7b946f0 查询层 + 5 项单测；**基座仍 0.6.4，behind 7——待 rebase 至 0.7.3 后评审合入**） |
| **R5 TaskState** | `src/memory/taskState.ts`（显式事件折叠、可重建、originalRequirement 锚定）；持久化；PromptBuilder 注入槽位（env/feature 之后、recent-context 之前，KV-cache 友好）；`/task status\|risks\|next\|decide`（赵天昂） | 王佐+赵天昂 | `tests/repl/TaskState.test.ts` 绿；注入块【任务状态】可见 | U2-U4（持久化层分支已落：`origin/wangzuo1` c7a1eca 版本乐观锁 + originalRequirement 锚定 + 事件重建；**同待 rebase**；注入槽位与 /task CLI 未落） |
| **R6 评测基建**（**9/24 证据链唯一来源**） | `scripts/eval/{run-eval,smoke-eval,fill-evaluation}.mjs` + `tasks/T1-T5` + results schema；A/B/C(+C4) 消融；A 档窗口必须真溢出；A/B prompt-diff 展品脚本；T4 评分 rubric | 王浩宇+赵天昂 | U4 末 mock smoke 一键跑通 exit 0；U6 真实 openPangu 出 `results/<date>.json` | U4-U6（**已合入 develop 并推进**：`origin/zhaotianang1` 6d09528 merge develop 后实体化 T1-T3 fixture（issue+verify.sh）+ embed/cosine 单测；`origin/wanghaoyu1` 70a5c7c/c8bdec1 eval runner 完整骨架（schema+spawn+消融控制）+ PANSHA_NO_MEMORY 注入开关——**两人同动 eval 域，合并日需 Leader 仲裁分工边界**） |
| **R7 语义检索 C4** | `src/memory/embed.ts` n-gram 稀疏向量 v0；只跑 7B × T2/T3，正负结果都进 EVALUATION.md | 赵天昂 | C4 vs C 增量数据（或如实写"词面检索已饱和"） | U5-U6 |
| **R8 多级摘要 L1/L2** | 前置 R3：L1 中期结构化摘要（envelope：goal/decisions/files/verification/blockers/next）+ L2 长期粗粒度；generation/coveredTurnIds 沿用 v3 账本 | 赵天昂 | `tests/repl/MultiLevelCompact.test.ts` 绿；envelope 触发率进评测过程指标 | U4-U5 |
| **R9 提交物定稿** | SUBMISSION.md 终稿 + EVALUATION §4 真实数据回填 + DEPLOY-CN.md + ARCHITECTURE §5 资源实测表 | Leader+全员 | U8-U9 清单 | U8-U9 |

**评测防线**（先于结果指标，见 `tasks/context-memory-proposals-2026-09-04.md` 终稿章节）：B 档 memoryCardCount>0 会话占比（防 B≡A）、A/B prompt-diff 展品、T1×7B×A/B/C 最小 9 runs、envelope 触发率。

### 3.1 已采纳的实施合同（源自本地方案书草案 2026-09-05；原稿不入 git，特化记忆机制仍按本路线自研）

以下条款升级为对应 R 项的**验收合同**，实现时不可省略：

- **R1 合同**：落定必须是**单一 finalizeTask 服务**（三入口共享，禁止各自复制判断）；五种路径都有明确结果——成功 / 真实验证失败 / 用户取消 / 异常退出 / 预算耗尽；`save` 结果与任务结果**分开记录**（写盘失败不改判任务成败）；保存后必须 `invalidateProjection`；重复落定（SSE 回调 + CLI 收尾 + 进程恢复同时观察）不得双写 count（9/24 前以事件层去重顶位，持久化幂等键后置）。
- **R2 合同**：`provenFiles = changedFiles ∩ filesCoveredByPassingVerification`；仅 `injectedCardIds ∩ provenFiles 的卡 refs 交集非空` 才 `markVerified`；**无 refs 的通用卡不得默认标 verified**（否则注入越多越保鲜）。
- **R5 合同**：任务状态机含 **UNKNOWN 态**（验证器崩溃或证据未落盘时显式显示未知，不猜）；`originalRequirement` 不可漂移；并发更新走 version 检查。
- **R6 合同**：结果记录必含 `runId / source(real-openpangu|mock-smoke) / seedSupport / verdict / verification{signal,exitCode,commands} / memory{injectedCardIds,verifiedCardIds} / prompt{chars,estimatedTokens,hash} / failureTaxonomy / artifacts`；**A 档必须真溢出**（不溢出的样本标"不适用"，不进长程结论）；**B 档零注入 = 防线失败**，不计为有效样本；失败分类枚举运行前冻结，primary/secondary 分开；统计用配对差 + Wilson 区间，任务实例为统计单位；mock 永不入真实结果表。
- **评审闸门（全 R 项）**：每次合入四问——①有真实生产调用点吗；②新状态可由旧事件/旧文件重建吗；③改了 A/B 非目标变量吗（prompt diff 可发现吗）；④有外部验证退出码吗。答不出①标 planned、②标 missing、③不能进因果比较、④不能声称成功。
- **口径纪律**：`promptChars` 永不改写为 token；`memoryCardCount` 是存在性标志，评测只认 `injectedCardIds`；缺失填"—"不填零。

### 3.2 方案书草案新发现的缺陷（已核实，纳入遗留/任务）

| 缺陷 | 位置 | 处置 |
|---|---|---|
| ~~`MAX_FILE_SIZE_BYTES`(200KiB) 声明但从未执行~~ | `RefinedMemoryCard.ts:91` | ✅ **0.7.1 销项**（C1：`save()` 执行上限，超限测试 `tests/memory/MemoryFileSizeCap.test.ts`） |
| ~~Reviewer 把"探测到测试脚本"写成 `passed:true`（4 处，未执行）~~ | `Reviewer.ts:122-170` | ✅ **0.7.1 销项**（C6：探测/执行两态，消假 `passed:true`，`tests/review/DetectedVsExecuted.test.ts`） |
| ~~`AbortSignal` 只在 onStep 转发前检查，未传入 `solveIssue`（请求取消≠底层停止）~~ | `runAgentTask.ts:135` | ✅ **0.7.0 销项**：AbortSignal 贯穿 solveIssue→loop→modelClient→engineAdapter/executor（FIX-0.7-TERMINATION §6）；残余边界见下两行 |
| ~~compact 先改内存后写 marker，marker 写失败产生双源分歧~~ | `compactService.ts` 落定顺序 | ✅ **0.7.1 销项**（C2：marker 先落盘成功再切内存，`tests/repl/compactService.test.ts`） |
| ~~`FeatureTracker.markFeatureDone` 不检查 save 返回值（写失败仍显示成功）~~ | `FeatureTracker.ts:88` | ✅ **0.7.1 销项**（C3：写失败告警） |
| ~~glob `walkFiles` 跟随目录符号链接可逃逸 pathGuard（只查基准目录）~~ | `glob.ts:30-52` | ✅ **0.7.1 销项**（C4：symlink/junction 一律跳过，防循环 + 防逃逸） |
| ~~rollout `appendEvent` 吞异常，"零事件"无法区分"没注入/写失败"~~ | `rolloutStore.ts:59-66` | ✅ **0.7.1 销项**（C5：成功落盘事件携带 `auditStatus: 'write-failed:N'`） |
| **0.7 引入**：fetch 发出后 abort 只中断读取/连接，网关侧生成可能仍在后台算完（无 stream 关闭语义时） | `openai-compatible.ts` | 0.7 已知边界（如实声明，CHANGELOG 0.7.0 Risks）；0.7.1 评估网关侧取消语义 |
| ~~**0.7 引入**：bash 子进程仅 executor 层 abort（返回 `✗ aborted`），子进程本身可能仍在后台跑~~ | `bash.ts` | ✅ **0.7.1 销项**（C7/C8：abort 监听 + tree-kill——Windows `taskkill /T /F`，POSIX `kill(-pid)`，超时与 abort 共用单一实现） |
| ~~**0.7 引入**：`PromptBuilder.buildForTask` 未按 intent 分支注入（chat/search 指令暂在 chaser 内组装，四入口 prompt 组装未统一收敛）~~ | `PromptBuilder.ts` | ✅ **0.7.1+0.7.2 销项**（F7 intent 参数化——不传 intent 逐字节等价；0.7.2 意图前移 4/4 入口接线，chat/search 运行时首次真正可达） |
| ~~**0.7.2 遗留四项**：意图接线（chat/search 运行时不可达）/ 记忆落定主线版（refine/markVerified 生产调用点为零）/ 审批透传（one-shot/classic 引擎收不到 approvalMode，`--approval full` 形同虚设）/ 窗口预算最小版（compact 阈值与真实窗口零耦合，8K 模型必爆）~~ | `runAgentTask.ts` / `Repl.ts` / `VerifyCritiqueLoop.ts` / `ModelProvider.ts` | ✅ **0.7.2+0.7.3 销项**：意图前移 4/4 入口（0.7.2）；`finalizeTaskMemory` 主线版（0.7.2）；三入口 approvalMode/sessionAllowlist/approvalBridge/signal 透传（0.7.3 T1#2）；窗口预算挂 provider 真值 + loop 超 70% 窗口裁中段 + 未知回落 32768（0.7.3 T2#6） |
| **0.7 待实测（仍开放）**：真机手测未做——`1` / `你好，回答我你是谁` / 运行中 Ctrl+C / `hello.txt` 四路径；0.7.3 增补：`--headless --approval full run "写文件并验证"` 的 completed 真实形状复验 | REPL/headless | 待实测（负责人：翟苑皓 F6，需真实端点，**禁止预填 PASS**；代码侧行为已由 0.7.3 集成测试以真实引擎输出形状锁定） |
| **0.7.2 遗留**：Repl 直调 PanshalachChaser 三口未接 finalizeTaskMemory（记忆落定仅覆盖 runAgentTask 路径） | `Repl.ts` | 待统一执行器收口（与 R1"单一 finalizeTask 服务"同一纪律） |
| **0.7.3 登记不进本轮（L 级）**：消息数组协议重构（complete/streamChat 仅 prompt 字符串单入口，无 messages 数组通道） | `openai-compatible.ts` / `VerifyCritiqueLoop.ts` | L 级跨文件手术，与"明天跑通一天"无直接因果；按需立项（USABLE-PLAN-0.7.3 §一） |
| **0.7.3 登记（L 级）**：sseInteractive 巨函数拆分（现 2147 行，单函数占比过高、巨函数体覆盖薄弱） | `sseInteractive.ts` | L 级；拆分须测试先行 |
| **0.7.3 登记（L 级）**：subagent 委派 / hooks 总线 / 后台 bash | — | L 级，明确不进本轮（USABLE-PLAN-0.7.3 §一） |
| **0.7.3 引入边界**：MCP 工具结果无验证尾标（`describeResult` 尾标只覆盖内置 bash/write_file/edit_file/read_file/glob/grep；MCP 调用成功不计 PASS） | `engineAdapter.ts` | 遗留：MCP 结果验证分类策略待定（宁缺毋滥，防 MCP 自述伪装真实验证） |
| 未采纳（记录在案）：事件 hash-chain、持久化幂等键、auditStatus 完整机制、SummaryNode 全量血缘、`compaction.mode` 四段开关 | — | 9/24 后按需立项 |
| **0.7.4 登记（低优先，不进本轮）**：6 工具 schema ≈2K token/请求（8K 窗口占 25%），对不支持 native FC 的模型（diffusion/1B 实测）纯开销且有行为牵引 | `engineAdapter.ts:249-319`（BUILTIN_TOOL_SCHEMAS 单点）/ `VerifyCritiqueLoop.ts:313-321`（注入点） | 若做（9/24 评测后按消融需求立项）：①toolSchemas 按 intent 过滤（search 只读三件，chat 已零工具）②`PANSHA_TOOLS_MODE=text\|native\|off` 开关（off=请求体不带 tools，兼评测消融维度）③schema description 一行化。见 PLAN-0.7.4 §5 |

## 4. 已裁决不做 / 推迟（恢复指针）

| 项 | 裁决 | 恢复 |
|---|---|---|
| 过程纪律打分器 + score 字段 | 摘除（成败唯一由验证信号） | `archive/2026-09-05-scoring/` + git 09125b4 |
| critique 自我批判 | 摘除（打分激励消失后只剩 token 成本） | `archive/2026-09-05-removals/` |
| 仓库扫描/锚点注入、静态分析预跑、风格头、FailureMemory 轨道、多 rollout 并行 | 摘除 | 同上 |
| **外置验证判官（continuationJudge）+ TestTimeOrchestrator（多 rollout early-stop 预算裁剪）** | 摘除（**0.7.0**——判官为唯一外层续跑源，弱模型伪工具调用下续跑×3 不收敛实测 905s；orchestrator 在恒单 rollout 后 count/sort/预算裁剪全为死路径；回合上界压回单次 maxSteps） | `archive/2026-09-05-removals/` + git 106dae6 |
| markCited（模型引用检测） | 推迟：[M1] 通道已就位，7B 引用实验 9/24 后 | 归档 README |
| Assertion 抽取器 / 冲突检测 / 四类 MemoryProjection / ContextCompiler 独立模块 / token 估算器跨文件统一 | 推迟 9/24 后（契约保留在 types.ts） | 审查报告 §6 |
| MemoryCard provenance/sourceEventIds/evidence/status 字段 | **不做**（悬空伪 provenance；provenance 由 context 事件承担） | 审查报告 A 表 |
| rewind 事件 replay 消费、双 synthetic 幂等、listBranches O(N²) | 已知遗留，随评测工程处理 | 方案文件终稿章节 |
| P6 存储名迁移目标（PANSHA_*→PANG_*） | **待 Leader 裁决**：与已落地 PANSHA_<PROV>_* 命名方向冲突 | ROADMAP.md:43 |
| ~~AbortSignal 透传~~ | ✅ 0.7.0 AbortSignal 贯穿已落地（runAgentTask→solveIssue→loop→modelClient→executor，不再"UI 返回但底层照跑"） | ROADMAP-NEXT §3.2 |
| ~~count 翻倍~~ / ~~无重试+空批 undefined~~ / ~~生产恒非流式~~ | ✅ 已随 R0 落地（0.6.4） | §3.1 合同 |
| ~~方案书草案其余缺陷（文件大小约束/Reviewer 证据语义/marker 顺序/FeatureTracker 返回值/glob 符号链接/auditStatus）~~ | ✅ 0.7.1 C1-C6 已销（C7/C8 bash tree-kill 同批） | ROADMAP-NEXT §3.2 |

## 5. 完成条件（9/24）

- `npx tsc --noEmit` EXIT=0；`npm test` 全绿（以实际输出为准）；`verify-panshalach-cleanup.mjs` PASS；
- `scripts/eval/run-eval.mjs` 真实 openPangu 跑出 A/B/C(+C4) 结果 → `EVALUATION.md` §4 回填（mock 不入表）；
- R1-R5 落地（记忆闭环 + 事件/状态运行时）；R6 证据链成立；
- SUBMISSION/DEPLOY-CN/ARCHITECTURE 定稿，无任何指向未落地代码的 claim。

## 6. 真实 openPangu 运行步骤

```bash
# 0) 端点就绪（昇腾 MindIE / vLLM-ascend / 本机 vLLM）— OpenAI 兼容 /v1，
#    POST /chat/completions 支持 OpenAI 原生 tool_calls（也容错文本协议）
# 1) 配置（env 三件套或 .panshalach.json providers.openpangu + apiKeyCmd）
export PANSHA_OPENPANGU_API_KEY=EMPTY
export PANSHA_OPENPANGU_BASE_URL=http://127.0.0.1:8000/v1
export PANSHA_MODEL=openpangu:openPangu-7B
# 2) 验证
panshalach run "ping"
# 3) 真实评测（R6 就绪后）
node scripts/eval/run-eval.mjs --openpangu http://127.0.0.1:8000/v1 --tasks T1,T2,T3,T4,T5 --modes A,B,C
# 4) 回填 + 定稿
node scripts/eval/fill-evaluation.mjs
```

## 7. 关键文件路径

| 模块 | 路径 |
|---|---|
| 入口/主类 | `src/PanshalachChaser.ts`, `src/cli.ts`, `src/cli/repl.ts` |
| 模型接入 | `src/model/openai-compatible.ts`, `src/model/ProviderRegistry.ts`, `src/cli/repl/ModelProvider.ts` |
| 执行循环 | `src/loop/VerifyCritiqueLoop.ts`, `src/adapter/*`, `src/reasoning/StructuredReasoner.ts` |
| 提示注入 | `src/cli/repl/PromptBuilder.ts`, `src/cli/repl/commands/{Memory,Model}Command.ts` |
| 记忆 | `src/memory/{RefinedMemoryStore,RefinedMemoryCard}.ts`；规划：`src/memory/{events,taskState}.ts`（W3）、`src/memory/embed.ts`（R7） |
| 压缩/会话 | `src/cli/repl/{compactService,compactStrategies,Session,SessionStore,rolloutStore}.ts` |
| 工具引擎 | `src/tools/*`（含审批/RBW）；`src/review/Reviewer.ts`（/review 命令，已脱离任务路径） |
| 评测 | `scripts/eval/`（R6 新建）、`scripts/verify-*.mjs` |
| 归档 | `archive/2026-09-05-scoring/`、`archive/2026-09-05-removals/`（含恢复说明） |
| 文档 | `docs/panshalach/{README,ARCHITECTURE,MEMORY-DESIGN,EVALUATION,USER-GUIDE,ROADMAP,ROADMAP-NEXT,SUBMISSION}.md` |
