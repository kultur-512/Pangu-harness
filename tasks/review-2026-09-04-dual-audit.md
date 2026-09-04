# 计划书双审查纪要（2026-09-04）

> 触发：用户要求"两个 subagent 审查项目计划书：1) 功能是否完备 2) GLM 严格规范可否放宽，技术细节落在记忆+上下文管理"。
> 状态：审查 #2（功能完备性）因上游 API 503 中途失败，仅部分进展；审查 #1（GLM 规范放宽）已完成并回结论。此文件留档，重启 #2 时可作基准。

## 审查 #1 结论：GLM 严格规范放宽点（已完成，逐文件盘点）

### 保留（安全价值，与模型无关，不放松）
- RBW 护栏（`tools/engineAdapter.ts` 写前检查）— 通用安全
- 四档审批（`tools/approval.ts` readonly/default/full + allowlist）— 安全底线
- smoke gate（`engineAdapter.ts` 非 TTY→mock）— CI/测试安全
- 负向工具清单（`PromptBuilder.ts:228-238` 防幻觉护栏）— 通用
- 档位骨架（`tiers/TierConfig.ts` 六档）— 通用
- `pangu` 档 `userConfirmationRequired:true` + `budgetBehavior:soft_limit_with_warning` — 安全底线

### 可放宽（GLM 时代参数，openPangu 下调）
| 参数 | 当前 default(high) | 建议 |
|---|---|---|
| `ironLawInjectionLevel` | medium | **low**（少注入品牌化铁律，token 让给记忆/上下文） |
| `critiqueFrequency` | {periodicEvery:3, skipFirstN:2} | **{periodicEvery:5, skipFirstN:3}**（降低自我批评频率） |
| `verifyFirstBias` | true | **false**（7B 对先验证不敏感） |
| `maxRollouts` | 2 | **1**（多 rollout 收益低，预算让给记忆检索） |
| `maxStepsPerRollout` | 20 | 保持 20 或 15 |
| 连续失败保护 +2 | highRigor 有 | **去掉 +2** |
| `buildFullIronLawHeader` "写多读少=严重违规立刻停" | fatal | **降为 warning**（记忆叙事下惩罚健康的写多读少） |

### 可去（纯 GLM 品牌/benchmark 刷分，与记忆增强无关）
- `benchmarks/BenchmarkProfiles.ts` terminal-bench-3 / automation-bench profile — 与记忆叙事无关
- `TestTimeOrchestrator.ts` TrajectoryScorer 的 `strict/glm-xml format 加分` + `loose/plain 扣分` — 对 openPangu 不公平（不一定输出 GLM XML）
- `isGlmTarget` → `isStrongTarget`；`strictGlmOnly` → `strictParser`（公共 API 名清掉 GLM）
- GLM 品牌措辞全局 236 处/27 文件：`GLM-5.x`、`锻神`、`强力模式`、`铁律`、`ContextManager.ts:2 "GLM-5.3 1M advantage"`（openPangu 叙事应改"openPangu 长程上下文 + 记忆增强"）

### 放宽后 default(high) 姿势
"低频、轻铁律、单 rollout、先探索后验证" — 工程纪律退居后台，安全底线不动，token 预算优先给记忆卡片复用 + 长程上下文连贯性。

### 记忆增强深化点（审查 agent 补）
长程任务中后段形成的记忆，温度偏低——晚出现的记忆更相关/更可信/更可复用，接近"后设认知/元知识"而非本体知识。核心命题：**记忆作为上下文管家**。

---

## 审查 #2 进展（未完成，上游 503 中断）
- 已在做："Now let me examine the actual implementation state of the key memory modules to verify claims in the plans."
- 未交付：A) 功能完备性核对表 B) 记忆/上下文主线偏差点 C) 可砍项 D) 9/24 最可能失败点
- **待重启**：重启时让它对照 `docs/panshalach/ROADMAP-NEXT.md` + `ARCHITECTURE.md` + `EVALUATION.md` + `MEMORY-DESIGN.md` + `WORK-PLAN-2DAY-UNITS.md` + `WORK-PLAN-MAIN-LEARN.md` + `REFACTOR-ASSESSMENT.md`，核 7 项技术路径（记忆增强/长文本优化/上下文压缩/结构化记忆/向量检索/事件日志/任务状态）哪些真做哪些空提、A/B/C 三档能否出对比数据、9 单位派工功能黑洞。

## 待落库的修订动作（等 #2 补全后执行）
1. 把 GLM 严格规范放宽（见上表）落到代码：`tiers/TierConfig.ts` default(high) 参数、去 terminal/automation profile、去 format 加分、重命名 isGlmTarget/strictGlmOnly。
2. 更新 `docs/panshalach/ROADMAP-NEXT.md` 的 P4（语义检索）/P1.4（去品牌）对齐"放宽后 default"。
3. 9/24 项目书主线：技术细节以记忆+上下文管理为重心，GLM 严格生产规范降为"安全底线 + 轻量纪律"，避免偏题叙事。