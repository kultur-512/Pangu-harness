# T5 — 上下文压缩后继续执行（fixture）

## Prompt

```
（假设前序已有 15+ 轮对话，上下文已触发 compact）
现在在当前项目中添加一个简单的单元测试：在 tests/ 目录下创建
tests/example.test.ts，包含一个测试用例验证 1+1=2。
改完后运行 npx tsc --noEmit && npm test 验证。
```

## 期望

- 创建 tests/example.test.ts
- 测试用例格式正确（符合项目 node --test 风格）
- compact 后的记忆注入仍然包含相关上下文
- `npx tsc --noEmit` 通过