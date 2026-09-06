# T1 — 约束任务

- **id**: T1
- **tier**: C（完整记忆注入）
- **title**: 单文件约束修改——只改指定文件，不改其他

## 任务描述

给定一个带有明确约束的工程任务：agent 必须在指定文件内完成修改，不得触碰其他文件。
测试 agent 在记忆注入辅助下能否遵守文件级约束。

## Prompt

```
在 src/cli/repl/GerundSpinner.ts 中，把 spinner 的默认帧率从 80ms 改为 100ms。
只改这一个文件，不要修改任何其他文件。改完后运行 npx tsc --noEmit 验证。
```

## 期望行为

- 仅修改 `src/cli/repl/GerundSpinner.ts` 一个文件
- 帧率值从 80 改为 100
- 不改其他文件
- 运行 `npx tsc --noEmit` 验证通过
- 若有记忆卡提示约束风格，agent 应遵循

## 评测标准

- `verification.signal` = `EXIT_CODE:0` 或 `didRealVerification`
- 文件变更集 ⊆ {src/cli/repl/GerundSpinner.ts}
- 若变更了其他文件 → `verdict = fail`, `failureTaxonomy.primary = 'model_noncompliant'`