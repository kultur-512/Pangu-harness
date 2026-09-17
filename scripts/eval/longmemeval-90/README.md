# 90 题矩阵评测使用手册（README）

> 本目录是 LongMemEval-90（6 题型 × 15 题）评测的全部入口。**评测产出（answers/matrix/grade 文件）不入 git**；历史数据归档在仓库根 `eval-archive/`，可用 `node scripts/eval/archive-eval-artifacts.mjs` 再次归档。

## 模型与配置

| 别名 | 模型串 | 端点 | 配置方式 | 速度 |
|---|---|---|---|---|
| `1B` | `openpangu:openpangu-embedded-1b-i1` | 本地 LM Studio `http://localhost:1234/v1` | `.panshalach.json` providers.openpangu（或项目配置） | ~3s/题 |
| `7B` | `openpangu:openpangu7b-with-medusa` | 本地 LM Studio `http://localhost:1234/v1` | 同上 | ~100s/题 |
| `M3` | `minimax:MiniMax-M3` | `https://api.minimaxi.com/v1` | 环境变量 `MINIMAX_API_KEY`（或 `PANSHA_MINIMAX_API_KEY`/`_BASE_URL`/`_MODEL` 三件套） | ~8s/题 |

前置数据（已入库，勿删）：`../longmemeval/data/longmemeval_oracle.json`（oracle 数据集）、`questions.jsonl`（90 题题集，可用 `sample.mjs` 重新抽样）、`haystacks/*.md`（记忆卡蒸馏输入）。
所有评测子进程自动注入 `PANSHA_EVAL=1`：评测运行不向任何工作区写记忆卡（防评测残留污染）。

## 六种 harness

| harness | runner | 记忆形态 | 模型 |
|---|---|---|---|
| **ZL-product**（烛龙产品管线） | `run-product.mjs` | `recordChatFact` 在线播种 + 产品检索注入 | 任意（1B/7B/M3） |
| ZL-direct | `run-cells.mjs --cell ZL-direct-90` | 人工蒸馏卡内联 recall | 任意 |
| ZL-pipeline | `run-cells.mjs --cell ZL-pipeline-90` | haystack 原文内联 | 任意 |
| ZL-compact | `run-cells.mjs --cell ZL-compact-90` | 无门控播种 + 检索注入 | 任意 |
| CC-90 | `run-cells.mjs --cell CC-90` | Claude Code 记忆卡 recall | M3（**前置**：claude CLI 已配置指向 M3 端点） |
| Pi-90 | `run-cells.mjs --cell Pi-90` | Pi 记忆卡 recall | 1B（**前置**：pi CLI 已安装 + 本地端点在线） |

## 快速开始

```bash
# 0. 冒烟（每题型 1 题，共 6 题）——全量前必跑
node --import tsx scripts/eval/longmemeval-90/smoke-90.mjs --kind product --model M3

# 1. 全量矩阵（断点续跑，可 Ctrl+C 后重跑续接）
node --import tsx scripts/eval/longmemeval-90/run-models-zl.mjs            # 产品管线 × 1B/7B/M3
node --import tsx scripts/eval/longmemeval-90/run-models-cells.mjs         # direct/pipeline/compact × 1B/7B/M3
node --import tsx scripts/eval/longmemeval-90/run-models-cc-pi.mjs         # CC×M3 + Pi×1B
# 或矩阵驱动直跑：--preset zl|cells|ccpi|all，--only/--limit/--force 可选
node --import tsx scripts/eval/longmemeval-90/run-matrix.mjs --preset all --only M3 --limit 3

# 2. 进度（无执行，随时看）
node scripts/eval/longmemeval-90/matrix-status.mjs

# 3. 判分（strict 主口径；复用 grade.mjs 口径，不复制逻辑）
node scripts/eval/longmemeval-90/grade-matrix.mjs                          # 全部 answers-*.jsonl
node scripts/eval/longmemeval-90/grade-matrix.mjs answers-zl-m3.jsonl answers-CC-90.jsonl

# 4. 逐题对比 / 消融（根因分析）
node scripts/eval/longmemeval-90/diff-cells.mjs answers-zl-m3.jsonl answers-CC-90.jsonl --out diff-zl-vs-cc.md
node --import tsx scripts/eval/longmemeval-90/run-ablation.mjs --model M3 --limit 3   # A零注入 vs B注入
```

## 脚本一览

| 脚本 | 作用 |
|---|---|
| `smoke-90.mjs` | 6 题型各 1 题冒烟（product/cell 两种），自动判分 |
| `run-matrix.mjs` | 矩阵驱动核心（preset/断点续跑/--only/--limit/--force，M3 网关 env 自动注入） |
| `run-models-zl.mjs` / `run-models-cells.mjs` / `run-models-cc-pi.mjs` | 三个矩阵入口 |
| `matrix-status.mjs` | 进度/ETA 报告（无执行） |
| `grade-matrix.mjs` | 多格统一判分 → 矩阵表 + `matrix-grades.json` |
| `diff-cells.mjs` | 两格逐题差异 + 题型聚合 → `diff-*.md` |
| `run-ablation.mjs` | 记忆消融 A/B 两臂 + 自动 diff |
| `run-product.mjs` / `run-cells.mjs` | 单格 runner（`--label` 输出名、`--model`、`--limit`、`--questions` 子集） |
| `grade.mjs` | 判分器本体（strict/lenient，口径唯一正源） |
| `sample.mjs` | 从 oracle 确定性抽样题集 |

## 产出与归档

- 答案：`answers-<label>.jsonl`（每行含 question_id/type/gold/ms/status/stdout/model）
- 矩阵：`matrix-summary-*.json`、`matrix-grades.json`
- 对比：`diff-*.md`
- 以上全部被 `.gitignore` 覆盖；需要归档时跑 `node scripts/eval/archive-eval-artifacts.mjs`（移入 `eval-archive/` 并 `git rm --cached` 解除跟踪）。

## 哪些对比有效（对比价值纪律）

- **只有配对比较有效**：同模型跨 harness（如 ZL-product×M3 vs CC×M3；ZL-direct×1B vs Pi×1B），或同 harness 跨模型（ZL-product×1B vs ×7B vs ×M3）。跨模型又跨 harness 的格子（如 ZL-direct×1B vs CC×M3）混了两个变量，不能下产品结论。
- **记忆供给轴必须显式对齐**：CC/ZL-direct 用 90 张人工蒸馏卡（开卷），ZL-product 在线播种仅 ~9 卡（闭卷）。「ZL-product vs CC」的差距 = 产品差距 + 供给差距；要看纯产品差距，先比 ZL-direct vs CC（同开卷），再比 ZL-product vs ZL-direct（同 agent、不同供给）——两条边加起来才能拆出真因。
- **单次运行方差 ±3，差距 <5 分不可信**：用 `--repeat 3` 跑重复臂，`grade-matrix --repeat` 看均值与极差；极差 >5 说明端点在波动，结论打折。
- **preference 题型是判分盲区**（子串判分对自由文本偏好句无区分度，全格 ≤3/15）：比较时用 `--exclude-type single-session-preference` 剔除，剩 5 题型 75 题。
- **超时预算已统一**：矩阵运行统一单题 600s（`PANSHA_LME_TIMEOUT_MS`），产品管线不再以 180s 被不公平击杀。
- **判分口径唯一正源是 grade.mjs**：任何口径变更都要用同一版 grade.mjs 重算全部旧答案（answers 都归档在 `eval-archive/`，重算成本低）；跨时间比较必须声明 grader 版本。

## 注意

- 判分口径变更只允许改 `grade.mjs` 一处；历史分数对 grader 版本敏感，重算结论时必须在 `COMPARE-90.md` 登记口径版本。
- 7B 全量 ≈ 2.5h/格；长跑前先 `smoke-90`，中途用 `matrix-status` 看 ETA。
- CC-90 的前提是 Claude Code 端点当前指向 M3（`~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL`）；跑完记得切回你自己的日常配置。
