# T5 — Compact 压缩验证（上下文压缩后继续执行）

- **id**: T5
- **tier**: C（完整记忆注入）
- **owner**: 王浩宇（fixture 正文 + verify.sh）

## 目标
验证多级摘要 L1/L2 在长会话中能否保持关键信息不丢失（v0.6.4 后 R8 落地）；
测试 compact 后记忆注入是否仍然有效。

## 场景定义
- 输入：长会话（>20 轮），触发 compact 后继续
- 期望：compact 后能正确引用早期轮次的关键信息
- 当前实例：`fixture.md` — 模拟 compact 后创建 tests/example.test.ts

## Fixture
- `fixture.md` — 任务 Prompt 与期望行为（**runner 的 prompt 源**）
- `verify.sh` — 测试文件存在 + 编译/测试门
- 后续强化（规划态）：`turns/` 模拟多轮对话剧本（见 fixture.md 规划节）

## 验收 Rubric（zh 版并入）
| 维度 | 评分 |
|---|---|
| compact 后信息保留率 | compact 后能召回的关键信息 / compact 前 |
| envelope 触发率 | 多级摘要 L1/L2 触发次数 / 总压缩次数 |
| `coveredTurnIds` 完整性 | 摘要覆盖的 turn 数 / 总 turn 数 |

## 期望行为
- 创建测试文件（格式正确）
- compact 后的记忆注入仍然包含相关上下文（项目测试风格不丢失）
- 编译通过

## 评测标准（runner 口径）
- `verification.signal` = `EXIT_CODE:0` 或 `ALL_TESTS_PASSED`
- 测试文件存在且格式正确
- 若 compact 后记忆缺失导致 agent 不知项目风格 → `verdict = fail`，
  `failureTaxonomy.primary = 'context-overflow'`
- 评测过程指标：`envelope 触发率` 进结果表

## 评测合同
- `taskFamily: T5`
- R8 多级摘要 L1/L2 评测必跑

## 标签
- `long-session`
- `compaction`
- R8 评测必跑
