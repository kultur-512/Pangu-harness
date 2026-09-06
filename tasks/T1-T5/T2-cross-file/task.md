# T2 — 跨文件任务

- **id**: T2
- **tier**: C（完整记忆注入）
- **title**: 跨文件重构——修改多个关联文件

## 任务描述

agent 需要修改 2-3 个关联文件完成一个重构任务。测试 agent 能否在记忆注入辅助下
正确识别跨文件依赖并完成所有必要修改。

## Prompt

```
把 src/cli/repl/ConfigManager.ts 中的 getConfig 方法重命名为 getConfigValue，
并更新所有调用此方法的地方（在 src/cli/repl/ 目录下搜索）。
改完后运行 npx tsc --noEmit 验证编译通过。
```

## 期望行为

- 重命名 `ConfigManager.ts` 中的 `getConfig` → `getConfigValue`
- 更新所有调用点
- `npx tsc --noEmit` 通过
- 不引入新的编译错误

## 评测标准

- `verification.signal` = `EXIT_CODE:0`
- 变更文件数 ≥ 1（至少 ConfigManager.ts）
- 所有引用点已更新（无编译错误）