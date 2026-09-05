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
