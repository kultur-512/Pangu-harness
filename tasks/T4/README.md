# T4 — Resume / Branch 续接

## 目标
验证 `--resume` / `--branch` 后模型能否正确恢复会话状态（任务状态、记忆、上下文压缩产物）。

## 场景定义
- 阶段 1：跑某个任务 T_i，完成或部分完成
- 阶段 2：`--resume` 后跑相关任务 T_{i+1}
- 期望：T_{i+1} 能引用 T_i 的状态/记忆，不重复劳动

## 验收 Rubric（R6 T4 评分 rubric 专项）
| 维度 | 评分 |
|---|---|
| 状态恢复准确率 | 正确恢复的上下文项 / 总上下文项 |
| 记忆复用率 | 引用上一阶段记忆次数 / 总相关引用次数 |
| 重复劳动率 | 重复执行上一阶段已完成动作的次数 |
| `continueCount` | 判官续跑次数（应 = 0 if resume 成功） |

## Fixture
- `fixture.md` — 两阶段 issue
- `phase1.md` — 阶段 1 的输入
- `phase2.md` — 阶段 2 的输入（依赖 phase1）

## 评测合同
- `taskFamily: T4`
- `continueCount` 应为 0（resume 成功时判官不续跑）
- `tags` 必须包含 `resumed`

## 标签
- `multi-turn`
- `stateful`
- `resumed`
