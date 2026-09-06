# T4 — 会话恢复

- **id**: T4
- **tier**: C（完整记忆注入）
- **owner**: 王浩宇（fixture 正文 + verify.sh）

## 任务目标

agent 需要恢复一个之前中断的任务。测试记忆注入能否让 agent 理解历史上下文，
从中断点继续执行而不重复已完成的工作。

## 期望行为

- agent 读取目标文件了解当前状态
- 如果已完成 → 报告完成并退出
- 如果未完成 → 继续执行
- 不改无关代码

## 评测标准

- `verification.signal` = `EXIT_CODE:0` 或 `didRealVerification`
- agent 先检查再行动（不盲目修改）
- 若已完成：输出含"已完成"且无文件变更