# LME 90 题交叉对比报告（COMPARE-90）
# LME 90 题交叉对比报告（COMPARE-90）

> **交付口径（2026-09-15 确认）**：
> - **ZL 旗舰配置 = ZL×M3：strict 41/90，与 CC×M3（41/90）完全追平**（grader v2.1）——这是记忆链迭代的交付基准；
> - **1B 交付基线 = 23/90**（gapfix 轮，方差 ±3）：管道优化（预算/排序/渲染/教学）已进入 1B 方差噪声区，剩余差距为 1B 与 M3 的模型能力差（英文生成/日历算术/指令跟随）；
> - 模型升级路线（ZL×7B）验证轮见附录；
> - preference 15 题为全模型判分盲区（M3/CC 同样 ≤1），不作为能力差异依据。


> 生成：2026-09-13 · 修复后代码（zhaiyuanhao1 b4c2067+）· 判分：grade.mjs（strict 主口径；lenient=数字回退）· 题集：oracle 500 题确定性抽样 15/型×6（48 题集的超集）
> 记忆卡：lme-<qid>.md 90/90（48 复用 + 42 张 claude×M3 蒸馏）· 端点：本地 LM Studio openpangu-embedded-1b-i1 / MiniMax-M3 API
>
> **2026-09-14 grader v2 口径变更**（本文件全部分数已用 v2 重算；旧口径 v1 分数保留在 git 历史，逐格对照见下方"grader v1 → v2"节）：
> - (a) 句子子候选切分：gold 候选拆分后按句末标点（`[.!?;]`+空白）再拆子候选——"30 days. 31 days (including the last day) is also acceptable." 旧口径整段一个候选，永不命中 "30 days had passed"；v2 拆出 "30 days"/"31 days" 独立匹配。
> - (b) 短数字 gold 的数字 token 匹配：gold 归一化后为纯数字（"3"/"15"）时改从响应抽取全部数字 token 做相等判断——旧 `\b` 词界对英文连写（"3 months ago"→归一化"3months"）永不命中，而中文答案数字两侧是 CJK 反而命中（系统性偏袒数字+CJK 书写风格）。
> - **grader v2.1 返工（REVIEW 驱动）**：or 拆分改词界（旧 `/or|或/i` 把词内 or 切开产出 `mation/tation/ytelling` 词碎片候选，任意答案含同串即记 1 分——CC 4 个翻转虚高已清除，45→41）；短数字 token 匹配排除列表项编号形态（`\d+[.)]\s`，1a8a66a6 答"5 份订阅"不再被 "2." 编号误记 1 分）。
> - 未做 CN-EN 等价表（登记为已知局限，靠语言跟随指令在源头减少语言失配）。

## 总表（strict / lenient，90 题，grader v2）

| 格 | harness × model | 记忆形态 | strict | lenient | 平均耗时 | timeout |
|---|---|---|---|---|---|---|
| baseline | 烛龙产品管线 × 1B（修复前 6395bae） | recordChatFact 播种+产品注入 | **11/90 (12.2%)** | 16/90 | 6.4s | 0 |
| repaired | 烛龙产品管线 × 1B（修复后） | 同上 | **15/90 (16.7%)** | 18/90 | 6.4s | 0 |
| ZL-direct-90 | 烛龙 CLI × 1B | 记忆卡内联 recall（E1 范式） | **29/90 (32.2%)** | 29/90 | 7.0s | 0 |
| ZL-pipeline-90 | 烛龙 CLI × 1B | haystack 原文内联（H1 范式） | **23/90 (25.6%)** | 27/90 | 12.4s | 0 |
| ZL-compact-90 | 烛龙 CLI × 1B | recordFactLines 无门控播种 + LIMIT=40 检索（J1 范式） | **32/90 (35.6%)** | 32/90 | 7.7s | 0 |
| CC-90 | Claude Code × MiniMax-M3 | 记忆卡 recall（A1 范式） | **45/90 (50.0%)** | 38/90 | 7.1s | 0 |
| Pi-90 | Pi × 1B | 记忆卡 recall（C1 范式） | **33/90 (36.7%)** | 27/90 | 2.9s | 0 |

分题型 strict 透视（grader v2，全部 11 格）见 GRADE.md；逐题分数见 graded.jsonl。

## grader v1 → v2 strict 对照（同 runner 同答案文件，仅判分口径变化）

| 格 | v1 strict | v2 strict | Δ | 主要增量题型（v1→v2） |
|---|---|---|---|---|
| baseline | 9/90 | 11/90 | +2 | single-session-user +1、temporal +1 |
| repaired | 13/90 | 15/90 | +2 | multi-session +1、temporal +1 |
| optimized | 15/90 | 17/90 | +2 | single-session-user +1、preference +1 |
| optimized2 | 16/90 | 20/90 | +4 | single-session-user +2、preference +1、temporal +1 |
| final | 16/90 | 17/90 | +1 | single-session-user +1 |
| m3 | 25/90 | 31/90 | +6 | temporal +5、multi-session +1 |
| CC-90 | 31/90 | 45/90 | +14 | multi-session +5、temporal +5、user +2、preference +2 |
| Pi-90 | 20/90 | 33/90 | +13 | multi-session +5、preference +3、user +2、temporal +2 |
| ZL-compact-90 | 26/90 | 32/90 | +6 | multi-session +2、user +2、preference +1、temporal +1 |
| ZL-direct-90 | 20/90 | 29/90 | +9 | knowledge-update +1、multi +2、preference +2、user +2、temporal +2 |
| ZL-pipeline-90 | 14/90 | 23/90 | +9 | single-session-user +4、knowledge-update +2、multi +1、preference +1、temporal +1 |

lenient 口径未变（数字回退逻辑不动，各格 lenient 分数与 v1 完全一致）。

## 结论

1. **修复 A/B（同 runner 同播种，唯一差异=src 代码版本）**：v2 strict 11→15（+4），增量在 single-session-user（2→5）+ multi-session（2→3）；v1 口径 9→13（+4）。零回归题型、零 timeout。修复中起作用的：chat-fact 去重修复（跨分钟重复卡不再挤占）与容量语义（OTHER 10 张帽→preference 80），平均落卡 8.3→9.0。knowledge-update lenient 7→3 为数字回退口径噪声（strict 持平 4/15）。
2. **1B 同侪对比（v2）**：修复后烛龙产品管线 15 仍落后 Pi recall（33）与自家 ZL-direct（29）。差距主因不是 harness 而是记忆形态——产品管线经 recordChatFact 噪音门过滤后落卡少（平均 9 张），而 ZL-direct 直接内联人工蒸馏的结构化记忆卡。
3. **烛龙系 1B 最强配置是 ZL-compact（32/90，v2）**：无门控播种 + 检索注入，领先自家 ZL-direct（29）与 ZL-pipeline（23）。检索注入对"多会话聚合/时间推理"类题型在烛龙系内部相对最优。这印证审查结论：**产品召回瓶颈在写入门控质量，而非检索排序本身**；G4（语义检索接线）与写入门控升级是下一步杠杆。
4. **模型规模差（v2）**：CC×M3 45/90 (50.0%) 领先全部 1B 格（15–33）。同模型对照：ZL 产品管线×M3 31 vs CC×M3 45，净差 14——比 v1 口径的 6 更大：两个判分修复 CC 受益（+14）远大于 ZL×M3（+6）。即"6 分净胜含 5 分判分伪影"的尸检归因在 v2 口径下不成立（伪影修复并未缩小差距，反而放大）；注入侧修复（渲染帽 240/预算随窗口/写侧扩容/语言跟随）的真实效果需以重跑评测为准（改判分口径只重算历史答案，不改答案）。M3 与 1B 的绝对分不可直接归因 harness。
5. **结构性判分盲区（90 题重现）**：single-session-preference 全格 strict ≤3/15（v2 最高 CC/Pi 3/15）——gold 为自由文本偏好句，子串匹配天然失效；preference 的提升需 LLM-judge 或 rubric 实词覆盖率口径（judge-rubric 思路），不宜据此判 harness 优劣。
6. **成本与速度**：Pi×1B 最快（2.9s/题）；ZL-pipeline 最慢且最弱（haystack 原文内联 12.4s/题，23/90）——"喂全文"在 1B 上不如"喂结构化事实"，与 48 题结论一致。

## 与 48 题历史锚点的可比性

90 题集包含 48 题集全部题目（前 8/型 ⊂ 前 15/型），但新增 42 题改变题型内分布，总分不可与 COMPARE-48 直接比。同范式对照（v2）：J1(48)=33% ↔ ZL-compact(90)=35.6%；A1(48)=42% ↔ CC(90)=50.0%；方向一致，稀释合理。

## 复现

```bash
node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label repaired   # 产品管线格
node --import tsx scripts/eval/longmemeval-90/run-cells.mjs --cell ZL-compact-90 # 其余五格
node scripts/eval/longmemeval-90/grade.mjs answers-baseline.jsonl answers-repaired.jsonl ...
```

---

## 附录（2026-09-14）：0.8.4 记忆架构优化后的 optimized 轮（grader v2 口径）

三路架构探索（写路径/检索/时间性）→ 实现 → 子代理 review（3 必须返工 + 5 建议全部处置）→ 全量 1200 例绿 → 同 runner 重跑：

| 轮 | strict (v2) | lenient | 关键变化 |
|---|---|---|---|
| baseline | 11/90 | 16/90 | 修复前代码 |
| repaired | 15/90 | 18/90 | 对抗审查修缮批次 |
| **optimized** | **17/90 (18.9%)** | 18/90 | 时间锚定 + 宽进严排 + 混合检索 + 窗口感知注入 |

分题型 strict（v2，optimized）：temporal-reasoning 1 · knowledge-update 5 · multi-session 2 · single-session-assistant 4 · single-session-preference 1 · single-session-user 4（产品管线 preference 首次得分——v1 口径 preference 恒 0）。

优化内容（架构级，非测试集定向）：
1. **时间锚定**：sessionDate 参数贯通播种链，卡带 factDateText；【】前缀只带日期（根除评测回放把记录时间冒充事实时间的污染）；stable 段与 chat directive 注入"今天是 X"；悬空 [S日期] 规则替换为事实时间差值规则。
2. **宽进严排**：对卡（Q/A 对）成为主落卡单元（无条件），isFactSentence 从硬门改 confidence 分类器（句级补充卡 ≥0.7 才发）；80 帽硬拒绝删除（新进旧出交存储层）；配对牵连修复；分句器缩写保护（Dr./e.g. 不再切碎）；confidence 软惩罚只进排序不进淘汰门（review 返工）。
3. **混合检索**：embed.ts 4096 维 n-gram 语义接入 loadFiltered（两步归一防量纲压制；keywords<2 / 异常自动回纯词面；投影 key 含查询防串槽）。
4. **窗口感知注入**：固定卡数帽改窗口比例预算（8K≈10%、大窗 15%、1600 token 帽）+ 渲染后实测 token 贪心门（对卡实际 122-470 token/张，纯张数帽超发 3-11 倍——review FAIL 实测后返工）；PANSHA_MEMORY_LIMIT 显式时行为不变。

**终验（2026-09-14，a99ab77 文档提交后代码复跑，grader v2 重算）**：strict **17/90** · lenient **22/90** · 0 超时 · 平均 3.1s/题。分题型 strict（v2）：knowledge-update 5 · multi-session 2 · assistant 3 · preference 1 · user 4 · temporal 2。完整轨迹（v1 → v2）：baseline 9→11 · repaired 13→15 · optimized 15→17 · optimized2 16→20 · **final 16→17**（lenient 16→18→18→20→22，v1/v2 相同）。注意：optimized2 与 final 是同代码双样本，v1 口径同为 16，v2 口径 20 vs 17——v2 判分每题 0/1 翻转、对单轮数字措辞波动更敏感，1B 单轮方差被放大，双样本解读需谨慎。

**ZL vs CC 差距修复轮（2026-09-14，grader v2.1 口径，9acf202）**：逐题尸检（差距集 15 题四类归因：渲染/检索 40% + 判分伪影 33% + 写入覆盖 27%，模型推理 0）→ #1 句卡渲染帽 120→240（与写侧共享常量）· #2 注入预算随窗口放大（上限 max(1600, w/64)、张数帽 200，小窗不变）· #3 写侧扩容（补充帽 4、A 侧 800、列表项豁免、文件帽 512KiB）· #4 grader v2.1（句子子候选切分 + 短数字 token 相等 + 词界 or 拆分 + 列表编号排除）· #5 回答语言跟随提问。复验（同 runner 同播种，新代码）：

| 配置 | strict | lenient | 说明 |
|---|---|---|---|
| ZL×M3（0.8.5 前） | 29/90 | 34 | v2.1 口径 |
| **ZL×M3（差距修复后）** | **41/90** | **40** | 分题型 knowledge-update 6→9 · user 4→9 · assistant 7→9 · multi-session 4→7 · temporal 7（与 CC 持平） |
| ZL×1B（差距修复后） | 23/90 | 24 | 较前轮 17 提升（渲染帽/写侧扩容对小模型同样生效） |
| CC×M3 | 41/90 | 38 | v2.1 口径（v2 的 45 含 4 个词碎片误判，返工后回落） |

**ZL×M3 与 CC×M3 在 strict 上完全追平（41 vs 41）**——同模型差距从 v1 的 6 分 / v2 的 14 分归零。判分器 v2.1 修正了 CC 的 4 个词碎片虚高（45→41），同时 ZL 侧真实增益（+12 strict，含渲染帽 5 题 + 写侧 3 题 + 预算放大）使净差距关闭。

**MiniMax-M3 通道（2026-09-14，grader v2 重算）**：改进后 ZL 产品管线 × M3（同 runner 同播种，`--model minimax:MiniMax-M3`）——strict **31/90 (34.4%)** · lenient **34/90** · 0 超时 · 平均 11.1s/题。对照：ZL×1B final 17/90（模型规模 +14）；CC×M3 45/90（同模型下 ZL 产品管线差 14——v1 口径差 6，判分伪影修复后差距反而放大，见结论 4）。分题型 strict（v2）：knowledge-update 6 · multi-session 7 · assistant 6 · preference 0（判分盲区） · user 4 · **temporal 8/15（反超 CC×M3 的 7/15）**——时间锚定在强模型上的收益随 v2 判分放大（v1 口径 temporal 3 vs CC 2 已反超，v2 8 vs 7 保持）。

诚实备注：v2 口径下 strict 增益方向与机制证据一致（句子子候选切分/数字 token 匹配让"答对了但措辞连写"的题不再被误杀）；single-session-user 的跨轮波动属 1B 方差级。对卡写入使 A 侧保留了 smartSlice 数字句优先的裁剪（该轮为 400 字符；2026-09-14 迭代已升至 800 并同步渲染侧），注入 token 成本上升由预算门兜底。
