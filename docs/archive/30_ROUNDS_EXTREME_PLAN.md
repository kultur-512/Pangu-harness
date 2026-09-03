# 30-Round Extreme Debug & Review Plan (E 路径)

**目标**：在已完成 10 轮框架的基础上，**再进行 30 轮极致打磨**，目标是让 GLM-5.3 真正达到 SWE-Pro 90+ 的稳定表现。

## 整体策略

- 每轮只专注**1-2 个极小但高影响**的点
- 每轮必须有：实现 → 真实/模拟数据 debug → review → 记录
- 每轮结束后更新本文件和 `ROUND_ITERATION_LOG.md`
- 重点方向（按权重排序）：
  1. Tool Reliability（变态级别）
  2. Reasoning Protocol 深度
  3. Exploration + Anchor 质量
  4. Verify + Critique 闭环强度
  5. Test-Time Compute 效率与选择
  6. Failure Memory 精准度
  7. Generative Verification 质量
  8. Context 效率（1M 利用率）
  9. Token 效率与 Early-Stop
  10. 可观测性、诊断、自动修复

## 30 轮计划（每轮 1 页可执行）

Round 11: Tool Adapter 流式边界全覆盖 + 诊断增强  
Round 12: 工具调用自修复提示词生成器  
Round 13: StructuredReasoner 思考长度强制 + 示例蒸馏  
Round 14: Critique 质量评分器（模型打分）  
Round 15: RepoExplorer 真实文件系统实现  
Round 16: Anchor 动态重要性算法  
Round 17: VerifyCritiqueLoop 状态机重构  
Round 18: 验证信号标准化（PASS / FAIL / PARTIAL）  
Round 19: Trajectory 摘要 + 关键节点提取  
Round 20: 多 Rollout 并行执行器（真实并发）  
Round 21: Trajectory Scorer 升级为模型 + 规则混合  
Round 22: Early-Stop 策略（当已有高分轨迹时）  
Round 23: FailureMemory 按 issue 类型索引  
Round 24: 自动从轨迹中挖掘新失败模式  
Round 25: GenerativeTest 质量 Critique 闭环  
Round 26: 自生成测试的覆盖率检查  
Round 27: ContextManager 真实 token 计数压缩  
Round 28: Anchor 版本控制 + 差异对比  
Round 29: 全链路可观测性（每步打点 + 日志）  
Round 30: Budget 硬控制 + 优雅降级  
Round 31: Prompt 模板 A/B 测试框架  
Round 32: 错误恢复路径全覆盖（工具失败、模型漂移）  
Round 33: 模拟 SWE-Bench issue 端到端跑通  
Round 34: 真实 Zhipu GLM-5.3 调用接入层  
Round 35: 真实文件系统 + 测试执行引擎  
Round 36: 轨迹可视化与人工 review 工具  
Round 37: 第二轮全量压力测试（边界 case 爆破）  
Round 38: 性能分析 + token 效率报告  
Round 39: 第三轮全量 debug（针对真实失败案例）  
Round 40: 最终 review + 代码质量 + 文档完善 + 发布准备

---

**当前状态**：已完成 Round 10 骨架 + CLI 入口。

下一轮（Round 11）将从 **Tool Adapter 流式边界** 开始极致打磨。

请确认是否立即开始 Round 11。
