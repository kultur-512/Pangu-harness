# T3 Fixture — 实体化指针（U3 周末起 issue + verify.sh）

> 状态：U3 周末（赵天昂 2026-09-06）起 issue.md + verify.sh
> 下一步：U4 王浩宇补 `document.md`（10K-50K tokens 长文档）+ 加 keyword 召回检查
> U6 真机 openPangu 端点跑分时使用，R8 多级摘要 L1/L2 评测必跑

## Prompt 加载（runner 契约）

run-eval.mjs 的 prompt 源 = `issue.md`（指针加载，正文整体作为 prompt）。
本文件不再承载 issue 正文，仅做实体化指针。

## 实体文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `README.md` | ✅ 已落 | T3 任务族契约（长文档场景、Rubric、评测合同） |
| `issue.md` | ✅ 已落 | 中文长程维护场景的 Q1/Q2/Q3 摘要 issue（**prompt 源**） |
| `verify.sh` | ✅ 已落 | 4 条基础检查：3 个标题 + 全文/Q1/Q3 字节上限（PASS 6/6） |
| `document.md` | ⏳ 待 U4 | 10K-50K tokens 长文档 |
| `fixture.md` | ✅ 本文件 | 实体化指针（取代早期"U4 王浩宇实体化"占位） |

## 任务骨架（issue.md 同步）

模型从 `document.md` 抽取 3 个问题的答案写入 `answers.md`：
- `### Q1`：第 1 章核心主题（≤ 100 字中文）
- `### Q2`：第 3 章关键人物及其贡献（列表）
- `### Q3`：整篇主要结论（≤ 200 字中文）

全文总字符数 ≤ 800 字。

## verify.sh 字符数 vs 字节数说明

issue.md 措辞为"≤ N 字"，但 Git Bash `wc -m` 不数 UTF-8 字符（按字节算）。
verify.sh 用 awk `length` 字节数近似：1 中文字符 ≈ 3 字节（UTF-8）+ 换行/空格余量。

| issue.md 措辞 | verify.sh 字节上限 |
|---|---|
| Q1 ≤ 100 字 | ~350 字节 |
| Q3 ≤ 200 字 | ~700 字节 |
| 全文 ≤ 800 字 | ~2400 字节 |

## U4 王浩宇负责

1. 创建 `document.md`（10K-50K tokens 长文档，章节清晰：第 1 章主题 / 第 3 章人物 / 结论）
2. 在 verify.sh 末尾追加 keyword 召回检查（模板见 verify.sh 注释）：
   ```bash
   check "T3-r1 recall keyword X" 'grep -q "<keyword>" "$1"' "$F"
   check "T3-r2 recall keyword Y" 'grep -q "<keyword>" "$1"' "$F"
   ```

## U4 强化方向（wanghaoyu 草案模式并入）

wanghaoyu 58abf64 草案的 T3 实例为仓库内修改型（sseInteractive.ts 定位
SSE done 回调追加 `[eval] refined:` 日志 + `npx tsc --noEmit` 编译门），
未被本实例 verify.sh 覆盖，正文见 git 历史（58abf64 :3 版 fixture.md）。
"目标代码定位 + 格式断言 + 编译门"检查可作为 U4 强化模板
（大文件 ~98KB 定位场景与长文档检索能力同源）。

## 与 R8 评测合同对齐

- `taskFamily: T3`
- 期望 `verdict: completed` + `verification.signal: PASS`
- `prompt.estimatedTokens` 必须 > 10K（长文档特征）
- R8 多级摘要 L1/L2 评测必跑
