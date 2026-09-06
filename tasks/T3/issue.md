# T3 — 长文档关键信息检索与摘要（长文档任务实例）

> 任务族：T3 长文档处理（long document）
> Fixture 状态：U3 周末草稿（赵天昂起 issue） / U4 由王浩宇补 `document.md` 与 `verify.sh` 强化
> U6 真机 openPangu 端点跑分时使用，R8 多级摘要 L1/L2 评测必跑

## 场景

你需要从 `./document.md`（10K-50K tokens，U4 由王浩宇提供）中**抽取关键信息并生成结构化摘要**。
这是 R8 多级摘要 L1/L2 envelope 的典型评测场景：长上下文下模型的信息保持能力 + 摘要忠实度。

请你按顺序回答以下 **3 个问题**，并将答案写入 `answers.md`：

1. **Q1（核心主题）**：文档第 1 章讨论的核心主题是什么？限 100 字以内。
2. **Q2（关键人物）**：文档第 3 章提到的关键人物有哪些？每个人的核心贡献是什么？列表形式。
3. **Q3（主要结论）**：整篇文档的主要结论是什么？限 200 字以内。

## 文件结构（U4 由王浩宇补 `document.md`）

```
tasks/T3/
├── README.md
├── issue.md           # 本文件
├── document.md        # 10K-50K tokens 长文档（U4 由王浩宇提供）
└── verify.sh          # 验证脚本
```

## 期望产出

- 工作目录存在 `answers.md` 文件
- `answers.md` 包含 3 个三级标题：`### Q1` / `### Q2` / `### Q3`（顺序固定）
- Q1 答案 ≤ 100 字，Q3 答案 ≤ 200 字
- 全文总字符数 ≤ 800 字（摘要忠实度边界）
- 关键人物列表完整无遗漏（基于真实 document.md 的事实召回）

## 验收 Rubric

| 维度 | 度量 |
|---|---|
| 信息召回率 | 检索到的关键信息 / 总关键信息 |
| 摘要忠实度 | 摘要与原文的事实一致性（人工评审） |
| 上下文窗口利用率 | 实际使用的 prompt tokens / 模型 context window |
| 格式合规率 | 三级标题存在 + 字符数限制满足 |

## 评测合同

- `taskFamily: T3`
- `verification.commands` 至少包含 `verify.sh`
- 期望 `verdict: completed` + `verification.signal: PASS`
- `prompt.estimatedTokens` 必须反映长文档特征（>10K）
- R8 多级摘要 L1/L2 评测必跑

## 标签

- `long-context`
- `summarization`
- R8 评测必跑

## 实现备注

verify.sh 当前为 stub（U4 由王浩宇补）：
- 基础检查：3 个三级标题存在 + 字符数 ≤ 800
- 召回率检查：U4 王浩宇根据真实 document.md 的关键词清单加 grep 断言
