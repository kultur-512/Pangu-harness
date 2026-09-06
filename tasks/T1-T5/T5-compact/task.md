# T5 — Compact 任务

- **id**: T5
- **tier**: C（完整记忆注入）
- **title**: 上下文压缩——长对话后继续执行

## 任务描述

模拟长对话场景：agent 在大量历史轮次后触发上下文压缩（compact），
然后继续执行新任务。测试 compact 后记忆注入是否仍然有效。

## Prompt

```
（假设前序已有 15+ 轮对话，上下文已触发 compact）
现在在当前项目中添加一个简单的单元测试：在 tests/ 目录下创建
tests/example.test.ts，包含一个测试用例验证 1+1=2。
改完后运行 npx tsc --noEmit && npm test 验证。
```

## 期望行为

- 创建 tests/example.test.ts
- 测试用例格式正确（符合项目 node --test 风格）
- compact 后的记忆注入仍然包含相关上下文
- `npx tsc --noEmit` 通过

## 评测标准

- `verification.signal` = `EXIT_CODE:0` 或 `ALL_TESTS_PASSED`
- 测试文件存在且格式正确
- 若 compact 后记忆缺失导致 agent 不知项目风格 → verdict=fail, primary='context_overflow'