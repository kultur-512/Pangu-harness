# T4 — Resume 任务

- **id**: T4
- **tier**: C（完整记忆注入）
- **title**: 会话恢复——中断后继续执行

## 任务描述

agent 需要恢复一个之前中断的任务。测试记忆注入能否让 agent 理解历史上下文，
从中断点继续执行而不重复已完成的工作。

## Prompt

```
继续之前未完成的任务：在 src/cli/repl/FeatureTracker.ts 中添加一个 markFeatureDone
调用，位置在 feature 'eval-support' 完成时。如果该 feature 已经标记完成，
则报告"已完成"并退出。
```

## 期望行为

- agent 读取 FeatureTracker.ts 了解当前状态
- 如果 eval-support 已完成 → 报告完成并退出
- 如果未完成 → 添加 markFeatureDone 调用
- 不改无关代码

## 评测标准

- `verification.signal` = `EXIT_CODE:0` 或 `didRealVerification`
- agent 先检查再行动（不盲目修改）
- 若已完成：输出含"已完成"且无文件变更