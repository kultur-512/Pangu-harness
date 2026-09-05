# T1 — 约束遵循（Constraint Following）

## 目标
验证模型在多约束并存时能否正确遵守所有约束（不丢失、不互相冲突、不被工具调用噪音淹没）。

## 场景定义
- 输入：3-5 条显式约束（格式约束 + 内容约束 + 安全约束）
- 期望：模型产出同时满足所有约束

## 验收 Rubric（与 R6 评测口径对齐）
| 维度 | 评分 |
|---|---|
| 约束覆盖率 | 满足约束数 / 总约束数 |
| 约束冲突率 | 输出中互相矛盾的次数 |
| 工具调用噪音 | 与约束无关的工具调用次数 |

## Fixture（占位，U4 王浩宇实体化）
- `fixture.md` — issue 正文（约束列表）
- `verify.sh` — 自动验证脚本（mock-passing 占位）

## 评测合同
- `taskFamily: T1`
- `verification.commands` 至少包含 `verify.sh`
- 期望 `verdict: completed` + `verification.signal: PASS`
- B 档要求：`injectedCardIds.length >= 1`（line-defense）

## 标签
- `constraint-heavy`
- `small-context`（T1 通常 < 2K tokens）
