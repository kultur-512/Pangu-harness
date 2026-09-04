# WORK-PLAN-5AGENTS.md — 5 人并行工作计划

> 配套：`AGENT-CONTRIBUTION.md`（规范）/ `docs/panshalach/ROADMAP-NEXT.md`（路线）/ `REFACTOR-ASSESSMENT.md`（现状缺口）。
> 团队画像（用户确定）：
> 1. **超级骨干 leader**（资深）— 贯穿 P1 + 评审 + 接口仲裁
> 2. **实干 agent** — 中等机制模块，可独立交付
> 3. **中坚 agent A** — 事件/状态机或语义检索
> 4. **中坚 agent B** — 剩下那条（中坚线）
> 5. **实习 agent** — 文档同步 + 简单脚本 + 学习
> 派工原则：尽量并行；接口先约定再实现；每日 stand-up 同步阻塞点。
> 周期：理想估 **8 周**（10 周人周 × 串联协调 0.8）。

---

## 1. 任务卡总览（5 人 × 5 块）

| 编号 | 负责人 | 模块 | 主交付 | 周数 |
|---|---|---|---|---|
| **W1** | Leader（超级骨干） | P1 openPangu 接入 + 评审/接口仲裁 | openai-compatible.ts 透传 tool_calls / ModelProvider env 注入 / `/model list` 重构 / Adapter 去品牌 / ProviderRegistry 通用化 / `getModelContextLength` 跨 provider；并对其它 4 人产出做 PR 评审 | 2.5 周（含评审 ~0.5） |
| **W2** | 实干 | P2 记忆写入闭环 + markUsed + P6 eval runner 骨架 | `RefinedMemoryStore.markUsed` / `PanshalachChaser.solveIssue` 调 `refine`+`save` / PromptBuilder 注入前 markUsed / `scripts/eval/{run-eval,smoke-eval}.mjs` 骨架 / m1-acceptance 升级到真 openPangu 路径 | 2 周（后半 0.5 周接 runner） |
| **W3** | 中坚 A | P3 事件记忆 + 任务状态机 | `src/memory/events.ts`（MemoryEventStore）/ `src/memory/taskState.ts`（TaskState）/ `src/memory/eventExtractor.ts` / PromptBuilder 注入顺序改 `TaskState → 卡 → Event → 当前任务` / CLI `/task status|risks|next|decide` | 2 周 |
| **W4** | 中坚 B | P4 语义检索 v0 + P5 多级摘要 | `src/memory/embed.ts`（LocalNGramHashProvider + EmbeddingProvider 接口）/ `RefinedMemoryStore` 加 semanticScore / `compactService` 三级摘要（L0/L1/L2）/ `.panshalach.json.example` schema 加 `embedding.provider` | 1.5 周 |
| **W5** | 实习 | 文档同步 + 迁移脚本 + CI gate + 学习 | `docs/panshalach/DEPLOY-CN.md`（先抄 ROADMAP-NEXT §P7.1 模板）/ `scripts/migrate-panshalach.mjs` 已存在需补回归 / `scripts/eval/fill-evaluation.mjs` / `verify-panshalach-cleanup.mjs` 维护 / `CHANGELOG.md` 每周变更条目 / 全程跟随 leader 做学习笔记 | 1.5 周（学习 + 文档） |

> **总人周 = 2.5 + 2 + 2 + 1.5 + 1.5 = 9.5 周人周**。并行后总周期约 **5-6 周密集 + 2 周收尾 = 8 周**。

---

## 2. 接口约定（先约定再实现，避免返工）

| 接口 | 出 | 入 | 周次 |
|---|---|---|---|
| `OpenAICompatClient.complete` 返回类型 | W1 | W2 / W3 / W4 | W1 早 |
| `sub total: ModelClientOutput { content, raw, toolCalls, detectedFormat }` 类型 | W1 | W2 | W1 早 |
| `RefinedMemoryStore.markUsed(cardIds)` + `refine(input)` + `save(cards)` | W2 | W3 / W4 | W2 早 |
| `MemoryEventStore.append/query/listTopics` | W3 | W2（runner 抓事件） | W3 中 |
| `TaskState.record* / getOrCreate` | W3 | W2 | W3 中 |
| `EmbeddingProvider.embed(text)` / `LocalNGramHashProvider` | W4 | W3（无关） | W4 中 |
| `compactSessionL1 / compactSessionL2` | W4 | W3 | W4 中 |
| `scripts/eval/run-eval.mjs` runner API（task/trace 接口） | W2 | W5（fill-evaluation 调） | W2 后 |
| `.panshalach.json` schema 变更 | W1 / W4（env / embedding） | W5（DEPLOY-CN.md） | 各人完毕即同步 |

> 接口约定走"最小契约 + mock 先行"：每人先 PR 接口签名 + 假实现 → 其它人并行基于假实现开干 → 最后再对接真实现。

---

## 3. 并行甘特（每周里程碑）

```
周  | W1 leader  | W2 实干     | W3 中坚 A  | W4 中坚 B  | W5 实习
----|------------|-------------|------------|------------|----------
W1  | P1.1+1.5   | markUsed 接 | 文档起草 | LocalNGram  | 跟 leader 学习
    | 接口签 PR  |  RefinedAPI | DEPLOY   | 骨架       | 维护 CHANGELOG
W2  | P1.2+1.3   | solveIssue  | events.ts | embedProvider| migrate.mjs
    | 评审 W2    | refine+save | 落 jsonl  | + 缓存      | 回归测试
    | P1.4 启动  | 注入路径   | topic分类 |             |
W3  | P1.4 收尾  | P2.4 mark   | taskState | RefinedStore| 文档骨架
    | 评审 W3    | Prompt 注卡 | ext extract| +semScore  | fill-eval API
W4  | P6 评审    | run-eval    | CLI /task | 三级摘要 L1/L2| DEPLOY-CN
    | 架构评审   | smoke-eval  |           | + runMultiple| 上 P7/P8
W5  | P6 复跑    |             |           |             | CHANGELOG+定稿
W6  | 收尾验收   | 收尾验收     | 收尾验收 | 收尾验收   | 收尾验收
W7  | 收口       | 收口         | 收口     | 收口       | 收口
W8  | 复盘       | 复盘         | 复盘     | 复盘       | 复盘
```

---

## 4. 每周交付 gate

| 周 | gate 名称 | 检查项 |
|---|---|---|
| W1 | 接口契约 PR | `OpenAICompatClient.complete` 返回类型扩展 + `MemoryClientOutput` 类型 + `EmbeddingProvider` 接口 + `MemoryEvent` 接口 + `TaskState` 接口全部 PR + 假实现 |
| W2 | P0 接入可达 | `panshalach run "ping"` 真实 openPangu 端点能调通；`/model list` 列出 openPangu-1B/7B/7B-VL；`getModelContextLength` 跨 provider 正确 |
| W3 | P2 写入闭环 | `refine()`+`save()` 在 `solveIssue` 落定路径串好；markUsed 注入路径调用；测试 `tests/memory/MemoryM4.test.ts` 通过 |
| W4 | P6 runner 工程 | `scripts/eval/run-eval.mjs` 跑通（mock 模式 + 真 openPangu 模式都能 exit 0/带结果）；T1-T5 任务族 stub 文件就位 |
| W5 | P3+P4 联调 | 事件流 + 任务状态 + 语义检索三件套串联；PromptBuilder L1 注入顺序改完；525+ 用例全绿 |
| W6 | 真 openPangu 评测 | `node scripts/eval/run-eval.mjs --openpangu http://...` 跑 A/B/C 三档 5 任务族；产物 `scripts/eval/results/<date>.json` 落盘 |
| W7 | 数据回填 + 国产亲和 | EVALUATION.md §4 填真实数据；DEPLOY-CN.md 完成（昇腾/麒麟/鲲鹏）；`ARCHITECTURE.md` §5 资源消耗表填实测 |
| W8 | 提交物定稿 + 复盘 | README 加"评测结果"小节；REFACTOR-ASSESSMENT §3 缺口表更新为"已实现 / P1-P8 路线"；CHANGELOG 增 0.5.0/0.6.0 条目 |

---

## 5. 单 agent 工作卡（任务片）

### 5.1 W1 Leader：openPangu + 评审
- **范围**（不越界）：
  - `src/model/openai-compatible.ts`（透传 tool_calls + streamChat）
  - `src/model/ProviderRegistry.ts` / `src/cli/repl/ModelProvider.ts`（env 注入泛化、跨 provider 上下文）
  - `src/cli/repl/commands/ModelCommand.ts`（`/model list` 重构）
  - `src/reasoning/StructuredReasoner.ts` + `src/adapter/`（去品牌 + alias 兼容）
- **不在范围**：记忆卡/事件/状态/语义/摘要/评测（其它 4 人）
- **验收**：
  - `panshalach run "ping"` 接真 openPangu 端点
  - `/model openpangu:openPangu-7B` 切换正常
  - 525 用例全绿
- **可授权提前**：
  - 评审其它 4 人 PR（按 `AGENT-CONTRIBUTION.md` §9 模板）

### 5.2 W2 实干：记忆闭环 + 评测 runner
- **范围**：
  - `src/memory/RefinedMemoryStore.ts`：新增 `markUsed`（注释兑现）+ `loadFilteredCached` 触发刷新
  - `src/PanshalachChaser.ts`：落定路径调 `refine({trajectory, taskStyle, attemptCount, userFeedback})` + `save(cards)`；返回 `refined: { added, merged }`
  - `src/cli/repl/PromptBuilder.ts`：注入前 markUsed
  - `src/server/runAgentTask.ts` + `src/cli/repl/sseInteractive.ts`：`done` 事件下发 `refined`
  - `src/cli/MemoryCommand.ts`（在 W3 之后回填 `/memory events`）
  - `scripts/eval/{run-eval,smoke-eval}.mjs` 骨架：A/B/C 三档 + T1-T5 task 注册表（具体 task 文件由 W5 实习在 W4 后补）
- **验收**：
  - 跑完 1 任务后，`tests/memory/MemoryM4.test.ts` 通过
  - `run-eval.mjs --mode mock` 在 < 60s 内 exit 0

### 5.3 W3 中坚 A：事件 + 任务状态
- **范围**（新增文件为主）：
  - `src/memory/events.ts`：`MemoryEvent` 接口 + `MemoryEventStore`（jsonl append/query）
  - `src/memory/taskState.ts`：`TaskState` 接口 + 持久化
  - `src/memory/eventExtractor.ts`：从 trajectory 抽事件
  - `src/cli/repl/FeatureTracker.ts`：演进（保留 `FeatureItem`，新增 `TaskState`）
  - `src/cli/repl/PromptBuilder.ts`：注入顺序 `TaskState → 卡 → Event → 当前任务`
  - 新增 CLI 命令 `/task status|risks|next|decide`（先放 `src/cli/repl/commands/TaskCommand.ts`）
- **验收**：
  - `tests/memory/EventStore.test.ts`、`tests/repl/TaskState.test.ts` 通过
  - PromptBuilder 输出在任务状态非空时能看到 `【任务状态】` 块

### 5.4 W4 中坚 B：语义检索 + 多级摘要
- **范围**：
  - `src/memory/embed.ts`：`EmbeddingProvider` 接口 + `LocalNGramHashProvider`（字符 2-gram 4096 哈希桶 + 余弦）
  - `src/memory/RefinedMemoryStore.ts`：构造接 `embedProvider`/`embedCache`；`loadFiltered` 加 `semanticScore`；排序 = 0.5w + 0.2rel + 0.3sem；`.panshalach-embed-cache.json` 缓存
  - `src/cli/repl/compactService.ts` + `compactStrategies.ts`：三级摘要（L0=6 轮逐字 / L1 中期 12k+ 摘要 / L2 长期 30k+ 段落）
  - `src/cli/MemoryCommand.ts`：`memory search-semantic <text>` / `memory embed-stats`
  - `.panshalach.json.example`：`embedding.provider` 字段
- **验收**：
  - `tests/memory/SemanticSearch.test.ts`、`tests/repl/MultiLevelCompact.test.ts` 通过
  - 50 轮模拟 → 三级文件落定 + 注入预算不超 200 token

### 5.5 W5 实习：文档 + 脚本 + 学习
- **范围**：
  - `docs/panshalach/DEPLOY-CN.md`：昇腾 MindIE + vLLM-ascend / 麒麟 V10 SP3 / 鲲鹏 920 + openEuler 三段部署步骤
  - `scripts/eval/fill-evaluation.mjs`：从 `scripts/eval/results/*.json` 拉数据填 EVALUATION.md §4 表
  - `scripts/migrate-panshalach.mjs`：回归（已存在）；写一份 `docs/panshalach/MIGRATION-FROM-LEGACY.md` 配套说明
  - `verify-panshalach-cleanup.mjs`：跟改名同步更新
  - `CHANGELOG.md`：每周末追加条目
  - **全程跟 leader 学习**：列席 stand-up、读 W1/W2/W3/W4 的 PR、做学习笔记 `tasks/intern-notes/<week>.md`
- **验收**：
  - DEPLOY-CN.md 在 Kylin/MindIE 上能"按文操作"
  - fill-evaluation.mjs 跑通（生成 §4 真实表）

---

## 6. 协作守则（补充 AGENT-CONTRIBUTION.md）

- **每 PR 必走 R=Leader 评审**：实习的 PR 由 Leader 直接评审；其它 4 人互评 + Leader 终审。
- **接口契约 PR 必先于实现 PR**：5 人接口契约一周内（W1）必须全部 PR；实现 PR 不能改接口。
- **每周一 stand-up**（30 分钟）：每人 3 条（做完/在做/阻塞）；Leader 把阻塞点写进 `tasks/standups/<date>.md`。
- **风险升级路径**：阻塞 > 1 天 → Leader 协调；> 2 天 → 用户介入。
- **代码 reviewer**：W2/W3/W4 互评（轮值）；Leader 终审；实习 PR 只走 Leader。
- **分支整洁规则（防污染远端仓库）**：每个 agent **只能在 `feature/<pinyin>` 分支追踪自己负责交付的代码、文档与测试**。以下内容**禁止 commit/push 到任何 `feature/<pinyin>` 分支**，需另寻路径管理：
  - **个人测试草稿 / 实验脚本**（如 `tests-sandbox/`、`sandbox-*.ts`、`playground/`）→ 留在本地工作区，**不入 git**。
  - **个人开发草稿 / 思考笔记**（如 `notes-*.md`、`drafts/`、`scratch.md`）→ 留在本地工作区。
  - **第三方参考材料 / 临时下载**（网络复制的代码片段、论文、API 文档副本）→ 仅本地参考，**不入 git**。
  - **生成的中间产物**（如 `dist/`、`build/`、`.next/`、`node_modules/`、各 agent 自跑的评测 `results/` 缓存）→ 通过 `.gitignore` 屏蔽，绝不提交。
  - **个人调试输出 / 截屏 / 日志** → 留在本地。
  - **其他 agent 的工作副本**（误 pull 到本地的别人分支）→ 不与自己的分支合并，单独 checkout 回自己分支。
  - **任何看起来是"自己的、暂时的、跟交付无关"的内容**，先问 Leader 该不该入 git，不要自作主张。
- **判断标准（三个问题）**：
  1. 这东西是 **评审者必须看到** 的吗？（不入评审分支的 → 不入 git）
  2. 删掉它会 **影响其他 agent 工作** 吗？（不影响 → 不入 git）
  3. 这东西 **会随时间增长且其他人不需要看到细节** 吗？（如日志、缓存 → 不入 git）
  - 三个问题任何一项答案是"否"→ 不要提交到 `feature/<pinyin>`。
- **违反处理**：Leader 评审发现分支脏文件 → REVISE + 强 `git rm` 清扫 → 在 `tasks/incidents/` 写日志；二次违反锁 agent 名册。
- **`.gitignore` 全局防护**（kultur 在 W1 末尾提交到 develop，所有 agent 共享）：

```gitignore
# 个人草稿与临时（每个 agent 不应在 feature/<pinyin> 提交）
notes-*.md
drafts/
scratch*.md
sandbox-*.ts
sandbox-*.mjs
playground/
# 实验性测试 / 草稿脚本
tests-sandbox/
*draft*.test.ts
# 临时调试输出
debug-*.log
*.tmp-debug
# 第三方参考材料（下载的代码片段、论文）
third-party-refs/
# 评审产物（每次跑随机数据，不入 git）
docs/panshalach/evals/sessions/
docs/panshalach/evals/cache/
# 已有屏蔽保留
.zorge*.bak
node_modules/
dist/
*.log
.env
```

- **临时文件落本地约定**：所有"非交付"文件落 `/tmp/<agent-id>-<date>/` 或 `<agent-workspace>/local/`，**不进仓库根**。Leader 在 CI 加一行 `git ls-files | grep -E '(notes-|drafts/|sandbox-|scratch|debug-)' && exit 1` 作为分支 gate。

### 6.1 强制工作日志与交接（每个 agent 必须做）

**目的**：让多个 agent 并行工作时能看见彼此"为什么这么改、在干什么"，并能异步确认"我这块要不要等另一块"。

#### 6.1.1 工作日志：`docs/agent/logs/<branch>/<branch>-YYYY-MM-DD.md`

- **每个 `feature/<pinyin>` 分支一个文件夹**：`docs/agent/logs/feature-<pinyin>/`。
- **每个工作日一个 md 文件**，文件名 `<branch>-YYYY-MM-DD.md`（例：`feature-zhangsan-2026-09-05.md`）。
- **每个文件结构**（每次新增内容按日期追加，不删除已落下的内容；同一文件多日更新仅追加，不覆盖）：

```markdown
# <branch> 工作日志 — YYYY-MM-DD

agent: <pinyin> / <agent-id>
date:  YYYY-MM-DD
last_updated: HH:MM

## 想做什么（目的）
<一段话：本轮想达到什么目标，为什么>

## 打算怎么改（动作）
- 改：src/xxx.ts（理由：…）
- 改：tests/xxx.test.ts（理由：…）
- 新增：src/yyy.ts（理由：…）

## 实际干了什么（事实）
- 改了 src/xxx.ts L100-150（做 X）
- 跑了 npm test（结果：525 pass / 0 fail）
- 跑了 scripts/eval/run-eval.mjs --mode mock（结果：exit 0 / JSON 落盘）

## 卡点 / 需要别人决定（接口争议）
- 我把 `refine()` 返回的 card 数组扩成了 `{ cards, merged }`，**影响 W3 中坚 A 的 taskState 持久化接口**，请他在下次 stand-up 同步。
- 我看到 W4 的 `localNgramEmbed` 函数签名变了，看 PR #42 没问题，但要确认。

## TODO（明天 / 下一轮）
- [ ] 跑 T3 长文档跨章节 5 轮 mock
- [ ] 等 W3 中坚 A 确认 TaskState 接口后合入
```

- **更新规则（重要）**：
  - 同一天多次更新 → **追加**（append），不要 `cat > file.md` 覆盖；用 Edit 的"追加"或 `>> file.md`。
  - 前一天文件**永远保留**，不删除、不改写。
  - `last_updated` 时间戳每改一次更新一次。
  - **不写"思考过程"的冗长内容**，只写"目的 + 动作 + 事实 + 卡点"4 块。
- **写入时机**：每次 `git commit` 之前**必须**有对应日志条目的最近改动记录；CI gate 检查"commit 时间戳 ≥ log 最后更新时间"。
- **.gitignore 调整**：`docs/agent/logs/**` **不被 gitignore**，正常入 git（这是有意追踪的协作记忆）。但允许 `.gitignore` 排除 `*.local.md`、`*.tmp` 等临时副本。

#### 6.1.2 交接声明：`docs/agent/handover/<branch>-handover.md`

- **目的**：跨 agent 协调"我这块依赖谁/谁能合我的"。每个分支**必须**有且只有一个 `handover/<branch>-handover.md`（branch = `feature-<pinyin>`）。
- **结构**：

```markdown
# 交接声明 — <branch>

branch: feature/<pinyin>
owner:   <pinyin>
status:  WIP | READY-FOR-REVIEW | BLOCKED-ON-<branch>

## 我需要别人确认的接口（resolved: false）
- [ ] W1 Leader: `OpenAICompatClient.complete` 返回 `ModelClientOutput` 对象（含 tool_calls 字段）
- [ ] W3 中坚A: `MemoryEventStore.append` 接受 `kind/topic/summary/refs/sessionId`

## 我已经确认的接口（resolved: true）
- [x] W2 实干: `RefinedMemoryStore.markUsed(cardIds)` 签名

## 我暴露的接口（别人依赖）
- `PromptBuilder.appendMemoryCardsDedup` 会在注入前 markUsed（影响 W3 eventExtractor 的二次写入）

## 阻塞我
- 无 / 等 W1 PR #41 合并 / 等 openPangu 端点就绪

## 时间承诺
- 预计 N 周内 merge-ready
- 风险：...
```

- **更新规则**：
  - 状态变更（`WIP` → `READY-FOR-REVIEW` → `MERGED`）必须**只追加**，不改历史；用版本号 `handover/<branch>-handover.md` + `handover/<branch>-handover.v2.md` 留审计。
  - 任何 agent 工作前**必须**先 `cat handover/feature-*.md` 看有没有 unresolved 接口冲突；如有则先在 PR 描述里"引用对应 handover 行"再开工。
  - **开工前必查**（写进 `AGENT-CONTRIBUTION.md` Pre-merge 清单）："已读 `docs/agent/handover/feature-*.md` 中所有未 resolved 项"打勾。

#### 6.1.3 协作前置流程

```bash
# 1. 开工前：拉所有 handover 看是否有指向自己的未解项
git fetch origin
for h in docs/agent/handover/feature-*.md; do
  echo "=== $h ==="
  grep -E "我需要别人确认的接口|我需要.*确认" "$h" || true
done
# 若看到 "owner: <my-pinyin>" 的未 resolved 项 → 先去解决（写 PR / 改自己的设计）

# 2. 工作中：每天结束前写日志
BRANCH=$(git rev-parse --abbrev-ref HEAD)
DATE=$(date +%Y-%m-%d)
mkdir -p "docs/agent/logs/${BRANCH}"
LOG="docs/agent/logs/${BRANCH}/${BRANCH}-${DATE}.md"
if [[ ! -f "$LOG" ]]; then
  echo "# ${BRANCH} 工作日志 — ${DATE}" > "$LOG"
  echo "" >> "$LOG"
  echo "agent: <pinyin> / <agent-id>" >> "$LOG"
  echo "date:  ${DATE}" >> "$LOG"
  echo "last_updated: $(date +%H:%M)" >> "$LOG"
  echo "" >> "$LOG"
  echo "## 想做什么（目的）" >> "$LOG"
  echo "" >> "$LOG"
  echo "## 打算怎么改（动作）" >> "$LOG"
  echo "" >> "$LOG"
  echo "## 实际干了什么（事实）" >> "$LOG"
  echo "" >> "$LOG"
  echo "## 卡点 / 需要别人决定（接口争议）" >> "$LOG"
  echo "" >> "$LOG"
  echo "## TODO（明天 / 下一轮）" >> "$LOG"
fi
# 用编辑器或 cat >> append "## HH:MM 更新 ..." 块

# 3. 提交前：保证当日日志覆盖了本次 commit 的变更
git diff --stat
git add docs/agent/logs/${BRANCH}/${BRANCH}-${DATE}.md
# 然后再 git add src/...
```

#### 6.1.4 Leader / CI 责任

- Leader 每周一汇总 5 人的 `handover/*.md` 中 unresolved 项，在 stand-up 第一项过这些。
- CI 加 gate：
  - `scripts/agent-logs-gate.sh` 检查每个 `feature/*` 分支是否新增/更新了当日 `docs/agent/logs/<branch>/<branch>-<date>.md` 文件，与本次 commit 时间戳偏差 ≤ 1 小时。
  - `scripts/agent-handover-check.sh` 检查开工前 `git fetch origin` 后 `handover/feature-*.md` 中 owner=自己分支的未 resolved 项是否在 PR 描述里被引用。
- 实习 agent（W5）可以把日志/交接维护作为"练手入口"，让 Leader 帮其过日志格式。

#### 6.1.5 落到仓库的具体文件清单

| 路径 | 创建者 | 是否入 git |
|---|---|---|
| `docs/agent/logs/feature-<pinyin>/<branch>-YYYY-MM-DD.md` | 该分支 owner | ✅ 强制入 git |
| `docs/agent/logs/.gitkeep` | Leader W1 | ✅ |
| `docs/agent/handover/feature-<pinyin>-handover.md`（及 `.v2.md` ...） | 该分支 owner | ✅ 强制入 git |
| `docs/agent/handover/README.md` | Leader W1（说明用法） | ✅ |

`.gitignore`（在原 §6 末尾块下追加）：
```gitignore
# docs/agent/logs 与 handover 是强制追踪的协作记忆，不忽略
# docs/agent/logs/* 与 docs/agent/handover/* 保持入 git
# 只忽略其下的临时副本
docs/agent/logs/**/*.local.md
docs/agent/logs/**/*.tmp
docs/agent/handover/**/*.local.md
docs/agent/handover/**/*.tmp
```

---

## 7. 依赖与降级

| 风险 | 触发条件 | 降级路径 |
|---|---|---|
| openPangu 端点不可用 | W1 评测跑 > 2 天失败 | 用 mockFetch 模式先跑通 runner，端点就绪后回填真实数据 |
| Agent 自动分类服务持续不可用 | Bash 类工具被拒 | 切 Edit/Write（不需 Bash），继续；通知 Leader |
| 实习能力跟不上 | W2 评审发现其 PR 不达标 | Leader 收回 W5 部分交付（DEPLOY-CN.md 文档化由中坚 B 接手），实习转纯观察 |
| P3/P4 实现延期 | W5 gate fail | 降级到 P3=事件（去掉 TaskState）/ P4=关键词（去掉语义），满足"能做命题交付"最小集 |

---

## 8. 完成条件（与 `docs/panshalach/ROADMAP-NEXT.md` 同步）

- ✅ `npx tsc --noEmit` EXIT=0
- ✅ `npm test` 525+ 用例全绿
- ✅ `node verify-panshalach-cleanup.mjs` PASS
- ✅ `node scripts/eval/run-eval.mjs --mode mock` 通过
- ✅ 真 openPangu 端点跑过 `run-eval.mjs` 且产出 `results/<date>.json`
- ✅ `docs/panshalach/EVALUATION.md` §4 填真实数据
- ✅ `docs/panshalach/DEPLOY-CN.md` 完整
- ✅ `docs/panshalach/ARCHITECTURE.md` §5 资源消耗实测填表
- ✅ `CHANGELOG.md` 加 0.5.0（用户最后已命名 Panshalach）+ 0.6.0（P1-P8 落地）
- ✅ `README.md` 加"评测结果"小节

---

## 9. 派工启动清单

Leader 在 W1 第一天做：
- [ ] 在 `tasks/agents/` 创建 5 张注册卡（leader / shigan / zhongjianA / zhongjianB / intern）
- [ ] 在 `tasks/standups/` 建立目录；每周一上午开周会
- [ ] 5 人各自 `git checkout -b feature/<pinyin> origin/develop`（按 `AGENT-CONTRIBUTION.md` §B.2 注册）
- [ ] W1 接口契约 PR 全员提交 → 评审 → 合入 develop
- [ ] W1 末第一次 stand-up

5 人按本表各自领取 W2 起任务，PR 走 `AGENT-CONTRIBUTION.md` §5.3 流程。
