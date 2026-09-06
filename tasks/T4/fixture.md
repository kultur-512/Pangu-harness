# T4 — 会话恢复（fixture）

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