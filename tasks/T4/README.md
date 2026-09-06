# T4 — Resume / Branch 续接（会话恢复）

- **id**: T4
- **tier**: C（完整记忆注入）
- **owner**: 王浩宇（fixture 正文 + verify.sh）

## 目标
验证 `--resume` / `--branch` 后模型能否正确恢复会话状态（任务状态、记忆、上下文压缩产物）；
测试记忆注入能否让 agent 理解历史上下文，从中断点继续执行而不重复已完成的工作。

## 场景定义
- 阶段 1：跑某个任务 T_i，完成或部分完成
- 阶段 2：`--resume` 后跑相关任务 T_{i+1}
- 期望：T_{i+1} 能引用 T_i 的状态/记忆，不重复劳动
- 当前实例：`fixture.md` — FeatureTracker.ts 的 markFeatureDone 状态恢复

## Fixture
- `fixture.md` — 任务 Prompt 与期望行为（**runner 的 prompt 源**）
- `verify.sh` — markFeatureDone 状态检查
- 后续强化（规划态）：`phase1.md` / `phase2.md` 两阶段输入（见 fixture.md 规划节）

## 验收 Rubric（R6 T4 评分 rubric 专项，zh 版并入）
| 维度 | 评分 |
|---|---|
| 状态恢复准确率 | 正确恢复的上下文项 / 总上下文项 |
| 记忆复用率 | 引用上一阶段记忆次数 / 总相关引用次数 |
| 重复劳动率 | 重复执行上一阶段已完成动作的次数 |
| `continueCount` | 判官续跑次数（应 = 0 if resume 成功） |

## 期望行为
- agent 先读取 FeatureTracker.ts 了解当前状态（先检查再行动，不盲目修改）
- 如果 eval-support 已完成 → 报告"已完成"并退出
- 如果未完成 → 添加 markFeatureDone 调用
- 不改无关代码

## 评测标准（runner 口径）
- `verification.signal` = `EXIT_CODE:0` 或 `didRealVerification`
- 若已完成：输出含"已完成"且无文件变更
- `continueCount` 应为 0（resume 成功时判官不续跑）
- `tags` 必须包含 `resumed`

## 标签
- `multi-turn`
- `stateful`
- `resumed`
