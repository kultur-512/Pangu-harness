# GLM-5.3 SWE-Pro 90 Chaser — 30轮极致打磨执行总览

**执行路径**：E（先把 CLI 做好，再进行 30 轮 debug & review）

**核心目标**：在已有 10 轮框架基础上，再进行 **30 轮极致打磨**，让 GLM-5.3 有机会稳定冲击 SWE-Pro 90+ 分。

---

## 30 轮计划总览（已制定）

详见 `docs/30_ROUNDS_EXTREME_PLAN.md`

核心打磨方向（权重从高到低）：
1. Tool Reliability（变态级别）
2. Reasoning Protocol 深度与长度
3. Exploration + Anchor 质量
4. Verify + Critique 闭环强度
5. Test-Time Compute 效率与选择策略
6. Failure Memory 精准度与自动挖掘
7. Generative Verification 质量
8. Context 效率（真实 token 控制）
9. Early-Stop + Budget 控制
10. 全链路可观测性与诊断能力

---

## 当前执行进度

- **Round 10 完成**：完整框架骨架 + 主入口 `Glm53SweProChaser`
- **Round 11 开始执行**：
  - CLI 已落地（`src/cli.ts`）
  - 支持 `simulate` 和 `debug-adapter` 两个核心命令
  - 新增 `tests/extremeAdapter.test.ts` 作为持续打磨的测试基线
  - `package.json` 已更新脚本

**已创建的重要文档**：
- `docs/30_ROUNDS_EXTREME_PLAN.md`（30 轮路线图）
- `docs/30_ROUNDS_EXECUTION_LOG.md`（执行日志）

---

## 下一阶段（Round 11 ~ 40）执行原则

1. **每轮只改 1-2 个极小但高杠杆点**
2. 每轮必须有验证（真实样本或模拟）
3. 每轮必须写 review 结论
4. 持续更新 `30_ROUNDS_EXECUTION_LOG.md`
5. 优先级永远对齐“让 GLM 能拿到高分”这个终极目标

---

**当前状态**：已准备好进入 30 轮极致打磨循环。

请确认是否立即开始 **Round 11**（Tool Adapter 流式边界 + 诊断强化）。
