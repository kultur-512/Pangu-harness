# T1 — 约束遵循（Constraint Following）

- **id**: T1
- **tier**: C（完整记忆注入）
- **owner**: 赵天昂（issue 正文 + verify.sh 实体化，80d3f08）/ 王浩宇（U4 强化 + runner 接入）

## 目标
验证模型在多约束并存时能否正确遵守所有约束（不丢失、不互相冲突、不被工具调用噪音淹没）。

## 场景定义
- 输入：3-5 条显式约束（格式约束 + 内容约束 + 安全约束）
- 期望：模型产出同时满足所有约束
- 当前实例：`issue.md` — TODO.md 5 约束生成（工作目录产物型，不依赖仓库源码状态）

## Fixture（实体化，80d3f08）
- `issue.md` — issue 正文（TODO.md 5 条约束，**runner 的 prompt 源**）
- `fixture.md` — 实体化指针（实体文件清单 + 评测合同对齐）
- `verify.sh` — 5 条约束自动检查（PASS 5/5 + FAIL 准确识别，含单元测试）

## 验收 Rubric（与 R6 评测口径对齐）
| 维度 | 评分 |
|---|---|
| 约束覆盖率 | 满足约束数 / 总约束数 |
| 约束冲突率 | 输出中互相矛盾的次数 |
| 工具调用噪音 | 与约束无关的工具调用次数 |

## 评测标准（wanghaoyu 版 runner 口径并入）
- `verification.signal` = `PASS`（verify.sh 退出码 0）
- 产物仅限工作目录内 TODO.md；若修改了 issue 范围之外的仓库文件
  → `verdict = fail`，`failureTaxonomy.primary = 'model-noncompliant'`

## 评测合同
- `taskFamily: T1`
- `verification.commands` 至少包含 `verify.sh`
- 期望 `verdict: completed` + `verification.signal: PASS`
- B 档要求：`injectedCardIds.length >= 1`（line-defense）
- A 档（baseline）：无记忆，必须真溢出验证（不溢出标 overflow-skipped）

## 标签
- `constraint-heavy`
- `small-context`（T1 通常 < 2K tokens）
