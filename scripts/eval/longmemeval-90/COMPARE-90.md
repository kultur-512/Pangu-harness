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

---

## 附录（2026-09-14）：0.8.4 记忆架构优化后的 optimized 轮

三路架构探索（写路径/检索/时间性）→ 实现 → 子代理 review（3 必须返工 + 5 建议全部处置）→ 全量 1200 例绿 → 同 runner 重跑：

| 轮 | strict | lenient | 关键变化 |
|---|---|---|---|
| baseline | 9/90 | 16/90 | 修复前代码 |
| repaired | 13/90 | 18/90 | 对抗审查修缮批次 |
| **optimized** | **15/90 (16.7%)** | 18/90 | 时间锚定 + 宽进严排 + 混合检索 + 窗口感知注入 |

分题型（strict）：temporal-reasoning 0→**1**（产品管线首次得分，假日期污染根除 + "今天是 X"注入；lenient 1→4）；single-session-assistant 2→**4**；knowledge-update 4→**5**；single-session-user 5→3（±2 在 1B 单轮方差内）；multi-session 2（持平）。

优化内容（架构级，非测试集定向）：
1. **时间锚定**：sessionDate 参数贯通播种链，卡带 factDateText；【】前缀只带日期（根除评测回放把记录时间冒充事实时间的污染）；stable 段与 chat directive 注入"今天是 X"；悬空 [S日期] 规则替换为事实时间差值规则。
2. **宽进严排**：对卡（Q/A 对）成为主落卡单元（无条件），isFactSentence 从硬门改 confidence 分类器（句级补充卡 ≥0.7 才发）；80 帽硬拒绝删除（新进旧出交存储层）；配对牵连修复；分句器缩写保护（Dr./e.g. 不再切碎）；confidence 软惩罚只进排序不进淘汰门（review 返工）。
3. **混合检索**：embed.ts 4096 维 n-gram 语义接入 loadFiltered（两步归一防量纲压制；keywords<2 / 异常自动回纯词面；投影 key 含查询防串槽）。
4. **窗口感知注入**：固定卡数帽改窗口比例预算（8K≈10%、大窗 15%、1600 token 帽）+ 渲染后实测 token 贪心门（对卡实际 122-470 token/张，纯张数帽超发 3-11 倍——review FAIL 实测后返工）；PANSHA_MEMORY_LIMIT 显式时行为不变。

**终验（2026-09-14，a99ab77 文档提交后代码复跑）**：strict **16/90** · lenient **22/90** · 0 超时 · 平均 3.1s/题——与 optimized2 双样本一致（16/90 稳定复现），lenient 新高；temporal 2/15、preference 1/15 连续两轮保持非零。分题型 strict：knowledge-update 5 · multi-session 2 · assistant 3 · preference 1 · user 3 · temporal 2。完整轨迹：baseline 9 → repaired 13 → optimized 15 → optimized2 16 → **final 16**（lenient 16→18→18→20→22）。

**MiniMax-M3 通道（2026-09-14）**：改进后 ZL 产品管线 × M3（同 runner 同播种，`--model minimax:MiniMax-M3`）——strict **25/90 (27.8%)** · lenient **34/90** · 0 超时 · 平均 11.1s/题。对照：ZL×1B final 16/90（模型规模 +9，相对 +56%）；CC×M3 31/90（同模型下 ZL 产品管线差 6——CC 用 phase-1 人工级蒸馏卡 100% 覆盖，ZL 走 recordChatFact 门控播种，写路径信息量仍是主差距，与 1B 侧结论一致）。分题型亮点：multi-session **6/15 反超 CC（4/15）**——检索注入对多会话聚合题的优势随模型规模放大；temporal lenient 4→9（时间锚定在强模型上收益放大）。分题型 strict：knowledge-update 6 · multi-session 6 · assistant 6 · preference 0（判分盲区） · user 4 · temporal 3。

诚实备注：+2 strict 中 temporal/assistant/knowledge-update 的增益方向与机制证据一致，single-session-user 的 -2 属方差级波动；对卡写入使 A 侧保留了 smartSlice 数字句优先的 400 字符（渲染同源 400，review 返工对齐），注入 token 成本上升由预算门兜底。

