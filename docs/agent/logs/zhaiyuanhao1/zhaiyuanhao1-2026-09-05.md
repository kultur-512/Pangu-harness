# zhaiyuanhao1 工作日志 — 2026-09-05

agent: zhaiyuanhao / claude-code
date:  2026-09-05
last_updated: $(date +%H:%M)

## 想做什么（目的）
- 按产品主指示摘除打分器并归档（记忆主线 harness 去性能叙事残留）；随后探测其他低价值功能供去留决策。

## 打算怎么改（动作）
- 归档 TrajectoryScorer（七因子）+ Chaser 内联启发式评分 → archive/2026-09-05-scoring/（含恢复说明）
- score 语义收敛：成功=100/未成功=0；下游不变式（80 闸门/85 阈值/compact 正则）保持

## 实际干了什么（事实）
- TrajectoryScorer 生产路径本已死代码（Chaser 总是先算分）→ 归档零行为风险
- 顺带修复潜在 bug：旧 failure 分 35+2N 使 ≥23 步失败轨迹可过 80 闸门
- orchestrator 早停（≥92）现首个成功 rollout 即停（token 节省）；缺分兜底 0
- REFACTOR-ASSESSMENT §4 禁区注记（solveIssue 形状不变、score 语义变更申报）
- CHANGELOG 0.6.1 + package.json bump；ARCHITECTURE 链路描述同步
- npx tsc EXIT=0；npm test 529 例（528 pass + 1 skip + 0 fail）；cleanup PASS

## 卡点 / 需要别人决定（接口争议）
- 无接口争议。打分相关下游（compact 补漏卡零信息量、critique/多 rollout token 成本）已列入探测报告待产品主裁决

## TODO（明天 / 下一轮）
- [ ] 等产品主对探测报告逐项裁决去留

## 午后批次（性能叙事装置摘除 #1-#7，产品主逐项裁决）

### 想做什么（目的）
- 打分器归档后按探测报告裁决执行：#1 全单次、#2 critique 摘除、#3 仓库扫描/锚点摘除、#4 静态分析预跑摘除、#5 风格头/scoringHints 摘除、#6 FailureMemory 轨道摘除、#7 解析恒走三路。

### 实际干了什么（事实）
- TierConfig：maxRollouts/parallelRollouts 六档收敛 1；critiqueFrequency 字段删除
- VerifyCritiqueLoop：critique 运行期生成/decideShouldCritique/critique 事件移除（buildCritiquePrompt 休眠保留）；useUniversal 恒真三路解析；FailureMemory 注入/记录全摘；benchHeader/verificationHint 摘除
- PanshalachChaser：Phase 探索/锚点/锚点注入/静态分析预跑/styleHeader 全摘；basePrompt 只留任务；adapter/profile 死引用清理
- engineAdapter：failureMemory 选项与 UNKNOWN_TOOL 记录移除（引导文案保留）
- 删除 src/context/RepoExplorer.ts + ContextManager.ts → archive/2026-09-05-removals/（含 README 恢复说明）
- 测试：CritiqueContext 2 用例随机制归档；executor UNKNOWN_TOOL 用例改写（引导在、不记录）
- 文档：ARCHITECTURE 链路图、CHANGELOG 0.6.2、package.json 0.6.2、测试数口径改动态
- 门槛：tsc EXIT=0；npm test 527 例（526 pass + 1 skip + 0 fail）；cleanup PASS

### 卡点 / 需要别人决定（接口争议）
- 无。单任务 token 成本约为原 max/ex/pangu 档 1/3~1/5；恢复路径全留档

### TODO（明天 / 下一轮）
- [ ] refine 生产调用点接线（王浩宇）——FailureMemory 轨道摘除后这是失败信号唯一归口，优先级升高

## 晚间批次（score 整体移除）

### 想做什么（目的）
- 产品主追加裁决：score 打分彻底去掉，成败唯一由验证信号判定。

### 实际干了什么（事实）
- Trajectory.score → success?；orchestrator 排序/早停/预算裁剪按 success；setScore→setSuccess
- solveIssue/RunResult/result 事件/SSE done/CLI+SSE 显示/demo html 全去 score
- Turn.summary 改"已通过验证/未通过验证"
- 记忆：refine 正向 = 正向反馈 OR trajectory.success；POSITIVE_SCORE_THRESHOLD 删除
- compact 补漏：信号源 result.success；success 卡 evidence=任务摘要（顺带修复零信息量卡+hash 撞卡）
- 文档：CHANGELOG 0.6.3、版本 0.6.3、ARCHITECTURE/MEMORY-DESIGN 对齐、scoring 归档 README 追记、REFACTOR-ASSESSMENT §4 二次申报
- 门槛：tsc EXIT=0；npm test 525 例（524 pass + 1 skip + 0 fail）；cleanup PASS

### 卡点 / 需要别人决定（接口争议）
- 无。评测证据链完全脱离内部 score，只依赖任务级脚本断言（T1-T5）

## 夜间批次（路线图对齐最新现实）

### 想做什么（目的）
- 打分/score/性能装置摘除后，两份路线图仍停留在旧 P0-P5 叙事——按 0.6.3 现实重写，避免 W2/W3/W4 按过时条目开工。

### 实际干了什么（事实）
- ROADMAP-NEXT.md 整体重写：当前执行管线定型图（含已摘除清单）、事实源分层现状表（已落/规划逐行）、0.6.0-0.6.3 里程碑表（带 commit）、剩余路线 R1-R9（owner/验收/时间对齐 U1-U9）、已裁决不做/推迟清单（含恢复指针）、完成条件、运行步骤、关键文件路径（删虚构路径）
- ROADMAP.md：P3 标注细化指向、P4 口径收窄（三路恒开/critique 摘除打勾）、P6 迁移目标冲突标注"待 Leader 裁决冻结"、P7 对齐 R6 提前 U4、依赖顺序更新
- 门槛：tsc EXIT=0；cleanup PASS（纯文档）

### 卡点 / 需要别人决定（接口争议）
- P6 存储名迁移目标（PANSHA_*→PANG_*）仍待 kultur/Leader 裁决，两份路线图均已标注冻结

## 深夜批次（全部 md 口径对齐）

### 实际干了什么（事实）
- 对齐 8 个文件：ARCHITECTURE（执行循环层图/信号源 A/资源表去 critique 与多 rollout）、MEMORY-DESIGN（L0 层与写入源表 FailureMemory 已摘除）、docs/panshalach/README（目录树删 context/*、loop 描述、单 rollout）、SUBMISSION（架构分层描述）、REFACTOR-ASSESSMENT（FailureMemory/RepoExplorer/ContextManager 行改已摘除归档）、WORK-PLAN（U2/U3 矩阵对齐 R 编号、主力行、U9/U5 测试数动态口径）、zhaotianang 卡（任务线改 R5/R6/R7/R8，标注 Assertion/MemoryProjection 推迟与 ContextSnapshot 已提前落地）、wanghaoyu 卡（U3 ContextCompiler 推迟转 R6）
- 历史文档（logs/、handover 调查报告）按"只追加不改"原则保留原文
- 门槛：tsc EXIT=0；cleanup PASS（纯文档）

## 深夜批次 2（任务分发核对与修正）

### 实际干了什么（事实）
- 四张注册卡 × WORK-PLAN × ROADMAP-NEXT 交叉核对，发现并修正 9 处不一致：
  zhaiyuanhao 卡（任务线过时/P1 项移入已完成/补迭代3 与 P6 裁决项）；wanghaoyu 卡（U2 五维评分标推迟/协调对象更新）；wangzuo 卡（schema 已落改查询层/EventExtractor 改显式写入点/注入槽位 KV-cache 口径/U6 去 Projection）；zhaotianang 卡（U1 CLI 依赖倒挂→R6 骨架先行，CLI 移 U2-U3）
- WORK-PLAN：U1 王佐/赵天昂 cell、U2 王佐、U4 档位 A/B/C+C4、U6 行、U4 里程碑行、§2 事实源图与 bullets 全部对齐；修正 task_state.json 路径笔误
- 门槛：tsc EXIT=0；npm test 全绿（524 pass + 1 skip）；cleanup PASS

### 卡点 / 需要别人决定（接口争议）
- 无。分发现在与 ROADMAP-NEXT §3 R1-R9 一一对应

## 夜间批次 3（方案书草案处置：部分采纳 + git 不追踪）

### 想做什么（目的）
- 产品主裁决：继续打造特化记忆机制 agent；solution 十份草案只采纳部分思路；文档本身不入 git。

### 实际干了什么（事实）
- .gitignore 增 `docs/panshalach/solution/`（本地保留研读稿，git 不追踪，已验证忽略生效）
- ROADMAP-NEXT 新增 §3.1 采纳合同（R1 单一 finalizeTask/五路径/save 分离记录/幂等去重；R2 provenFiles 公式与无 refs 卡限制；R5 UNKNOWN 态；R6 结果 schema/A 档真溢出/B 零注入=防线失败/Wilson 区间；评审四问；promptChars 口径纪律）+ §3.2 七项新缺陷表（三项并入任务，五项遗留）
- wanghaoyu 卡：R1 批次并入 AbortSignal 透传；WORK-PLAN 硬约束增"验收四问"
- 未采纳（记录在案）：hash-chain、持久化幂等键、auditStatus 完整机制、SummaryNode 全量血缘、四段功能开关——9/24 后按需立项

### 卡点 / 需要别人决定（接口争议）
- 无。git 追踪核验：solution 目录已忽略；tsc/cleanup 不受影响（纯文档+gitignore）

## 深夜批次 4（R0：双层终止 + 三先决，产品主批准落地）

### 实际干了什么（事实）
- §1 契约：types.ts 增 TurnStopReason（completed/verification-failed-continue/max-steps/consecutive-failures/aborted/no-verification）；Trajectory 增 stopReason/continueCount/lastError
- 改动包 A：createOrUpdateCard/addRemember 改脱离缓存克隆（count 预解析），createPositiveCard 同 id 预解析，mergeAndCap 同 id 整卡替换——count 翻倍修复（count==2 断言）
- 改动包 B：openai-compatible withRetry（429/5xx/网络，Retry-After 头优先，±25% jitter，EMPTY_RESPONSE 可重试耗尽返回空）；orchestrator 空批合成失败轨迹 + lastError；chaser 透出 message
- 改动包 C：ProviderRegistry.createClientSync 透传 streamChat（生产不再恒非流式）
- 改动包 D：loop end_turn 自然停（闲聊 1 步即停）、PASS 降级 evidence、连错/步数保留 stopReason；新增 continuationJudge.ts（CC Stop-Hook 等价，有界 ≤2 续跑）；chaser 接判官
- 新增测试：ContinuationJudge 4 例、TwoLayerTermination 4 例、retry 4 例、EmptyBatch 2 例、streamChat 透传 1 例、count 翻倍 3 例

### 卡点 / 需要别人决定（接口争议）
- 无。王浩宇卡已声明 R0 前置（勿再做同 id 累加）

### TODO（明天 / 下一轮）
- [ ] R6 schema 按 TurnStopReason/verdict 契约编写（赵天昂）

## 深夜批次 5（R0 活体验证 + registry 400 修复）

### 实际干了什么（事实）
- 活体验证双层终止：nihao 任务 3s 结束（旧实现烧 20 步 40s）
- 发现并修复 registry 400：createClientSync 兜底模型名取 config.model 原样发送 "openpangu:xxx" 路由串 → 网关 400（LM Studio 实测）；剥离 provider 前缀修复
- 发现并修复 reasoning_content 兜底缺失：openPangu-Embedded 偶发 200 空 content（输出全在 reasoning_content）→ 非流式路径采用之
- CHANGELOG 0.6.4 补记；version 0.6.4
- 门槛：tsc EXIT=0；npm test 542 例（541 pass + 1 skip + 0 fail）；cleanup PASS

### 卡点 / 需要别人决定（接口争议）
- 无

## 深夜批次 6（0.7 终止语义重构：判官摘除 + 意图分类 + AbortSignal 贯穿）

### 实际干了什么（事实）
- 产品主实测复现：输入 "1"/"你好，回答我你是谁" 被重复执行十几次（905s 不收敛）；Ctrl+C 停不下来（网关持续 POST）；纯问答显示"未通过验证"且答复被吞
- 根因核实：判官是唯一外层续跑源（maxRollouts 恒 1），伪工具调用下最坏 20 步×3 轮；signal 到 runAgentTask 边界断裂；格式教学对问答也要求"每步必须输出工具块"
- 判官摘除归档（continuationJudge.archived.ts）+ TestTimeOrchestrator 移除（Trajectory 迁 src/loop/trajectory.ts，空批保护并入 chaser）；TurnStopReason 移除 verification-failed-continue，新增 answered
- 记忆信号收紧：refine/compact success 卡信号 = stopReason==='completed'（answered 不喂卡）
- 新增 src/cli/taskIntent.ts（execution/search/chat/meta + PANSHA_INTENT_GATE 逃生门）；chaser 按意图分支（chat 单次 complete；search 受限只读循环 ≤3 步强制 readonly）
- AbortSignal 贯穿：solveIssue→loop→complete(opts.signal)→openai-compatible（fetch 外部 signal 合并 + streamChat 读循环 abort 抛 TASK_ABORTED）→engineAdapter/executor；UI abort 后等待底层 settle
- 预算累计修复：estimatedUsedTokens 按模型调用累加（此前恒 0）
- 文档：docs/panshalach/FIX-0.7-TERMINATION.md（方案）；CHANGELOG 0.7.0；ROADMAP-NEXT §0/R0 行同步；archive README 追加归档说明

### 卡点 / 需要别人决定（接口争议）
- 无。王浩宇 R1 接线注意：refine 正向信号已改 stopReason==='completed'（非 trajectory.success）

### TODO（明天 / 下一轮）
- [ ] 用户侧实测：REPL 输入 "1"/"你好" 单次出正文；Ctrl+C 网关停 POST；hello.txt 先搜索搜不到询问
- [ ] bash 子进程强杀（abort 时 taskkill /T）待 0.7.1
