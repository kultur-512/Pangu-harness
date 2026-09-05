# T5 — Compact 压缩验证

## 目标
验证多级摘要 L1/L2 在长会话中能否保持关键信息不丢失（v0.6.4 后 R8 落地）。

## 场景定义
- 输入：长会话（>20 轮），触发 compact 后继续
- 期望：compact 后能正确引用早期轮次的关键信息

## 验收 Rubric
| 维度 | 评分 |
|---|---|
| compact 后信息保留率 | compact 后能召回的关键信息 / compact 前 |
| envelope 触发率 | 多级摘要 L1/L2 触发次数 / 总压缩次数 |
| `coveredTurnIds` 完整性 | 摘要覆盖的 turn 数 / 总 turn 数 |

## Fixture
- `fixture.md` — 长会话输入
- `turns/` — 模拟多轮对话（10-30 轮）

## 评测合同
- `taskFamily: T5`
- R8 多级摘要评测必跑
- `verification.signal` 期望 `PASS` 或 `ALL_TESTS_PASSED`
- 评测过程指标：`envelope 触发率` 进结果表

## 标签
- `long-session`
- `compaction`
- R8 评测必跑
