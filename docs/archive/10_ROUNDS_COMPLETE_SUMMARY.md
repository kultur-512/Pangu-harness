# GLM-5.3 SWE-Pro 90 Chaser — 10 轮全量迭代总结

**最终目标**：构建一个能让 GLM-5.3 在 SWE-Bench / SWE-Pro 类基准上稳定拿到 **90+ 分** 的极致框架。

---

## 已完成的 10 轮核心推进（按实际编码顺序）

### Round 1: Extreme Tool Reliability
- 实现 `ExtremeGlmToolCallAdapter`
- 支持流式、变体检测、诊断、修复建议
- 真实用户输入样本已验证通过

### Round 2: StructuredReasoner + 极致协议
- 强制 `<thinking> / <plan> / <verify> / <critique> / <risk>` 结构
- GLM 专属 Persona + 失败模式注射
- Critique 专用 prompt 模板

### Round 3: RepoExplorer + Anchor Memory
- 预探索 + 锚点文件系统
- 重要性排序 + 长期保留机制

### Round 4: VerifyCritiqueLoop
- Observe → Think → Plan → Act → Verify → Critique 强制闭环
- 每步必须有验证信号

### Round 5: Trajectory Engineering 基础
- `TrajectoryRecorder`
- 完整轨迹数据结构

### Round 6: Test-Time Compute
- `TestTimeOrchestrator`
- 多 rollout + 简单评分选择

### Round 7: FailureMemory
- GLM 专属失败模式收集与 prompt 注射

### Round 8: Generative Verification
- 主动生成测试 + 自测闭环

### Round 9: 1M Context 极致利用
- `ContextManager`
- Anchor + 分层历史保留

### Round 10: 全系统集成
- `Glm53SweProChaser` 主入口
- 完整 10 轮框架串联
- 最终 review 完成

---

## 核心结论（必须持续对齐）

1. Test-Time Compute Scaling（多 rollout + 选择）
2. Pre-Execution Heavy Exploration + Anchor
3. Verify-Heavy + Structured Critique
4. Trajectory Engineering
5. Extreme Tool Reliability
6. GLM-specific Failure Memory
7. Self-Testing + Generative Verification
8. 1M Context 极致利用

---

## 当前代码结构（已实现）

```
src/
├── adapter/
│   ├── ExtremeGlmToolCallAdapter.ts   # 极致工具调用解析
│   └── GlmToolCallParser.ts           # 基础版
├── reasoning/
│   └── StructuredReasoner.ts          # 结构化思考协议
├── context/
│   ├── RepoExplorer.ts
│   └── ContextManager.ts
├── loop/
│   └── VerifyCritiqueLoop.ts
├── orchestration/
│   └── TestTimeOrchestrator.ts
├── memory/
│   └── FailureMemory.ts
├── types/
│   └── toolCall.ts
└── Glm53SweProChaser.ts               # 主入口
```

---

## 下一阶段建议（真实落地）

1. 接入真实 GLM-5.3 调用（Zhipu SDK）
2. 对接真实文件系统 + 测试执行
3. 在真实 SWE-Bench issue 上跑通端到端流程
4. 持续收集真实失败轨迹，喂给 FailureMemory
5. 进行 token 效率优化 + 评分器升级

---

**当前状态**：框架骨架已按“极致高分”思路完整实现一轮，并完成了 10 轮规划中的核心逻辑。

需要我现在开始：
- A. 写真实模型调用适配层
- B. 实现真实文件系统 + 测试执行
- C. 对某个具体 SWE-Bench issue 做端到端实验
- D. 继续对现有组件进行第 2 轮深度 debug + 强化

请直接指示。
