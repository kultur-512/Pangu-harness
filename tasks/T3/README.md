# T3 — 长文档处理（Long Document）

- **id**: T3
- **tier**: C（完整记忆注入）
- **owner**: 赵天昂（issue 正文 + verify.sh 实体化，80d3f08）/ 王浩宇（U4 补 `document.md` + keyword 召回强化）

## 目标
验证模型在长文档（>10K tokens）场景下的压缩 / 摘要 / 信息保持能力。

## 场景定义
- 输入：长文档（10K-50K tokens），需要从中提取信息或生成摘要
- 期望：模型能正确处理长上下文，保持关键信息
- 当前实例：`issue.md` — 从 `document.md` 抽取 Q1/Q2/Q3 答案写入 `answers.md`

## Fixture（实体化进行中，80d3f08）
- `issue.md` — issue 正文（Q1/Q2/Q3 摘要任务，**runner 的 prompt 源**）
- `fixture.md` — 实体化指针
- `verify.sh` — 4 条基础检查：3 个标题 + 全文/Q1/Q3 字节上限（PASS 6/6）
- `document.md` — ⏳ 待 U4 王浩宇：10K-50K tokens 长文档

## 验收 Rubric
| 维度 | 评分 |
|---|---|
| 信息召回率 | 检索到的关键信息 / 总关键信息 |
| 摘要忠实度 | 摘要与原文的事实一致性 |
| 上下文窗口利用率 | 实际使用的 prompt tokens / 模型 context window |
| 格式合规率 | 三级标题存在 + 字符数限制满足 |

## 期望行为（wanghaoyu 版并入）
- 在海量上下文中精准定位目标信息（章节 / 人物 / 结论）
- 按指定格式输出（`### Q1/Q2/Q3` 三级标题，顺序固定）
- 全文总字符数 ≤ 800 字（摘要忠实度边界）

## 评测标准（wanghaoyu 版 runner 口径并入）
- `verification.signal` = `PASS`（verify.sh 退出码 0）
- `prompt.estimatedTokens` 必须反映长文档特征（> 10K）
- 新增内容符合指定格式（标题 + 字数上限）

## 评测合同
- `taskFamily: T3`
- `verification.commands` 至少包含 `verify.sh`
- R8 多级摘要 L1/L2 评测必跑

## 标签
- `long-context`
- `summarization`
- R8 评测必跑
