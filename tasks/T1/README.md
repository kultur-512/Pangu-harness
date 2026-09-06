# T1 — 单文件约束修改

- **id**: T1
- **tier**: C（完整记忆注入）
- **owner**: 王浩宇（fixture 正文 + verify.sh）/ 赵天昂（issue 正文草稿 9/12-13）

## 任务目标

在给定文件中完成单一约束修改，不得触碰其他文件。测试 agent 在记忆注入辅助下能否遵守文件级约束。

## 期望行为

- 仅修改指定文件
- 不改其他文件
- 验证命令通过
- 若有记忆卡提示约束风格，agent 应遵循

## 评测标准

- `verification.signal` = `EXIT_CODE:0` 或 `didRealVerification`
- 文件变更集 ⊆ 指定文件
- 若变更了其他文件 → `verdict = fail`, `failureTaxonomy.primary = 'model-noncompliant'`