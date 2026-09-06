# T5 — 上下文压缩后继续执行（fixture）

## Prompt 加载（runner 契约）

run-eval.mjs 的 prompt 源 = 本文件 `## Prompt` 段（T4/T5 无 issue.md，走 fixture.md 回退）。

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

## 后续强化（规划态，zh 版长会话剧本设计并入）

当前为"假设已 compact"的单步实例（不真实触发压缩）。规划态实体化：
- 准备长会话（10-30 轮，`turns/` 目录存放模拟多轮对话剧本）
- 编写触发 compact 的剧本（真实越过上下文阈值，而非假设态）
- 判分依赖：信息保留率 + envelope 触发率（见 README Rubric）
- U6 真机 openPangu 跑分时使用，R8 多级摘要评测必跑
