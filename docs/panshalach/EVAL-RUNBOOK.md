# 评测操作手册（EVAL Runbook）

> 面向「分不清那些档位/格子/label 对应什么」的人。本文只讲**怎么跑、跑了是什么**，不讲"为什么这么设计"（设计见 `EVALUATION.md` / `MEMORY-DESIGN.md` / `COMPARE-90.md`）。
> 所有评测脚本在 `scripts/eval/longmemeval-90/`，题集 90 题 = 6 题型 × 15（oracle 500 题确定性抽样）。

---

## 1. 先记住：所谓"档位"其实是 4 个正交维度

跑一次评测 = 在下面四个维度上各选一个值。混着看就乱，拆开看就清楚。

| 维度 | 取值 | 一句话 |
|---|---|---|
| **模型** | 1B / 7B / M3 | 谁在答题 |
| **harness（记忆形态）** | ZL-product / ZL-direct / ZL-pipeline / ZL-compact / CC / Pi | 记忆怎么喂给模型 |
| **代码版本** | baseline → repaired → … → token fix | 同一 harness 随代码迭代的多轮 |
| **判分口径** | strict / lenient · grader v1 / v2 / v2.1 | 怎么算分（与模型/代码无关） |

---

## 2. 模型三档

| 简称 | 模型串（`PANSHA_MODEL` / `--model`） | 端点 | 速度 |
|---|---|---|---|
| **1B** | `openpangu:openpangu-embedded-1b-i1` | 本地 LM Studio `localhost:1234` | ~3s/题 |
| **7B** | `openpangu:openpangu7b-with-medusa` | 本地 LM Studio `localhost:1234` | ~46s/题 |
| **M3** | `minimax:MiniMax-M3` | MiniMax API（`MINIMAX_API_HOST` + `MINIMAX_API_KEY`） | ~8s/题 |

---

## 3. harness 六格（两个 runner 产出）

| 格 | runner | harness × 模型 | 记忆形态 | 用途 |
|---|---|---|---|---|
| **ZL-product** | `run-product.mjs` | **烛龙产品管线** × 任意模型 | `recordChatFact` 播种 + 检索注入 | **"烛龙/ZL" 本体，日常迭代的对象** |
| ZL-direct-90 | `run-cells.mjs` | 烛龙 CLI × 1B | 人工蒸馏记忆卡内联 recall（E1） | 对照：直接喂卡不播种 |
| ZL-pipeline-90 | `run-cells.mjs` | 烛龙 CLI × 1B | haystack 原文整段内联（H1） | 对照：喂全文不提炼 |
| ZL-compact-90 | `run-cells.mjs` | 烛龙 CLI × 1B | `recordFactLines` 无门控播种 + LIMIT=40 检索（J1） | 对照：无门控播种+检索 |
| CC-90 | `run-cells.mjs` | **Claude Code** × M3 | 记忆卡 recall（A1） | **竞品参照**（需 claude CLI） |
| Pi-90 | `run-cells.mjs` | **Pi** × 1B | 记忆卡 recall（C1） | 竞品参照 |

**关键记忆点**：只有 `ZL-product`（`run-product.mjs`）是你在迭代的"烛龙"；另外 5 格是横向对照基线，基本不随迭代改动。

---

## 4. 判分口径

- **strict（主口径）**：归一化（剥标点/空白）+ gold 多候选拆分（括号/or/或）+ 复述豁免 + 短数字词边界。
- **lenient**：strict 基础上 + 数字回退（更松）。
- **grader 版本演进**（判分器本身，非模型差异）：
  - v1 → v2：加「句子子候选切分」+「短数字 token 相等」。
  - v2 → v2.1：修「词内 or 误拆产出词碎片」（CC 45→41）、「列表编号误记」。
  - **当前交付口径 = v2.1**。同一份答案不同口径分数不同；看任何分数先确认口径。

---

## 5. answer 文件 label 全归类

`answers-<label>.jsonl` 的 label，绝大多数是 **ZL-product 管线的代码版本演进**。分数均为 strict（标口径）。

### 5.1 ZL-product × 1B（代码迭代史）

| label | strict | 口径 | 代码状态 |
|---|---|---|---|
| baseline | 11 | v2 | 修复前原始代码 |
| repaired | 15 | v2 | 对抗审查修缮批次（P0-P2） |
| optimized | 17 | v2 | 0.8.4 记忆架构优化 |
| optimized2 | 20 | v2 | 0.8.5 全适用性迭代 |
| final | 17 | v2 | 同代码双样本复验（20↔17 = 1B 方差 ±3） |
| gapfix-1b | 23 | v2.1 | 差距修复轮 ← **1B 交付基线** |
| it2-1b / it3-1b | 22 / 20 | v2.1 | 归因驱动压缩检索迭代（部分回退） |
| zl-1b-90 | 19 | v2.1 | token 口径收口后（本次） |

### 5.2 ZL-product × M3

| label | strict | 口径 | 代码状态 |
|---|---|---|---|
| m3 | 31 | v2 | 0.8.5 前首测 |
| gapfix-m3 | 41 | v2.1 | 差距修复轮（追平 CC 41） |
| zl-m3-cjk15 | 46 | v2.1 | token fix + 系数 1.5（隔离对照） |
| **zl-m3-90** | **47** | v2.1 | **token fix 后（当前旗舰，新纪录）** |

### 5.3 ZL-product × 7B

| label | strict | 口径 | 说明 |
|---|---|---|---|
| 7b | 31 | v2.1 | 模型升级验证轮（本地最优交付） |
| 7b-v2 / 7b-v3 | — | — | 复验（v3 因模型调整期间被污染已作废，未入库） |

### 5.4 六格 harness 矩阵（v2 口径，未用 v2.1 重跑）

| cell | strict | 记忆形态 |
|---|---|---|
| CC-90 | 45 | Claude Code × M3 recall（v2.1 重算 = 41） |
| Pi-90 | 33 | Pi × 1B recall |
| ZL-compact-90 | 32 | 无门控播种 + LIMIT=40 |
| ZL-direct-90 | 29 | 记忆卡内联 recall |
| ZL-pipeline-90 | 23 | haystack 原文内联 |

---

## 6. 操作手册（怎么跑）

### 6.1 跑 ZL 产品管线（最常用）

```bash
cd P:/MY_codes/Pangu

# 全量 90 题（默认模型 1B）
node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label <名字>

# 换模型
node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label m3-xx --model minimax:MiniMax-M3
node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label 7b-xx --model openpangu:openpangu7b-with-medusa

# 只跑前 N 题（冒烟；N 按 questions.jsonl 文件顺序，前 18 = 15 knowledge-update + 3 multi-session）
node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label smoke18 --limit 18
```

- 答案落 `scripts/eval/longmemeval-90/answers-<label>.jsonl`。
- **断点续跑**：启动时读已有输出文件的 question_id 跳过；每题答完立即 append。同名 label 重跑会跳过已完成题。
- 加环境变量：`PANSHA_X=... node --import tsx ...`（见 §6.4）。

### 6.2 跑多 harness 对照格（run-cells.mjs）

```bash
cd P:/MY_codes/Pangu
node --import tsx scripts/eval/longmemeval-90/run-cells.mjs --cell ZL-direct-90
node --import tsx scripts/eval/longmemeval-90/run-cells.mjs --cell ZL-pipeline-90
node --import tsx scripts/eval/longmemeval-90/run-cells.mjs --cell ZL-compact-90
node --import tsx scripts/eval/longmemeval-90/run-cells.mjs --cell CC-90
node --import tsx scripts/eval/longmemeval-90/run-cells.mjs --cell Pi-90
```

- **无 `--limit`**，固定跑满 90 题；模型也按格子写死（ZL-* / Pi = 1B，CC = claude CLI + M3）。
- 依赖：CC-90 需本机 `claude` CLI；ZL-* / Pi 需本地 LM Studio 1B 在线。
- 若只想跑子集，需临时改 `questions.jsonl`（runner 无子集参数）。

### 6.3 判分

```bash
cd P:/MY_codes/Pangu

# 单格成绩
node scripts/eval/longmemeval-90/grade.mjs answers-<label>.jsonl

# 双格同题 A/B 对照（逐题型差值 + 逐题翻转 win/loss）
node scripts/eval/longmemeval-90/grade.mjs answers-A.jsonl answers-B.jsonl
```

输出：终端透视表 + 覆盖写 `GRADE.md`（分题型透视）+ `graded.jsonl`（逐题分数）。

### 6.4 上下文相关的 env 开关（"不同上下文"怎么调）

这些开关通过 `process.env` 透传给 QA 子进程。用法：`PANSHA_X=v node --import tsx .../run-product.mjs --label ...`。

| env | 取值 | 作用 | 典型场景 |
|---|---|---|---|
| `PANSHA_MODEL` | 模型串 | 指定模型（同 `--model`） | 换模型 |
| `PANSHA_NO_MEMORY` | `1` | 零记忆注入（跳过记忆卡，B 档防线失败基线） | 测"无记忆"朴素 agent 基线 |
| `PANSHA_MEMORY_LIMIT` | 数字 | 显式记忆注入张数帽 | 测不同注入预算（如 40） |
| `PANSHA_SEMANTIC_SEARCH` | `0` | 关闭语义检索（纯词面） | 测语义检索的贡献 |
| `PANSHA_MMR` | `1` | 启用 MMR 近重复惩罚（默认关） | 测多样性重排（强模型 A/B） |
| `PANSHA_CTX_WINDOW` | 数字 | 覆盖上下文窗口（tokens） | 测不同窗口下记忆外置价值 |
| `PANSHA_CJK_TOKENS` | 数字 | CJK token 系数（默认 1.0） | 隔离 token 估算影响（1.5 vs 1.0） |
| `PANSHA_NO_BUDGET_TRIM` | `1` | 禁用主动窗口裁剪（评测逃生门） | 让真溢出可达网关 |
| `PANSHA_MESSAGES_MODE` | `off` | 强制文本路径（`complete(prompt)`） | 测文本通道（vs messages 通道） |
| `PANSHA_CHAT_MEMORY` | `0` | 关闭 chat 记忆落卡 | 测 chat-fact 记忆贡献 |
| `PANSHA_INTENT_GATE` | `0` | 关闭意图分类（全按 execution） | 逃生门 |
| `PANSHA_LME_TIMEOUT_MS` | 毫秒 | 单题超时线（run-product.mjs，默认 180000） | 7B 慢模型放大超时 |
| `PANSHA_DEBUG_STEPS` | `1` | 每步原始输出/解析结果 dump 到 stderr | 弱模型工具配合度调优 |

### 6.5 典型场景速查

```bash
# ① 无记忆基线（零注入，测朴素 agent）
PANSHA_NO_MEMORY=1 node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label nomem-1b

# ② 限制记忆注入预算（40 张，复刻 ZL-compact 的检索档）
PANSHA_MEMORY_LIMIT=40 node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label mem40-1b

# ③ 纯词面检索（关语义）
PANSHA_SEMANTIC_SEARCH=0 node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label lexical-1b

# ④ 单变量隔离：回退 CJK 系数到 1.5（token fix 归因用）
PANSHA_CJK_TOKENS=1.5 node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label cjk15-m3 --model minimax:MiniMax-M3

# ⑤ 18 题快速冒烟（前 18 题）
node --import tsx scripts/eval/longmemeval-90/run-product.mjs --label smoke18 --limit 18
```

---

## 7. 前置依赖与检查

| 依赖 | 检查命令 | 说明 |
|---|---|---|
| 本地 1B 在线 | `curl http://localhost:1234/v1/models` | 跑 1B / ZL-* / Pi 格必需 |
| 本地 7B 在线 | 同上，看返回 id 是否 7B | 跑 7B 必需 |
| M3 API | `curl -s -o /dev/null -w "%{http_code}" -X POST https://api.minimaxi.com/v1/chat/completions -H "Authorization: Bearer $MINIMAX_API_KEY" -H "Content-Type: application/json" -d '{"model":"MiniMax-M3","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'` | 应返回 200；跑 M3 / CC 必需 |
| Claude Code CLI | `claude --version` | 跑 CC-90 必需 |
| oracle 数据 | `scripts/eval/longmemeval/data/longmemeval_oracle.json` 存在 | 播种需要 haystack_sessions |
| 题集 | `scripts/eval/longmemeval-90/questions.jsonl`（90 行） | 缺则先 `node scripts/eval/longmemeval-90/sample.mjs` |

> 注：`run-product.mjs` 与 `run-cells.mjs` 都要求 `node --import tsx`（同源 import 产品模块 `chatFactMemory.js`）。

---

## 8. 附：本轮归因结论（2026-09-15）

token 口径收口（`9fe0cf9`）后复验，同 runner 同播种：

| 配置 | strict | 归因 |
|---|---|---|
| gapfix-m3（差距修复轮） | 41/90 | 基线 |
| → zl-m3-cjk15（系数 1.5） | 46/90 | +5 = 记忆/检索迭代（factDate 重排/C4 数字句前置/R2 预算/B9 relTime/MMR 默认关闭） |
| → zl-m3-90（系数 1.0） | 47/90 | +1 = token fix 系数改动 |

token fix 是正确性收口、非提分杠杆（1B 0 / M3 +1，均噪声内）；M3 47/90 新纪录主要来自记忆/检索迭代。详见 `COMPARE-90.md` 附录与 `CHANGELOG.md` 0.8.7。
