# 【历史存档】GLM-5.3 极致高分 Agent 框架规划（Benchmark Chaser）

**此文档为 2025 年早期版本的规划存档，已被 Zorge 框架（高工程强度 + 高适用编码 + 高释放 GLM 能力）取代。**

当前最新定位见 `docs/plans/ZORGE-FRAMEWORK-FINAL-SPEC.md`（或直接阅读 ZorgeChaser 头部注释）。

核心变更：
- 从 "benchmark chasing" 转向 "工程强 + 分数强"
- 六档强度体系（quick/standard/high/max/ex/zorge，默认 high）
- 失败记忆提炼后持久化（.zorge-memory.json）
- Review 命令支持白名单测试读取
- 预算软限制 + 动态降级 + 用户确认机制

原文档保留仅供历史参考。当前框架已全面按 Zorge 规范重构。

---

（以下为原文档内容，仅供存档）
## 1. 整体架构：极致版五层结构

```
Layer 5: Benchmark-Oriented Orchestrator
  - 多 rollout 并行执行（Best-of-N / Tree Search / Bandit）
  - 轨迹评分与选择器（Trajectory Scorer + Selector）
  - 最终 patch 验证 + 提交

Layer 4: High-Compute Agent Loop（核心推理引擎）
  - Explore → Plan → Implement → Verify → Reflect → (Iterate)
  - 显式 Test-Time Scaling：多步思考 + 自我批评 + 回溯
  - 支持长上下文的记忆与锚点机制

Layer 3: GLM-5.3 专属 Prompt & Reasoning Protocol
  - 极致结构化 Persona（思考标签、验证协议、失败模式）
  - 分层提示系统（全局 + 阶段 + 动态上下文）
  - 针对 GLM 工具调用弱点的重度约束 + 自纠错

Layer 2: Tool Call + Execution Reliability Layer
  - 极致鲁棒的 GLM 工具解析器（已启动）
  - 执行沙箱 + 丰富反馈（stdout/stderr/测试结果/差异）
  - 工具调用失败自动修复循环

Layer 1: Context & Memory System（1M 上下文极致利用）
  - 智能锚点 + 分层记忆（Repo Map / File Anchors / Episodic / Critique）
  - 激进但保信号的 Compaction（优先保留测试、关键文件、失败历史）
  - 代码知识图谱（可选但高价值）
```

---

## 2. 强化工程能力的关键技术栈（强力模式核心）

### 2.1 Test-Time Compute（复杂任务的高强度思考）
- 对困难任务使用多路径探索 + 轨迹选择，提升解决方案质量。
- 不是为了多刷分，而是让模型在真实硬任务上多思考、少幻觉。

### 2.2 深度理解与锚点
- 预探索仓库/系统，保留关键上下文。
- 帮助模型在长链路任务中保持一致性和准确性。

### 2.3 验证优先循环（Verify-Heavy）
- 观察 → 思考 → 计划 → 执行 → **验证** → 建设性复盘。
- 强力模式下要求每一步有明确验证信号，适合高风险修改。
- 实用模式下验证仍重要，但更注重效率。

### 2.4 工具使用纪律与格式
- 对 GLM 等模型，强化标准工具调用格式（<> 格式）。
- Read-Before-Write、Verify-Before-Claim 等纪律，主要在强力模式下严格执行，避免日常过度消耗。

### 2.5 轨迹记录与失败记忆
- 完整记录执行轨迹，便于复盘和改进。
- 积累常见失败模式（幻觉、跳步、验证不足等），在未来任务中提醒模型，避免重复犯错。
- 目的是提升模型在真实工作中的可靠性，而不是针对 benchmark 打分。

---

## 3. 极致框架的核心组件清单

| 组件 | 优先级 | 说明 |
|------|--------|------|
| **Glm53ToolCallAdapter** | P0 | 已开始，必须极致可靠，支持流式 + 错误恢复 |
| **RepoExplorer** | P0 | 预探索阶段，构建仓库地图 + 锚点文件 |
| **StructuredReasoner** | P0 | 强制使用 <thinking> / <plan> / <critique> / <verify> 标签 |
| **TestTimeComputeOrchestrator** | P0 | 并行 rollout、评分、选择 |
| **VerificationEngine** | P0 | 测试执行、差异检查、回归验证 |
| **TrajectoryRecorder + Scorer** | P1 | 记录完整轨迹并打分 |
| **ContextManager (1M-aware)** | P1 | 锚点保留 + 智能压缩 + 知识图谱 |
| **SelfCritiqueModule** | P1 | 专门的批评 prompt + 修复循环 |
| **PatchFinalizer** | P1 | 最终 patch 规范化 + 提交前验证 |
| **BenchmarkHarness** | P2 | 对接 SWE-Bench / Terminal-Bench 的 runner |

---

## 4. 推荐的 Agent Loop（极致版）

```
for each issue:
    1. RepoExplorer.run()          # 重度探索，消耗较多 token
    2. for attempt in 1..N:
         trajectory = []
         while not done:
             state = ContextManager.get()
             thought = StructuredReasoner.think(state, trajectory)
             plan = StructuredReasoner.plan(...)
             critique = StructuredReasoner.critique(...)   # 关键步骤
             actions = decide_actions(...)
             results = ToolExecutor.execute(actions)       # 带丰富反馈
             trajectory.append({thought, plan, critique, actions, results})
             if VerificationEngine.is_solved():
                 break
         score = TrajectoryScorer.score(trajectory)
         candidates.append({trajectory, patch, score})
    3. best = select_best(candidates)
    4. PatchFinalizer.validate_and_submit(best.patch)
```

关键创新点：
- 每个循环都有显式 `critique`
- 多 attempt + 轨迹评分
- 探索阶段和执行阶段分离

---

## 5. 实施路线图（能力强化路线）

**Phase 0（当前）**：可靠的工具调用 + 基础结构
- 完成高可靠工具调用解析（支持 GLM 格式和其他模型）
- 建立结构化思考协议和验证循环基础

**Phase 1（核心能力强化）**：
- 验证优先的执行循环（Observe → Think → Plan → Act → Verify → Critique）
- 深度上下文探索 + 关键锚点保留
- 失败记忆机制（避免反复犯同样错误）

**Phase 2（强力模式支持）**：
- 多路径探索 + 轨迹选择（用于特别困难的任务）
- 强力模式（高验证密度 + 严格纪律）与实用模式的清晰区分
- Token 控制与效率优化

**Phase 3（真实工程场景覆盖）**：
- 支持代码修改、终端命令、业务自动化等多种真实任务风格
- 针对不同任务类型的验证策略和提示适配

**Phase 4（长期可靠性）**：
- 持续积累真实失败案例
- 让模型在日常高强度工作中越来越可靠，而非只在 benchmark 上好看

**注意**：整个路线不以追逐单一 benchmark 分数为目标，而是以“让模型在真实日常高难度工程任务中更强、更稳”为核心。

---

## 6. 风险与取舍（现实路线必须面对）

- **Token 消耗**：强力模式（多步验证 + 结构化思考 + 可能的多路径）会消耗较多 token。需要提供预算控制、early-stop 和实用模式切换。
- **延迟**：复杂任务在强力模式下会更慢。需要并行策略和用户可控的强度级别。
- **避免过度拟合特定评测**：框架要保留通用真实工程能力，不能为了某个 benchmark 的 idiosyncrasy 而牺牲日常可用性。
- **模型格式漂移**：GLM 或其他模型的输出格式可能随版本变化，工具解析层必须易于维护和快速修复。

---

## 7. 与当前环境的结合建议

当前你已经在用 DeepSeek Harness + 正在开发 GLM Adapter。

**推荐混合策略**：
- 把 **Glm53ToolCallAdapter** 做成高可靠核心（可独立 npm 包）。
- 在 DSH 上新建一个 **极致 preset**（`glm53-bench-chaser`）。
- 把 Test-Time Compute Orchestrator、Trajectory 系统做成**动态 Cordis 插件** 或独立进程。
- 利用 DSH 已有的 sandbox、jobs、子代理能力，避免重复造轮子。

也可以后期把核心 Loop 抽成独立高性能框架，通过 MCP/自定义协议被 DSH、Claude Code 等调用。

---

## 9. 极致路线当前进展与下一步（实时更新）

### 已完成
- GLM-5.3 真实工具调用格式捕获与验证（用户提供的 `<>` + `<Tool>` 格式）
- 基础 ToolCall Adapter 原型（已能正确解析 Bash / Read 等真实样本）
- 极致框架整体架构设计文档

### 正在进行（P0）
- **极致 Tool Call Adapter**（支持流式、错误恢复、多变体、调试轨迹记录）
- 针对 benchmark 的失败模式收集（格式漂移、幻觉参数、未闭合标签等）

### 建议立刻启动的下一个极致组件（按对分数影响排序）

1. **StructuredReasoner + 极致思考协议**（最高杠杆）
   - 强制标签：<thinking>、<plan>、<verify>、<critique>、<risk>
   - GLM 专用长思考提示模板
   - 自我批评 + 失败模式注入

2. **RepoExplorer（深度仓库探索）**
   - 预先构建 repo map + 关键文件锚点
   - 测试框架识别、入口点分析
   - 为 1M 上下文准备“高价值内容包”

3. **Verify-Heavy 单轨迹 Loop 原型**
   - Observe → Think → Plan → Act → Verify → Critique 循环
   - 每一步必须有可验证信号才继续

4. **TrajectoryRecorder + 简单 Scorer**
   - 为后续 Best-of-N 做准备

5. **Test-Time Compute Orchestrator 骨架**
   - 并行 rollout 管理器
   - 预算控制 + early stop

---

**当前用户输入的样本已被成功解析**，证明底层 Adapter 方向正确。

下一步推荐：先把 **极致思考协议 + RepoExplorer** 落地，再把 Verify + Critique 循环跑通。
