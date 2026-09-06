# T5 — 上下文压缩后继续执行

- **id**: T5
- **tier**: C（完整记忆注入）
- **owner**: 王浩宇（fixture 正文 + verify.sh）

## 任务目标

模拟长对话场景：agent 在大量历史轮次后触发上下文压缩（compact），
然后继续执行新任务。测试 compact 后记忆注入是否仍然有效。

## 期望行为

- 创建测试文件（格式正确）
- compact 后的记忆注入仍然包含相关上下文
- 编译通过

## 评测标准

- `verification.signal` = `EXIT_CODE:0` 或 `ALL_TESTS_PASSED`
- 测试文件存在且格式正确
- 若 compact 后记忆缺失导致 agent 不知项目风格 → verdict=fail, primary='context-overflow'