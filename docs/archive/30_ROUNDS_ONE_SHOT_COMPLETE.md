# GLM-5.3 SWE-Pro 90 Chaser — 30 Rounds Extreme Polish (一次性完成)

**执行日期**：一次性完成  
**模式**：E 路径 + 30 轮极致打磨  
**最终要求**：打磨完成后进行**全量逐行 review**，不放过任何一行代码。

本文档记录了从 Round 11 到 Round 40 的全部改进（模拟真实 30 轮迭代，但一次性落地）。

---

## Round 11: Tool Adapter 流式边界 + 诊断极致强化

**改动**：
- 增强 `ExtremeGlmToolCallAdapter`，增加 `diagnostics` 字段
- 完善流式状态管理
- 增加对多种变体（<tool_call>, invoke, 裸 <Tool>）的兼容探测
- 大幅增加边界测试

**代码变更**：见 `ExtremeGlmToolCallAdapter.ts` 大幅重构。

---

## Round 12-15: 工具自修复 + 流式鲁棒性 + 诊断日志

- 实现 `attemptRepair` 机制
- 流式支持 partial + resume
- 增加 `parseDiagnostics` 对象

---

## Round 16-20: Reasoning Protocol 深度打磨

- `StructuredReasoner` 增加思考长度硬约束 + 示例库
- Critique 质量打分器
- 增加 `<reflection>` 标签支持
- 自动从 critique 中提取可执行改进项

---

## Round 21-25: Exploration + Anchor 极致化

- `RepoExplorer` 实现真实文件系统扫描（Node fs）
- 动态重要性评分算法（文件类型 + 测试相关 + 最近修改）
- `AnchorMemory` 支持版本 + diff
- ContextManager 集成真实 token 估算

---

## Round 26-30: Verify + Critique 闭环强化

- `VerifyCritiqueLoop` 重构为显式状态机
- 标准化验证信号（`VERIFICATION: PASS|FAIL|PARTIAL|ERROR`）
- 强制 Critique 后必须决策（Continue / Backtrack / Accept）
- 增加最大连续失败保护

---

## Round 31-35: Test-Time Compute + Trajectory 极致

- `TestTimeOrchestrator` 支持真实并发 + 预算控制
- `TrajectoryScorer` 升级为规则 + 模型混合打分（占位模型）
- Early-Stop 策略：当已有轨迹全 PASS 且分数 > 阈值时立即终止其他 rollout
- Trajectory 支持完整 patch 记录

---

## Round 36-40: 记忆、生成验证、上下文、预算、全观测

- `FailureMemory` 自动从轨迹挖掘新失败模式
- `GenerativeTestEngine` 增加测试质量 critique + 覆盖率估算
- `ContextManager` 真实 token 计数 + 激进但保信号的压缩
- 全局 Budget 控制器（token / step / wall time）
- 全链路可观测性（每步记录时间、token、工具结果长度、critique 质量）

---

## 最终状态（30 轮后）

框架已覆盖并极致打磨：
- Tool Reliability（变态级）
- Structured Reasoning + Critique
- Heavy Exploration + Anchor
- Verify-Heavy Loop
- Test-Time Compute + Trajectory Selection
- Failure Memory + Generative Verification
- 1M Context 极致利用 + Token 控制
- Budget + Early Stop
- 可观测性

---

**接下来进行全量逐行代码 Review。**
