# T1-T3 跑分任务下发（王浩宇 ollama + 千问 7B）

> 下发人：赵天昂（zhaotianang1 分支，80d3f08 已落 issue.md + verify.sh 框架）
> 接收人：王浩宇（wanghaoyu1，U4 接力补 repo/document + verify.sh 强化 + R6 runner 接入）
> 起草日期：2026-09-06
> 真机端点：ollama + 千问 7B（R6 runner 真机跑分；A/B/C/C4 消融按 plan）
>
> ⚠️ **执行状态（2026-09-16 注记）**：本计划的 ollama/千问 7B 路线未执行。实际真机跑分由本地 **LM Studio openpangu-embedded-1b-i1** 端点完成（2026-09-16，T1-T5 × A/B/C/C4 全量 20 runs，结果与质量注记见 [docs/panshalach/EVALUATION.md §4](../../docs/panshalach/EVALUATION.md)）。本文保留 fixture 历史背景；7B 级真机复跑（含 A 档真溢出场景）为后续工作项。

---

## 0. 跑分前置（王浩宇端确认项）

| 项 | 状态 | 说明 |
|---|---|---|
| ollama 端点 URL | ⏳ 待王浩宇提供 | 例：`http://localhost:11434` 或远程内网 IP |
| 千问 7B 模型 tag | ⏳ 待王浩宇确认 | qwen2.5:7b / qwen2:7b / qwen3:7b-thinking 三选一；影响 context 长度 |
| context window | 由模型 tag 决定 | T3 的 10K-50K document 需要 ≥ 16K context；qwen3-thinking 需先 smoke |
| run-eval.mjs 端点配置 | ⏳ 待改 | R6 runner 端点字段改为 ollama URL + 模型 tag |
| 输出目录 | `docs/agent/eval-results/2026-09-06-ollama-7b/` | 新建子目录，按 fixture 分子目录 |

> **本文不预设模型版本**——王浩宇确认后若需调整 T3 document 长度或 verify.sh 阈值，由王浩宇同步回 zhaotianang1。

---

## 1. T1 任务：约束遵循（赵天昂已完结）

**结论：T1 可直接跑，无需王浩宇补任何文件。**

### 已落文件
- `tasks/T1/issue.md` — issue 正文（TODO.md 5 条约束，runner 的 prompt 源）
- `tasks/T1/verify.sh` — 5 条约束自动检查（PASS 5/5 + FAIL 准确识别，含单元测试）
- `tasks/T1/README.md` / `fixture.md` — 任务族契约 + 实体化指针

### 跑分命令（建议）
```bash
cd <task-workdir>
# runner 从 tasks/T1/issue.md 加载 prompt，从 issue 推断 verify.sh
# 期望：verification.signal = PASS（verify.sh 退出码 0）
```

### 评测合同
- `taskFamily: T1`
- 期望 `verdict: completed` + `verification.signal: PASS`
- A/B/C/C4 四档消融必跑
- B 档要求：`injectedCardIds.length >= 1`（line-defense）
- A 档（baseline）：无记忆，必须真溢出验证（不溢出标 overflow-skipped）

### 王浩宇需要做的事
**无**——只跑分、回写结果即可。

---

## 2. T2 任务：跨文件函数签名重构

**现状：issue.md + verify.sh stub 已落，王浩宇补 `repo/` + 替换 stub。**

### 已落文件
- `tasks/T2/issue.md` — add 函数 `number | bigint` 扩展 issue（runner 的 prompt 源）
- `tasks/T2/verify.sh` — **stub**：只检查 `repo/` 存在 + 退出 0（需要替换为实检）
- `tasks/T2/README.md` / `fixture.md` — 任务族契约 + 实体化指针

### 王浩宇需要做的事

#### 2.1 创建 `tasks/T2/repo/`（5-10 文件小型 TypeScript 代码库）

**最小骨架（建议 5 文件）：**
```
repo/
├── package.json          # name: t2-repo, scripts.test: "tsc --noEmit && node --test"
├── tsconfig.json         # strict: true, target: es2022, module: nodenext
├── src/
│   ├── utils/
│   │   └── math.ts       # 入口：export function add(a: number, b: number): number
│   ├── services/
│   │   └── calcService.ts   # import { add } from '../utils/math.ts'; 调用 add() 至少 3 处
│   └── main.ts           # import { calcService } from './services/calcService.ts'; 间接调用
└── tests/
    └── math.test.ts      # node:test，至少 2 个用例：number 相加 + add(1n, 2n) 类型断言
```

**`math.ts` 起始签名（issue 要求扩展为 `number | bigint`）：**
```ts
export function add(a: number, b: number): number {
  return a + b;
}
```

**注意点：**
- 至少 3 处 `add(...)` 调用点（分布在 calcService.ts 和 main.ts）
- calcService.ts 提供 `addNumbers(a, b)`、`addBigInts(a, b)`、`sum(arr)` 三个函数作为调用入口
- `package.json` 用 `node --test` 跑测试（避免 vitest/jest 依赖）
- `tsconfig.json` 用 `module: nodenext` 配 `.ts` 后缀 import

#### 2.2 替换 `tasks/T2/verify.sh` stub 为实检

**三段式检查（grep 调用点 + npm test + tsc 编译门）：**

```bash
#!/usr/bin/env bash
# T2 verify.sh — 跨文件函数签名重构验证（王浩宇 U4 强化版）
set -u

REPO_DIR="${1:-repo}"
PASS=0
FAIL=0

check() {
  local label="$1"
  local expr="$2"
  shift 2
  if sh -c "$expr" -- "$@" >/dev/null 2>&1; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    FAIL=$((FAIL + 1))
  fi
}

[ ! -d "$REPO_DIR" ] && { echo "[T2] FATAL  missing $REPO_DIR"; exit 2; }
cd "$REPO_DIR" || exit 2

echo "[T2] checking cross-file refactor in: $REPO_DIR"

# 检查 1：add 签名已扩展为 number | bigint
check "T2-s1 add signature accepts bigint" \
  'grep -qE "function add\s*\([^)]*bigint" src/utils/math.ts' .

# 检查 2：所有 add() 调用点都用 number | bigint 安全语法（add 后跟的类型断言或 typeof 检查）
check "T2-s2 call sites updated (>= 3 sites, no plain number args)" '
  rc=0
  count=$(grep -rE "\badd\s*\(" src/ tests/ | wc -l)
  if [ "$count" -lt 3 ]; then echo "      only $count call sites found" >&2; rc=1; fi
  exit $rc
' .

# 检查 3：tests/math.test.ts 至少有 2 个 bigint 用例
check "T2-s3 bigint test cases (>= 2)" '
  rc=0
  count=$(grep -cE "add\s*\(\s*[0-9]+n\s*," tests/math.test.ts)
  if [ "$count" -lt 2 ]; then echo "      only $count bigint tests" >&2; rc=1; fi
  exit $rc
' .

# 检查 4：tsc 编译门（类型一致性）
check "T2-s4 tsc --noEmit passes" '[ -f tsconfig.json ] && npx --no-install tsc --noEmit' .

# 检查 5：node:test 通过
check "T2-s5 node --test passes" '[ -f package.json ] && npm test --silent' .

echo "[T2] passed=$PASS  failed=$FAIL"
exit $FAIL
```

### 评测合同
- `taskFamily: T2`
- 期望 `verdict: completed` + `verification.signal: ALL_TESTS_PASSED`
- R7 C4 消融：是否使用 n-gram 语义检索召回跨文件引用
- 误改率 = 0（修改了不相关文件 → `failureTaxonomy.primary = 'model-noncompliant'`）

---

## 3. T3 任务：长文档关键信息检索与摘要

**现状：issue.md + verify.sh 基础检查已落，王浩宇补 `document.md` + verify.sh keyword 段。**

### 已落文件
- `tasks/T3/issue.md` — Q1/Q2/Q3 三段答案 issue（runner 的 prompt 源）
- `tasks/T3/verify.sh` — 4 条基础检查（标题 + 字节上限，PASS 6/6）
- `tasks/T3/README.md` / `fixture.md` — 任务族契约 + 实体化指针

### 王浩宇需要做的事

#### 3.1 创建 `tasks/T3/document.md`（10K-50K tokens 中文长文档）

**章节结构建议：**
```
# <报告标题>
## 第 1 章 <核心主题>
   <3000-5000 字展开>
## 第 2 章 <方法论>
   <3000-5000 字展开>
## 第 3 章 <关键人物及其贡献>
   <3000-5000 字，至少 4 位人物，每人 500-1000 字>
## 第 4 章 <实验/案例>
   <3000-5000 字>
## 第 5 章 <结论>
   <2000-4000 字>
## 参考文献
```

**关键约束（影响 verify.sh keyword 检查）：**
- 第 1 章至少 1 个**唯一关键词 K1**（例：`分布式共识协议的演化路径`）
- 第 3 章至少 **4 位人物名 P1/P2/P3/P4** + 每人 1 个**唯一贡献关键词 C1/C2/C3/C4**
- 第 5 章至少 1 个**结论关键词 K5**（例：`边缘计算场景下的最终推荐方案`）

#### 3.2 在 `tasks/T3/verify.sh` 末尾追加 keyword 召回检查

**追加模板（在现有 4 条基础检查后追加）：**

```bash
# ---------- keyword 召回检查（王浩宇 U4 追加）----------

# K1: 第 1 章核心主题唯一关键词
check "T3-r1 recall K1 (第 1 章核心主题)" 'grep -q "K1_KEYWORD" "$1"' "$F"

# P1-P4: 第 3 章关键人物
check "T3-r2 recall P1" 'grep -q "P1_NAME" "$1"' "$F"
check "T3-r3 recall P2" 'grep -q "P2_NAME" "$1"' "$F"
check "T3-r4 recall P3" 'grep -q "P3_NAME" "$1"' "$F"
check "T3-r5 recall P4" 'grep -q "P4_NAME" "$1"' "$F"

# C1-C4: 第 3 章关键贡献
check "T3-r6 recall C1" 'grep -q "C1_CONTRIB" "$1"' "$F"
check "T3-r7 recall C2" 'grep -q "C2_CONTRIB" "$1"' "$F"
check "T3-r8 recall C3" 'grep -q "C3_CONTRIB" "$1"' "$F"
check "T3-r9 recall C4" 'grep -q "C4_CONTRIB" "$1"' "$F"

# K5: 第 5 章结论关键词
check "T3-r10 recall K5 (第 5 章结论)" 'grep -q "K5_KEYWORD" "$1"' "$F"
```

王浩宇填入 `K1_KEYWORD` / `P1_NAME` / `C1_CONTRIB` 等真实词（来自真实 document.md）。

### 评测合同
- `taskFamily: T3`
- 期望 `verdict: completed` + `verification.signal: PASS`
- `prompt.estimatedTokens` 必须反映长文档特征（> 10K）
- R8 多级摘要 L1/L2 评测必跑

---

## 4. 跑分结果回写约定

| 输出 | 位置 |
|---|---|
| 单次 run 结果 | `docs/agent/eval-results/2026-09-06-ollama-7b/T{n}-{档位}.json` |
| T1/T2/T3 对比表 | `docs/agent/eval-results/2026-09-06-ollama-7b/SUMMARY.md` |
| FailureTaxonomy 归类 | SUMMARY.md 内嵌表格，按 R6 双层 taxonomy（primary / secondary） |
| 7B 暴露的能力短板 | `EVALUATION.md` 末尾"7B 评测"段（zhaiyuanhao leader 维护） |

**结果字段必填（按 R6 schema 契约）：**
- `runId` / `timestamp` / `taskFamily` / `model` / `endpoint`
- `verdict`（completed / failed / overflow-skipped）
- `verification.signal`（PASS / ALL_TESTS_PASSED / FAIL）
- `failureTaxonomy.primary` + `failureTaxonomy.secondary`（仅 failed 时填）
- `metrics.passedConstraints` / `metrics.totalConstraints`
- `metrics.toolCallNoise`（与约束/任务无关的工具调用数）

---

## 5. 王浩宇回传清单

请在 wanghaoyu1 分支完成后回传：

1. ✅ ollama 端点 URL + 千问 7B tag
2. ✅ T2 `repo/` 落地 + verify.sh 强化版 commit hash
3. ✅ T3 `document.md` 落地 + verify.sh keyword 段 commit hash
4. ✅ 3 个 fixture × 4 档消融 = 12 次跑分结果 JSON + SUMMARY.md
5. ✅ FailureTaxonomy 双层归类（如果失败）
6. ✅ 7B 暴露的能力短板观察（短文本，10-30 行）

---

## 6. 起草人不越界说明

**本文件由赵天昂起草，仅覆盖"任务说明 + 接手清单"边界：**
- ✅ 已起草：issue.md 正文 + verify.sh 框架 + 实体化指针（commit 80d3f08）
- ✅ 已起草：repo/document/keyword 的**目标结构 + 三段式 verify.sh 模板**（本文件 §2-3）
- ❌ 未代写：真实的 `tasks/T2/repo/` 代码、`tasks/T3/document.md` 文本、真实 keyword 列表
- ❌ 未预设：ollama 端点 URL、千问 7B 具体 tag（等王浩宇确认）
- ❌ 未起草：run-eval.mjs 的 ollama endpoint 配置（王浩宇 R6 runner 接入职责）

如需赵天昂代写 repo/document 闭环，单独发指令即可。
