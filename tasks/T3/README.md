# T3 — 长文档理解

- **id**: T3
- **tier**: C（完整记忆注入）
- **owner**: 王浩宇（fixture 正文 + verify.sh）/ 赵天昂（issue 正文草稿 9/12-13）

## 任务目标

agent 需要在大型文件（如 sseInteractive.ts ~98KB）中定位特定逻辑并修改。
测试 agent 在大量上下文中能否借助记忆注入精准定位。

## 期望行为

- 在大型文件中精准定位目标代码
- 完成指定修改
- 不改无关代码
- 编译通过

## 评测标准

- `verification.signal` = `EXIT_CODE:0`
- 变更仅在目标文件中
- 新增代码符合指定格式