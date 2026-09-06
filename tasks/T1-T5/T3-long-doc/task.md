# T3 — 长文档任务

- **id**: T3
- **tier**: C（完整记忆注入）
- **title**: 长文档理解——在大型文件中定位并修改

## 任务描述

agent 需要在大型文件（如 sseInteractive.ts ~98KB）中定位特定逻辑并修改。
测试 agent 在大量上下文中能否借助记忆注入精准定位。

## Prompt

```
在 src/cli/repl/sseInteractive.ts 中，找到处理 SSE 'done' 事件的回调函数，
在回调末尾添加一行 console.log 输出本次任务的 refined 统计信息（如果存在）。
格式：console.log('[eval] refined:', JSON.stringify(event.refined));
改完后运行 npx tsc --noEmit 验证。
```

## 期望行为

- 在 SSE done 事件回调中正确添加日志
- 日志格式正确，含 refined 统计
- 不改无关代码
- `npx tsc --noEmit` 通过

## 评测标准

- `verification.signal` = `EXIT_CODE:0`
- 新增代码含 `[eval] refined` 字符串
- 变更仅在 sseInteractive.ts 中