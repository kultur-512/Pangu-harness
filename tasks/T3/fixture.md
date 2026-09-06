# T3 — 长文档理解（fixture）

<!-- 赵天昂 9/12-13 起 T3 草稿：中文长程维护场景 -->

## Prompt

```
在 src/cli/repl/sseInteractive.ts 中，找到处理 SSE 'done' 事件的回调函数，
在回调末尾添加一行 console.log 输出本次任务的 refined 统计信息（如果存在）。
格式：console.log('[eval] refined:', JSON.stringify(event.refined));
改完后运行 npx tsc --noEmit 验证。
```

## 期望

- 在 SSE done 事件回调中正确添加日志
- 日志格式正确，含 refined 统计
- `npx tsc --noEmit` 通过