# LME 90 题交叉对比报告（COMPARE-90）

> 生成：2026-09-13 · 修复后代码（zhaiyuanhao1 b4c2067+）· 判分：grade.mjs（strict 主口径：normalize+多候选拆分+复述豁免+词边界；lenient=数字回退）· 题集：oracle 500 题确定性抽样 15/型×6（48 题集的超集）
> 记忆卡：lme-<qid>.md 90/90（48 复用 + 42 张 claude×M3 蒸馏）· 端点：本地 LM Studio openpangu-embedded-1b-i1 / MiniMax-M3 API

## 总表（strict / lenient，90 题）

| 格 | harness × model | 记忆形态 | strict | lenient | 平均耗时 | timeout |
|---|---|---|---|---|---|---|
| baseline | 烛龙产品管线 × 1B（修复前 6395bae） | recordChatFact 播种+产品注入 | **9/90 (10.0%)** | 16/90 | 6.4s | 0 |
| repaired | 烛龙产品管线 × 1B（修复后） | 同上 | **13/90 (14.4%)** | 18/90 | 6.4s | 0 |
| ZL-direct-90 | 烛龙 CLI × 1B | 记忆卡内联 recall（E1 范式） | **20/90 (22.2%)** | 29/90 | 7.0s | 0 |
| ZL-pipeline-90 | 烛龙 CLI × 1B | haystack 原文内联（H1 范式） | **14/90 (15.6%)** | 27/90 | 12.4s | 0 |
| ZL-compact-90 | 烛龙 CLI × 1B | recordFactLines 无门控播种 + LIMIT=40 检索（J1 范式） | **26/90 (28.9%)** | 32/90 | 7.7s | 0 |
| CC-90 | Claude Code × MiniMax-M3 | 记忆卡 recall（A1 范式） | **31/90 (34.4%)** | 38/90 | 7.1s | 0 |
| Pi-90 | Pi × 1B | 记忆卡 recall（C1 范式） | **20/90 (22.2%)** | 27/90 | 2.9s | 0 |

分题型 strict 透视（节选）见 GRADE.md；逐题分数见 graded.jsonl。

## 结论

1. **修复 A/B（同 runner 同播种，唯一差异=src 代码版本）**：strict 9→13（+44% 相对），增量全部集中在 single-session-user（1→5）。零回归题型、零 timeout。修复中起作用的：chat-fact 去重修复（跨分钟重复卡不再挤占）与容量语义（OTHER 10 张帽→preference 80），平均落卡 8.3→9.0。knowledge-update lenient 7→3 为数字回退口径噪声（strict 持平 4/15）。
2. **1B 同侪对比**：修复后烛龙产品管线 13 仍落后 Pi recall（20）与自家 ZL-direct（20）。差距主因不是 harness 而是记忆形态——产品管线经 recordChatFact 噪音门（isFactSentence 等）过滤后落卡少（平均 9 张），而 ZL-direct 直接内联人工蒸馏的结构化记忆卡。
3. **烛龙系 1B 最强配置是 ZL-compact（26/90）**：无门控播种 + 检索注入。它在 multi-session（6/15）与 temporal-reasoning（4/15）上甚至超过 CC×M3（4/15、2/15）——检索注入对"多会话聚合/时间推理"类题型优于 CC 的静态记忆卡 recall。这印证审查结论：**产品召回瓶颈在写入门控质量（isFactSentence/第一人称判据），而非检索排序本身**；G4（语义检索接线）与写入门控升级是下一步杠杆。
4. **模型规模差**：CC×M3 31/90 (34.4%) 领先全部 1B 格（13–26），但其在 temporal-reasoning 仅 2/15（lenient 9/15 说明大量数字近似命中被 strict 判负）。M3 与 1B 的绝对分不可直接归因 harness。
5. **结构性判分盲区（48 题已证实，90 题重现）**：single-session-preference 全格 strict ≤1/15——gold 为自由文本偏好句，子串匹配天然失效；preference 的提升需 LLM-judge 或 rubric 实词覆盖率口径（judge-rubric 思路），不宜据此判 harness 优劣。
6. **成本与速度**：Pi×1B 最快（2.9s/题）；ZL-pipeline 最慢且最弱（haystack 原文内联 12.4s/题，14/90）——"喂全文"在 1B 上不如"喂结构化事实"，与 48 题结论一致。

## 与 48 题历史锚点的可比性

90 题集包含 48 题集全部题目（前 8/型 ⊂ 前 15/型），但新增 42 题改变题型内分布，总分不可与 COMPARE-48 直接比。同范式对照：J1(48)=33% ↔ ZL-compact(90)=28.9%；A1(48)=42% ↔ CC(90)=34.4%；方向一致，稀释合理。

## 复现

```bash
node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label repaired   # 产品管线格
node --import tsx scripts/eval/longmemeval-90/run-cells.mjs --cell ZL-compact-90 # 其余五格
node scripts/eval/longmemeval-90/grade.mjs answers-baseline.jsonl answers-repaired.jsonl ...
```
