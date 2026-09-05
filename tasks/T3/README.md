# T3 — 长文档处理（Long Document）

## 目标
验证模型在长文档（>10K tokens）场景下的压缩 / 摘要 / 信息保持能力。

## 场景定义
- 输入：长文档（10K-100K tokens），需要从中提取信息或生成摘要
- 期望：模型能正确处理长上下文，保持关键信息

## 验收 Rubric
| 维度 | 评分 |
|---|---|
| 信息召回率 | 检索到的关键信息 / 总关键信息 |
| 摘要忠实度 | 摘要与原文的事实一致性 |
| 上下文窗口利用率 | 实际使用的 prompt tokens / 模型 context window |

## Fixture
- `fixture.md` — issue 描述
- `document.md` — 长文档正文（10K-100K tokens）

## 评测合同
- `taskFamily: T3`
- R8 多级摘要 L1/L2 评测必跑
- `prompt.estimatedTokens` 必须反映长文档特征

## 标签
- `long-context`
- `summarization`
- R8 评测必跑
