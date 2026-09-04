# WORK-PLAN-MAIN-LEARN.md — 4 主力 + K 学习位并行工作计划

> 配套：`AGENT-CONTRIBUTION.md`（规范）/ `docs/panshalach/ROADMAP-NEXT.md`（路线）/ `REFACTOR-ASSESSMENT.md`（现状缺口）。
> 团队画像（用户确定）：
> - **4 个主力 agent**（必备，缺一不可）：贯穿 P1-P8 主轴；每人 owner 一块，独立交付。
> - **K 个学习位**（K ≥ 0，可动态扩缩）：不 owner 主任务，**挂靠某个主力**做"看、学、改小"——不替主力扛交付。
>
> 派工原则：4 主力尽量并行；接口先约定再实现；每日 stand-up 同步阻塞点；学习位按容量挂靠某主力，不独立占主线任务。
> 周期：理想估 **8 周**（8 周主力人周 × 串联协调 1.0；学习位不延周期）。

> ⚠️ 本文档原名 `WORK-PLAN-5AGENTS.md`，按用户指示改为"4 主力 + K 学习位"。如已分发给团队，请通知大家看新文件名与新人力模型。

---

## 0. 人力模型与编号约定

**主力（4 个，owner 任务卡 W1–W4，必须 4 人齐）**：
1. **Leader（超级骨干 / Main-Leader）** — owner W1：P1 openPangu 接入 + 评审/接口仲裁
2. **Main-A（中坚）** — owner W3：P3 事件记忆 + 任务状态机
3. **Main-B（中坚）** — owner W4：P4 语义检索 + P5 多级摘要
4. **Doer（实干）** — owner W2：P2 写入闭环 + markUsed + P6 eval runner 骨架

**学习位（K 个，K ≥ 0，不 owner 主线任务）**：
- 每个学习位**挂靠一个主力**（通常 Doer 或 Leader），做以下工作：
  - 跟主力 PR 做 walkthrough；给主力当 reviewer 试手
  - 维护文档/日志/CHANGELOG/.gitignore/scripts/eval/run-eval.mjs 周边
  - **不**替主力写主代码（避免"学习位做出让主力返工的活"）；小修补 PR 可以
- 学习位数量由 Leader 在 W1 第一天的 stand-up 上根据可容纳量决定；中途可加可减（≥ 0）。

**编号约定**：
- `L` 前缀 = 学习位（`L1` `L2` ...）
- `Main` 前缀 = 主力
- `W1-W4` 主力任务卡
- `W5-W8` 收尾阶段不分配 owner，由 Leader 协调全体

---

## 1. 任务卡总览（4 主力 × 4 块 + 学习位挂靠）

| 编号 | 负责人 | 模块 | 主交付 | 周数 |
|---|---|---|---|---|
| **W1** | Leader（Main-Leader） | P1 openPangu 接入 + 评审/接口仲裁 | openai-compatible.ts 透传 tool_calls / ModelProvider env 注入 / `/model list` 重构 / Adapter 去品牌 / ProviderRegistry 通用化 / `getModelContextLength` 跨 provider；并对其它 3 主力的产出做 PR 评审；W5+收口期负总责 | 2.5 周（含评审 ~0.5） |
| **W2** | Doer | P2 记忆写入闭环 + markUsed + P6 eval runner 骨架 | `RefinedMemoryStore.markUsed` / `PanshalachChaser.solveIssue` 调 `refine`+`save` / PromptBuilder 注入前 markUsed / `scripts/eval/{run-eval,smoke-eval}.mjs` 骨架 / m1-acceptance 升级到真 openPangu 路径 | 2 周（后半 0.5 周接 runner） |
| **W3** | Main-A | P3 事件记忆 + 任务状态机 | `src/memory/events.ts`（MemoryEventStore）/ `src/memory/taskState.ts`（TaskState）/ `src/memory/eventExtractor.ts` / PromptBuilder 注入顺序改 `TaskState → 卡 → Event → 当前任务` / CLI `/task status|risks|next|decide` | 2 周 |
| **W4** | Main-B | P4 语义检索 v0 + P5 多级摘要 | `src/memory/embed.ts`（LocalNGramHashProvider + EmbeddingProvider 接口）/ `RefinedMemoryStore` 加 semanticScore / `compactService` 三级摘要（L0/L1/L2）/ `.panshalach.json.example` schema 加 `embedding.provider` | 1.5 周 |

> **4 主力的总人周 = 2.5 + 2 + 2 + 1.5 = 8 周人周**。并行后总周期约 **5 周密集 + 3 周收尾 = 8 周**。

**学习位挂靠矩阵（K 视项目而定，默认 K=1-2，可为 0）**：

| 学习位 ID | 挂靠主力 | 主要工作 |
|---|---|---|
| `L1` | Leader | DEPLOY-CN.md 起草 + Adapter 去品牌 PR review walkthrough |
| `L2` | Doer | eval runner 测试用例 + CHANGELOG 维护 + 文档与日志的格式看护 |

> K 的真实数字在 W1 第一天 stand-up 由 Leader 拍。**K 可中途增减**。

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
周  | W1 Leader          | W2 Doer       | W3 Main-A      | W4 Main-B      | 学习位 (K)
----|--------------------|---------------|----------------|----------------|----------
W1  | P1.1+1.5           | markUsed 接   | 文档起草       | LocalNGram     | 跟 leader
    | 接口签 PR         | RefinedAPI    | DEPLOY         | 骨架           | walkthrough
W2  | P1.2+1.3           | solveIssue    | events.ts      | embedProvider  | 写日志/CHANGELOG
    | 评审 W2           | refine+save   | 落 jsonl       | + 缓存         | 跑回归
    | P1.4 启动         | 注入路径     | topic分类     |                |
W3  | P1.4 收尾          | P2.4 mark     | taskState      | RefinedStore   | 文档骨架
    | 评审 W3           | Prompt 注卡   | ext extract    | +semScore      | fill-eval API
W4  | P6 评审            | run-eval      | CLI /task      | 三级摘要 L1/L2| DEPLOY-CN
    | 架构评审          | smoke-eval    |                | + runMultiple  | 上 P7/P8
W5  | P6 复跑            |               |                |                | CHANGELOG+定稿
W6  | 收尾验收          | 收尾验收      | 收尾验收      | 收尾验收      | 收尾验收
W7  | 收口              | 收口          | 收口          | 收口          | 收口
W8  | 复盘              | 复盘          | 复盘          | 复盘          | 复盘
```

> **学习位列**说明：K 个学习位**不做 owner 主任务**，但每天需要列席 stand-up 同步，并按主力挂靠把日志/文档维护量做掉。W1 第一天 stand-up 拍 K 的实际值与挂靠关系。

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
- **不在范围**：记忆卡/事件/状态/语义/摘要/评测（其它 3 主力 + 学习位）
- **验收**：
  - `panshalach run "ping"` 接真 openPangu 端点
  - `/model openpangu:openPangu-7B` 切换正常
  - 525 用例全绿
- **可授权提前**：
  - 评审其它 3 主力 + K 学习位 PR（按 `AGENT-CONTRIBUTION.md` §9 模板）

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

### 5.5 W5 学习位（K 人挂靠）：文档 + 脚本 + 学习
- **谁来做**：K 个学习位（K ≥ 0），每个挂靠一个主力（典型挂靠：Leader 负责 DEPLOY-CN + 文档；Doer 负责 eval runner + CHANGELOG）。学习位**不做**主力 owner 任务，只做"看、学、改小"。
- **范围**（按主力分配）：
  - 挂靠 Leader：
    - `docs/panshalach/DEPLOY-CN.md`：昇腾 MindIE + vLLM-ascend / 麒麟 V10 SP3 / 鲲鹏 920 + openEuler 三段部署步骤
    - `docs/panshalach/ROADMAP-NEXT.md` 与 `REFACTOR-ASSESSMENT.md` 的同步
  - 挂靠 Doer：
    - `scripts/eval/fill-evaluation.mjs`：从 `scripts/eval/results/*.json` 拉数据填 EVALUATION.md §4 表
    - `scripts/migrate-panshalach.mjs` 回归测试 + 配套 `docs/panshalach/MIGRATION-FROM-LEGACY.md`
    - `verify-panshalach-cleanup.mjs` 维护
    - `CHANGELOG.md` 每周末追加条目
- **学习位专属**（全员做）：
  - 列席 stand-up、读主力 PR、做学习笔记 `tasks/learner-notes/<pinyin>/<week>.md`
- **验收**：
  - DEPLOY-CN.md 在 Kylin/MindIE 上能"按文操作"
  - fill-evaluation.mjs 跑通（生成 §4 真实表）
  - 学习笔记每周至少一篇（含"读懂了什么 + 哪里卡住 + 想问的问题"3 块）

---

## 6. 协作守则（补充 AGENT-CONTRIBUTION.md）

- **每 PR 必走 R=Leader 评审**：实习的 PR 由 Leader 直接评审；其它 4 人互评 + Leader 终审。
- **接口契约 PR 必先于实现 PR**：4 主力接口契约一周内（W1）必须全部 PR；实现 PR 不能改接口。
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

- Leader 每周一汇总 4 主力 + K 学习位的 `handover/*.md` 中 unresolved 项，在 stand-up 第一项过这些。
- CI 加 gate：
  - `scripts/agent-logs-gate.sh` 检查每个 `feature/*` 分支是否新增/更新了当日 `docs/agent/logs/<branch>/<branch>-<date>.md` 文件，与本次 commit 时间戳偏差 ≤ 1 小时。
  - `scripts/agent-handover-check.sh` 检查开工前 `git fetch origin` 后 `handover/feature-*.md` 中 owner=自己分支的未 resolved 项是否在 PR 描述里被引用。
- 学习位（L1, L2, ...）可以把日志/交接维护作为"练手入口"，让 Leader 帮其过日志格式。

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

### 6.2 Git 协作流程（强约束，防合并错误）

**为什么需要**：5+ 人并行 + 多分支 feature → 没规则会产生"漏拉、错合、误 push master、隐式 rebase"等灾难。下面是**每个人、每一次写代码前必做**的标准流程。

#### 6.2.1 启动 / 开工前（pre-flight）

1. **必拉基线**（每次开工前必跑，且至少 1 小时内最多跑一次）：
   ```bash
   git fetch --all --tags --prune
   git fetch origin master develop
   ```
2. **确认自己分支干净**：
   ```bash
   git status            # 干净 or 已 staged
   git rev-parse --abbrev-ref HEAD   # 必须 feature/<own-pinyin>
   git diff --stat origin/feature/<own-pinyin>..HEAD   # 自己独有的进度
   ```
3. **拉取更新基线**（推荐用 rebase 而不是 merge，保留线性历史）：
   ```bash
   # 你的 feature 分支领先 develop 多少？有多少冲突高风险？
   git fetch origin develop
   git rebase origin/develop
   # 若冲突：先 `git rebase --abort` 看任务卡是否触碰了别人也在改的文件；
   # 若不可避免冲突 → 解决后 `git rebase --continue` 并在 `docs/agent/logs/<branch>/...` 写"rebase 了哪些文件、原因"
   ```
4. **确认"我能 push 到哪儿"**（防误推 master）：
   ```bash
   git remote -v
   git branch -vv --no-color | head
   # 当前分支必须以 feature/<pinyin>/ 开头，否则不得 push
   ```
5. **查 handover 是否锁了我**（`§6.1.2` 流程）：
   ```bash
   for h in $(git ls-files docs/agent/handover/ | grep -v README); do
     echo "=== $h ==="
     grep -E "我需要别人确认的接口" "$h" || true
   done
   # 任何"owner: <my-pinyin>" 且 unresolved 的项 → 先解决再开工
   ```

#### 6.2.2 写代码过程中（每次 `git commit` 之前）

1. **小步提交**：一个 commit 一个逻辑改动；禁止混入"顺手清理"和重构。
2. **commit 前 3 件套**：
   ```bash
   git status
   git diff --stat                      # 看清楚改了什么
   git add <具体文件>                   # 不要 `git add .` / `-A`
   git commit -m "<scope>: <summary>"   # 多行 message 见 §5.2
   ```
3. **commit message 必含 `Tests:` `Docs:` `Risks:` 三段（任一段可简写但不得全省）**。
4. **当日必写日志**（`§6.1.1`）：commit 之前先 `cat >> docs/agent/logs/<branch>/<branch>-$(date +%F).md` 加一段当日更新；否则 CI gate 拒合入 develop。
5. **绝不** `git commit --amend` 已 push 到远端的 commit（会改写历史 → 别人 rebase 失败）。本地未 push 的 commit 可以 amend。
6. **绝不** 用 `git commit -m ""` 空 message；CI gate 拒。

#### 6.2.3 推送 / PR 前

1. **必读 `docs/agent/handover/feature-*.md` 自己分支 + 别人分支**：
   ```bash
   git fetch origin
   # 自己分支
   cat docs/agent/handover/feature-<my-pinyin>-handover.md
   # 别人分支（看是否有 unresolved 项提到我）
   for f in docs/agent/handover/feature-*.md; do
     [ "$f" = "docs/agent/handover/feature-<my-pinyin>-handover.md" ] && continue
     echo "=== $f ==="; cat "$f"
   done
   ```
2. **推送前 rebase develop 一次**（吸收 base 的最新变更）：
   ```bash
   git fetch origin develop
   git rebase origin/develop
   # 有冲突：解决后 `git rebase --continue`；若冲突太多，改为 `git merge origin/develop` 但需在 PR 描述里说明
   ```
3. **推送**：
   ```bash
   git push origin feature/<pinyin>
   # 严禁 `git push --force` / `git push --force-with-lease`（除非已与挂靠主力 + Leader 约定）
   ```
4. **PR 描述模板**（`AGENT-CONTRIBUTION.md` §9 模板 + 引用 handover）：
   ```markdown
   ## What
   - <改动点>

   ## Why
   <目标 + 引用 docs/agent/handover/feature-<pinyin>-handover.md 的对应行>

   ## Tests
   - `npm test` → 525/525

   ## Docs
   - <改动的文档/日志/handover>

   ## Risks
   - <风险与回滚方式>
   ```

#### 6.2.4 合入 develop（仅 Leader / kultur 决定）

1. **Leader 评审通过后**：
   ```bash
   git checkout develop
   git pull --rebase origin develop
   # 切到主力/学习位的工作分支
   git checkout feature/<pinyin>
   git rebase origin/develop   # 把 develop 提上来
   # 强力确认：develop 在我们分支前面
   git log --oneline origin/develop..feature/<pinyin>
   # 合并（建议 no-ff 留审计线）
   git checkout develop
   git merge --no-ff feature/<pinyin> -m "merge feature/<pinyin>: <scope> (#<PR号>)"
   git push origin develop
   ```
2. **绝不允许直接 push master**。master 只在 release 周期由 kultur 推。

#### 6.2.5 常见错误模式与防

| 错误模式 | 触发后果 | 正确做法 |
|---|---|---|
| 没 `git fetch` 就 `git push` | 推掉别人刚合的变更 → 历史分叉 | push 前必 `git fetch origin` + `git status` 看"ahead/behind" |
| 在 develop 上直接 commit | 污染主线，团队历史被破坏 | 永远在 `feature/<pinyin>` 写 |
| `git pull` 替代 `git pull --rebase` | develop 出现无意义 merge commit，污染历史 | 默认用 `git pull --rebase` |
| `git push --force` 已 push 的 commit | 远端历史被改写，其他人 rebase 全失败 | 仅本地未 push commit 可 `commit --amend` |
| 多个 agent 同时改同一文件不协调 | 合并冲突 + 互相覆盖 | `§6` 写锁 `.agents/locks/*.lock` + `§6.1.2` handover 协同 |
| 把别人分支的内容 commit 进了自己 | 历史混乱、责任不清 | 误 pull 后 `git checkout 自己分支`，**不**与别人分支合并 |
| 一次 commit 塞 5 个不相关改动 | 评审难定位、回滚粒度大 | 小步提交；用 `git add <文件>` 而非 `git add .` |
| commit 时不写 message 或 `git commit -m ""` | 历史无信息 | commit message 必含 `Tests:` `Docs:` `Risks:` |
| 跨分支 rebase 后忘了 force-push 别人旧 commit | 远端分支会出现"两个根" | `git push --force-with-lease=refname:expected`（限自己分支）|
| 把 develop 当 feature 推 | 全员受影响 | develop 是"集成中"，不是"主分支"；feature 是 PR 目标 |

#### 6.2.6 CI gate（kultur 在 W1 末尾落到 `.github/workflows/agent-branch-guard.yml`）

- **pre-commit**：hook 检查当日 `docs/agent/logs/<branch>/<branch>-<date>.md` 已更新。
- **push 时**：
  - 当前分支若 = `master` 或 `develop` → 拒绝（仅 kultur 可推）。
  - 推送者 SSH key 不在 `KULTUR_KEY_FINGERPRINT` 白名单 → 拒绝（master/develop gate）。
  - 推送分支若 = `feature/<pinyin>` 但 `tasks/agents/<pinyin>.md` 不存在 → 拒绝（未注册）。
  - 推送分支若 PR 描述里没引用 `docs/agent/handover/feature-*.md` 中跟自己相关的行 → 拒绝（未读 handover）。
- **pre-merge 到 develop**：CI 必须 `npx tsc --noEmit` + `npm test` + `verify-panshalach-cleanup.mjs` + `node scripts/eval/smoke-eval.mjs` 全绿。



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
- [ ] 在 `tasks/agents/` 创建 **4 主力 + K 张学习位**注册卡（leader / shigan / zhongjianA / zhongjianB / intern-1 / intern-2 / ...），K 由 stand-up 上确定
- [ ] 在 `tasks/standups/` 建立目录；每周一上午开周会
- [ ] 4 主力 + K 学习位各自 `git checkout -b feature/<pinyin> origin/develop`（按 `AGENT-CONTRIBUTION.md` §B.2 注册）
- [ ] W1 接口契约 PR 全员提交 → 评审 → 合入 develop
- [ ] W1 末第一次 stand-up，K 与挂靠关系当场定

4 主力按本表各自领取 W1–W4 owner 任务；K 个学习位按 §5.5 挂靠矩阵做"文档 + 脚本 + 学习"。所有 PR 走 `AGENT-CONTRIBUTION.md` §5.3 流程。
