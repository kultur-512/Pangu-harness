# T4 — 会话恢复（fixture）

## Prompt 加载（runner 契约）

run-eval.mjs 的 prompt 源 = 本文件 `## Prompt` 段（T4/T5 无 issue.md，走 fixture.md 回退）。

## Prompt

```
继续之前未完成的任务：在 src/cli/repl/FeatureTracker.ts 中添加一个 markFeatureDone
调用，位置在 feature 'eval-support' 完成时。如果该 feature 已经标记完成，
则报告"已完成"并退出。
```

## 期望

- agent 先读取 FeatureTracker.ts 了解当前状态
- 如果 eval-support 已完成 → 报告"已完成"并退出
- 如果未完成 → 添加 markFeatureDone 调用
- 不改无关代码

## 后续强化（规划态，zh 版两阶段设计并入）

当前为单阶段实例（直接给中断态）。规划态强化为两阶段 resume 实体化：
- 阶段 1（`phase1.md`）：建立状态——跑任务 T_i 落定任务状态 + 记忆写入
- 阶段 2（`phase2.md`）：`--resume` 后跑关联任务 T_{i+1}，验证引用 T_i 状态/记忆
- 判分依赖：记忆复用率 + 重复劳动率（见 README Rubric）
- U6 真机 openPangu 跑分时使用
