# Zorge CLI 对标完美工具：差距分析与完善路线图

> 对标对象：Claude Code、OpenAI Codex CLI、DeepSeek Harness (DSH)、Hermes（本机完整源码）。
> 证据级别说明：Hermes 为**本机安装的完整源码直接审读**（最高置信）；Codex/Claude Code 为本机配置/会话工件 + 公开资料知识（中高置信，个别细节标 [待验证]）；DSH 为本机安装的全部包清单 + 运行时行为（高置信）。

---

## 一、四个标杆的架构拆解

### 1.1 共同骨架：「事件流内核 + 富客户端」

四家虽然技术栈不同，但架构同构：

```
┌─────────────────────────────────────────────────┐
│ Agent 内核（工具执行 · 权限 · 会话持久化 · 压缩） │
└──────────────┬──────────────────────────────────┘
               │ 结构化事件流（token 级 delta / tool 生命周期 / 交互请求）
┌──────────────▼──────────────────────────────────┐
│ 富终端客户端（Ink / Ratatui，增量渲染，固定布局）│
└─────────────────────────────────────────────────┘
```

### 1.2 Claude Code

本机 `.claude/` 目录暴露了其功能面：`file-history`（文件级 checkpoint/回滚）、`plans`、`tasks`、`jobs`（后台任务）、`paste-cache`（大粘贴落盘）、`shell-snapshots`（shell 环境快照）、`session-env`、`history.jsonl`、`plugins/skills/teams`。

- **交互原语**：plan 模式（提方案→批准→执行）、TodoList 跟踪、AskUserQuestion 选择题、后台 subagent/job 通知回流。
- **权限**：每个敏感操作走审批；沙箱文件策略分级（read-only/workspace-write/danger-full-access），拒绝时可一键提权重试。
- **上下文工程**：自动 compact（checkpoint 摘要替换早期对话）、system-reminder 注入、技能按需加载。
- **输出**：token 级流式 markdown，思考块折叠，工具卡片 pending→running→结果折叠。

### 1.3 OpenAI Codex CLI（Rust）

本机证据：`config.toml`（`wire_api = "responses"`、`[mcp_servers]`、sandbox 目录）、`sessions/YYYY/MM/DD/rollout-*.jsonl`（append-only 回放文件）、sqlite state/logs/memories/goals。

- **TUI**：Rust + Ratatui/crossterm，alternate screen，自绘滚动 [待验证：具体 crate 组合]。
- **审批三级**：read-only / auto / full-access，命令级 allowlist，patch 应用前 diff 确认。
- **会话**：rollout jsonl 天然支持 `codex resume`；/compact 手动压缩；AGENTS.md 项目记忆（/init）。
- **MCP**：stdio server 一等公民。

### 1.4 DeepSeek Harness (DSH)

本机安装了 ~150 个包，命名即架构：`dsh-agent-loop`、`dsh-session-persistence-jsonl`、`dsh-session-projection(-cache)`、`dsh-compaction-*`、`dsh-permission-presets`、`dsh-sandbox(-windows-acl)`、`dsh-plan-mode`、`dsh-tool-todo`、`dsh-user-questions`、`dsh-token-meter`、`dsh-client-ui-tool/conversation/plan/goal/...`（Web GUI 用 slot/theme 插件体系）。

- **双平面**：Host 组合（注册表/持久化/沙箱/模型路由）+ 会话预设；一切能力皆插件行。
- **会话即投影**：jsonl 事件源 → projection 缓存查询；compact 是独立策略包。
- **审批闭环**：user-questions / user-approval 包 + UI 卡片，拒绝即最终态。

### 1.5 Hermes（本机完整源码，重点）

Python agent ↔ gateway ↔ **React 19 + 自 fork Ink（`@hermes/ink`）TUI**（nanostores 状态）。`ui-tui/src/gatewayTypes.ts` 给出完整事件分类法：

- **token 级流**：`thinking.delta` / `reasoning.delta` / `message.delta` / `message.interim` / `message.complete`
- **工具生命周期**：`tool.generating` → `tool.start` → `tool.progress`(name+preview) → `tool.complete`
- **交互请求**：`approval.request`（command/description/allowPermanent/smartDenied）、`clarify.request`、`sudo.request`、`secret.request`(+expire)
- **子代理树**：`subagent.spawn_requested/start/thinking/tool/progress/complete` + spawn_tree list/load，进度含 costUsd/tokens/filesRead/Written/sparkline
- **会话操作**：create/resume/list/**branch**/**undo**/**compress**/interrupt/**steer**/usage/title
- **回滚检查点**：`rollback.list/diff/restore`
- **排队消息**：QueuedMessages 组件（运行中输入排队，回合结束自动处理）

渲染工艺（值得抄的工程细节）：
- `streamingMarkdown.tsx`：**O(tail) 增量 markdown**——已完结顶层块冻结进 append-only 数组各自 memo，只有未完结尾巴逐 delta 重解析；围栏/数学定界符状态机只前进不回退。
- `thinking.tsx`（1237 行）：活动工具 spinner（braille 动画族）、工具轨迹含时长、子代理树 tree-rails + sparkline + hotness。
- `details` 三态模型：`hidden|collapsed|expanded` × 分节（thinking/tools/subagents/activity），配置可覆盖。
- `appLayout.tsx`：AlternateScreen + ScrollBox（fork Ink 新增）、transcript scrollbar、composer 高度稳定算法（inputMetrics）。
- `markdown.tsx`（1178 行）：自研语法高亮 lib、数学→Unicode、外链标题抓取。

---

## 二、Zorge 差距矩阵

现状审计结论（代码为准）：引擎有六档强度/多 rollout/记忆/审查骨架，SSE 通道与 Ink 三区 UI 已接通；但存在一个**根本性缺口**和若干结构性差距。

| # | 层次 | 标杆做法 | Zorge 现状 | 差距 |
|---|------|---------|-----------|------|
| A | **执行层** | 真 shell/文件写/diff/测试，卡片展示真实结果 | `ZorgeChaser.ts:335` verificationEngine 是 stub `{execute(){return 'ALL_TESTS_PASSED'}}`——**工具被解析但从不执行** | 🔴 致命 |
| B | **流式** | token 级 delta（四家皆是） | model client `stream:false`，`complete()` 整段阻塞；onStep 仅步骤完成触发；SSE 是步骤级重播 | 🔴 核心 |
| C | **权限/审批** | 分级模式 + 操作级审批 + diff 确认 | 仅高档位任务前确认；无写盘审批、无 diff 预览、无 sandbox | 🔴 与 A 绑定 |
| D | **会话资产** | rollout jsonl/resume/undo/checkpoint/compact/token 表 | Session JSON save/load；无 resume 中断任务、无 checkpoint/undo、无 compact、无 usage 面板 | 🟠 大 |
| E | **UI 工程艺** | 增量 markdown、三态折叠、spinner、滚动管理 | ThoughtBlock `onClick` 在 ink 中无效（死交互）；Markdown 每 delta 全量重解析（当前无 delta 尚不痛）；Feed 窗口 80 硬编码；无 alternate screen/scrollback 策略 | 🟠 中 |
| F | **输入体验** | fuzzy slash、@预览、paste 检测、排队消息、steering | readline 补全 + `:` 多行；/edit 刚落地；无排队/插话 | 🟡 中 |
| G | **生态** | MCP、hooks/skills、subagent 可视化 | 无 MCP；多 rollout 未可视化；无插件面 | 🟡 后置 |
| H | **传输架构** | 同进程直连或跨进程网关二选一，各得其所 | 默认路径 = 进程内起 HTTP server 再 loopback fetch 自消费（单机纯开销）；quiet 已零日志 | 🟡 架构债 |

---

## 三、完善路线图（P0→P5，可直接排期）

> 排序原则：先修「假」的东西（A/B 是演出与真实的分界），再补「资产」（D），再磨「手感」（E/F），最后「生态」（G）。

### Phase 0 —— 止血与去虚（✅ 已交付）

| 项 | 内容 | 状态 |
|---|------|------|
| 0.1 | ThoughtBlock 键盘驱动 + ctrl+o transcript 模式（ZorgeApp 全局 useInput → Feed → FeedItem → expanded）| ✅ |
| 0.2 | 去 loopback：`runAgentTask` 抽为独立模块，默认进程内直连；SSE 服务保留给 `/serve` | ✅ |
| 0.3 | TopBar 上下文计量（ctxRatio 启发式 chars/4 ÷ `ZORGE_CTX_WINDOW`），「N% context used」着色 | ✅ |
| 0.4 | Feed 窗口常量 FEED_WINDOW + 连续 phase 去重 | ✅ |
| 附加 | **provider 全局单例**（getSharedModelProvider/resolveSharedClient）：REPL、内嵌执行器、serve 三端共享热配置；失败自动热重载重试一次 | ✅ |

### Phase 1 —— 真流式（✅ 已交付，含思维链阶梯）

| 项 | 内容 | 状态 |
|---|------|------|
| 1.1 | `streamChat()` 落地 openai-compatible（fetch SSE）与 UniversalMaoyulinClient（node https SSE）；解析 `reasoning_content`→thinking / `content`→text；端点不支持流式自动回退 complete()。mock-SSE 单测 3 例全绿（含多事件单 TCP chunk）| ✅ |
| 1.2 | 协议 v2：`thinking.start/delta`、`message.start/delta` 在 ZorgeChaser client 拦截层发出（引擎零改动）；classic Repl 与行渲染器过滤 v2 防刷屏 | ✅ |
| 1.3 | `ui/streamingMarkdown.ts` 冻结块扫描器：blank-line 分块 + 围栏状态机 + **lineBuf/blockBuf 双缓冲**（跨 delta 的半行正确续接——修复了单缓冲把换行误判为空行的缺陷）；5 例单测含逐字符流等价性 | ✅ |
| 1.4 | StreamingAssistant 实时区：💭 思考尾随 + 回答冻结块(MarkdownBlock 各自 memo) + 活动 tail + ▍光标；bridge appendStream/resetStream(kind)；step/critique/result/done/error 自动收敛 | ✅ |
| 1.5 | 思维链阶梯 `<thinking_budget>`（high=think/max=think hard/ex·zorge=ultrathink）+ ctrl+o transcript + ⏱ 尾注 | ✅ |

### Phase 2 —— 真执行（✅ 已交付，M1 验收战通过）

| 项 | 内容 | 状态 |
|---|------|------|
| 2.1 | ToolExecutor 内核（pathGuard 双重校验 / readFile 分页行号 / glob+grep 自实现 / executor 别名归一 + 20k 截断 + 5s 超时 / engineAdapter 字符串兼容层）；ZorgeChaser stub 替换为真适配器 | ✅ |
| 2.2 | bash：shell:true + tier 超时（30s/60s/120s，硬顶 600s）+ 超时杀树（taskkill /T /F）+ ZORGE_EXEC 注入 + danger 标记；readonly 白名单第一天生效 | ✅ |
| 2.3 | 自写 LCS diff（CRLF 归一/规模护栏）；write_file/edit_file：**diff 先于写盘**、RBW 铁律、edit 唯一性（found N）、原子 tmp→rename、1MB 上限；ToolCard 三色 diff + 40 行折叠 | ✅ |
| 2.4 | 审批层：readonly(默认第一天)/default/full 三档 + 会话 allowlist('a') + readline/headless 桥 + 60s 超时=n + /approvals 命令 + Session 持久化 + ToolCard denied 态 | ✅ |
| 2.5 | loop 识别 `EXIT_CODE:0` 强信号（didRealVerification 有真实 bash 证据）；ZorgeChaser 审批透传；**M1 验收战通过**（buggy-calculator 红→绿，全程卡片可见，详见 docs/M1-ACCEPTANCE.md） | ✅ |

验收战证据：红基线 `fail 1 / exit 1` → 引擎真实 edit_file（+1/−1 diff 卡）+ 真实 npm test（pass 2 / EXIT_CODE:0）→ 独立复跑 `exit 0`。Windows spawn 注意项已内建（shell:true / posix-only detached / 路径 path API 归一）；ACL 沙箱仍为后置项。

### Phase 3 —— 会话资产（✅ 已交付）

| 项 | 内容 | 状态 |
|---|------|------|
| 3.1-3.4 | rollout ——resume / file-history --undo / /compact+auto-compact / /usage | ✅（M2.1-M2.4） |
| 3.5 | --branch 只读 rollout fork（分支指针 + 原样重放 + branch-of 链解析）+ /resume 命令（branch 标记）+ /status branch of | ✅ |
| 3.6 | /rewind 回合级回放（listByTurn 聚合 + preview/apply 分离、create-回退删除、bash 排除、审计事件） | ✅ |
| 3.7 | 后台预压缩（startBackgroundCompact 快照计算 + 防重入 + 任务边界 applyCompactResult + 确定性兜底 + sync 临界兜底） | ✅ |

| 项 | 内容 | 验收 |
|---|------|------|
| 3.1 | rollout jsonl：把 Session.addTurn 升级为 append-only 事件文件（对齐 codex rollout / dsh-session-persistence-jsonl）；`zorge --resume` 列最近会话恢复 | 断电重启后上下文完整 |
| 3.2 | file-history checkpoint：每次 edit/write 前快照到 `~/.zorge/file-history/<session>/`；`/undo` 回滚最近一次写；`/rollback` 列检查点+diff+恢复（对齐 Hermes rollback.*） | undo 后文件还原并展示 diff |
| 3.3 | /compact：超阈值把旧 turns 摘要化（用模型自身生成摘要，保留 budgetReport/教训卡）；usage 面板显示压缩次数；**顶栏文案照抄 CC 实证**：`N% context used` / `N% until auto-compact` 倒计时 + 低余量横幅 `Context low (N% remaining) · Run /compact to compact & continue`；支持后台预压缩（阈值前提前算摘要） | 长会话不再线性膨胀；顶栏出现倒计时 |
| 3.4 | /usage 命令 + 顶栏 cost 区（本地估算：tokens×单价表，provider 可配单价） | 数字与 provider 后台量级一致 |

### Phase 4 —— 输入手感（✅ 已交付）

| 项 | 内容 | 状态 |
|---|------|------|
| 4.1 | FuzzyMatcher：前缀 0.98 / 子串 0.8 / 子序列 0.4-0.59 / 半长容忍 0.35-0.40 分带 + 别名 0.95 折扣 + 注册序稳定 + top-8；Completer 精确前缀优先、miss 走 fuzzy（/tl→/tier DoD 命中） | ✅ |
| 4.2/4.3 | InputQueue（FIFO 任务 + steer 收件箱）+ 运行中路由（/ 即时、! 插话、文本排队）+ `queued ×N`/`steered ×N` 徽标 + 下一轮【用户插话】prompt 注入 + Ctrl+C 丢插话保任务 | ✅ |
| 4.4 | PasteGuard：>3 行或 >2000 字符判定；行模式折叠确认两段式流 | ✅（rich 待 ink 粘贴事件，注明） |
| 4.5 | 手写 stringWidth（CJK/全角/Hangul/emoji=2、组合/ZWJ/VS=0）——供下游渲染器；readline/ink 自带宽度处理故不注入（注明） | ✅ |
| 4.7 | ModeRing（plan/default/auto-accept/full + shift+tab）+ plan 硬约束：PromptBuilder `<plan_mode>` 块 + adapter 前置拒绝（读放行、写/bash 拒）；TopBar [PLAN]/[AUTO]/[FULL] 徽标；/mode 无键位入口 | ✅ |
| 4.8 | 键位：shift+tab/ctrl+o/ctrl+t（轻量面板）/双 Esc 清队列 + ConfirmBar y/n/a；ctrl+r 交互式搜索未做（偏差申报），line 端 /mode 兜底 | ✅ |
| 4.9 | 双语 gerund spinner（≥24 条不连续重复）+ 行模式 4s 内联刷新 + `⏱ Ns`（timer unref） | ✅ |

| 项 | 内容 | 对标 |
|---|------|------|
| 4.1 | fuzzy slash 注册表（分类 + 别名 + 子命令，模糊评分） | Hermes slash/fuzzyScore |
| 4.2 | 排队消息：running 时输入进入队列显示「queued ×N」，回合结束依次处理；Esc 中断时可选丢弃 | Hermes QueuedMessages |
| 4.3 | steering：运行中输入以「用户插话」注入下一轮 prompt（VerifyCritiqueLoop 每步检查 inbox） | Hermes session.steer |
| 4.4 | paste 检测：>3 行或 >2000 字符粘贴转附件式预览「[粘贴 N 行，Enter 展开]」 | Claude Code paste-cache |
| 4.5 | CJK 宽字符输入修正：光标列计算用 stringWidth（ink 自带）而非 length | Hermes inputMetrics |
| 4.6 | **队列消息完整交互（CC 实证）**：运行中输入入队显示「queued ×N」；`↑` 编辑队首消息、`Enter` 立即发送；双击 `Esc` 清空输入 | CC "Press up to edit queued messages, Enter to send them immediately" |
| 4.7 | **模式环 shift+tab（CC 实证）**：plan → default → auto-accept-edits → (full) 循环切换，底栏显示当前模式徽标；plan 模式下系统注入「MUST NOT make any edits」硬约束，退出 plan 走 ExitPlanMode 确认卡（Yes/No） | CC confirm:cycleMode / "Claude wants to exit plan mode" |
| 4.8 | 键位表对齐 CC：ctrl+o=transcript 全量视图、ctrl+t=todos 面板、ctrl+r=历史搜索、esc=中断/回退；帮助浮层列出全部键位 | CC keybinding map |
| 4.9 | Spinner 动词表（gerunds）：任务运行中随机展示「Pondering… / Ruminating… / Simmering…」风格动名词 + 计时（CC 同款趣味列表，可中文化） | CC gerund spinner list |

## 附录：工具契约直接采用 sdk-tools.d.ts 形状

Phase 2 的 executor 入参/出参**逐字段照抄** `@anthropic-ai/claude-code/sdk-tools.d.ts`（v2.1.237，本机实证），关键点：

| 工具 | 契约要点（实证） |
|---|---|
| Bash | `command` + `description`（**审批卡上展示这句人话描述**）+ `timeout`(≤600000) + `run_in_background` + `dangerouslyDisableSandbox` |
| Edit | `file_path` + `old_string` + `new_string` + `replace_all`（str-replace 语义，唯一性校验报错文案学 CC："must appear exactly once"） |
| Read | `offset`/`limit` 分页；输出带行号（cat -n 格式），大文件截断提示续读位置 |
| Agent(subagent) | `description`(3-5词) + `prompt` + `subagent_type` + `model` + `run_in_background`(默认 true) + `isolation: worktree` |
| AskUserQuestion | questions[] × options[]{label, description} + multiSelect + 推荐项置首标 "(Recommended)" —— Zorge 的 ConfirmBar 升级为通用选择题卡 |
| ExitPlanMode | plan 批准门；allowedPrompts 已废弃说明 plan 审批已简化为整体 Yes/No |
| TaskOutput | `task_id + block + timeout` —— 后台任务取输出的轮询契约 |

> 以上字段名与语义可直接作为 Zorge ToolCall params 规范，使未来接入 CC 兼容生态（MCP/SDK 工具描述）零翻译成本。

### Phase 5 —— 生态（✅ 已交付）

- 5.1 skills 目录约定：`~/.zorge/skills/<name>/SKILL.md` + `<ws>/.zorge/skills/`（项目覆盖用户级），
  frontmatter（name/description/triggers）解析，任务命中注入 PromptBuilder（≤3 技能、≤2000 字符/技能）。✅
- 5.2 MCP stdio client：手写 JSON-RPC 2.0 over stdio（initialize/tools/list/tools/call，30s unref 超时），
  `.zorge.json` `mcpServers` 配置，工具注册 `mcp_<server>_<tool>` + classify 门控，崩溃优雅降级。✅
- 5.3 子代理树：AgentTree 状态模型 + `/agents` 树形渲染（done/running/pending 汇总行 + 详情），
  诚实标注当前引擎串行执行（非伪造并行树）。✅

---

## 四、需要拍板的决策点

1. **Phase 2 做不做？** 这是「演示框架」→「真 agent」的分水岭，也是工作量最大的一块。若暂不做，Phase 1/3/4 独立有效。
2. **是否保留 in-process HTTP**：建议默认直连 + `zorge serve` 显式开服务（Phase 0.2）。
3. **是否自 fork ink**：Hermes fork 是为了 AlternateScreen/ScrollBox/mouse。建议先用原生 ink5 + 「inline 模式 + 底部 composer」策略（Claude Code 同款），确有滚动痛点再评估 fork。
4. **审批默认档**：建议 `readonly` 为默认（安全），`/approvals default` 一键放开工作区写。

## 五、红线（继续遵守）

- 引擎不知晓 UI/传输；所有新事件走既有 onStep/onEvent 通道。
- optionalDependencies 纪律不破；非 TTY/smoke 永远静默经典路径。
- 每个 Phase 独立可交付、可回滚（immutable package 思维同样适用于 git 提交粒度）。

---

## 六、Claude Code 深挖补充（v2.1.237 本机实证）

> 来源：`AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\`（bin/claude.exe 330MB 原生二进制 + sdk-tools.d.ts 156KB 工具契约）。以下全部为二进制字符串扫描与类型文件直读所得，非猜测。

### 6.1 思维链（用户点名的高价值项）

CC 的思维链是**三层管线**，Zorge 应整体照搬：

1. **预算阶梯（模型侧）**：prompt 中 "think" < "think hard" < "ultrathink" 触发递增 thinking budget（二进制中 `\bultrathink\b` 正则 + `ultrathink_effort` 事件实证）。→ Zorge 映射：六档 tier 直接决定注入哪个关键词档位，无需用户手打。
2. **摘要呈现（API 侧）**："API-side thinking summaries and show them in the conversation and in the transcript view (ctrl+o)" —— 思考以**摘要形态内联折叠展示**，全文进 transcript 视图。→ 解决 Zorge ThoughtBlock「全量太长/截断丢信息」两难：卡片=摘要，ctrl+o=全文。
3. **耗时尾注**：每回合后显示 "Cooked for Nm Ns"（设置项实证）。→ 对应 Zorge result 卡片加 `⏱ N.Ns`。

### 6.2 上下文计量（比 Hermes 更细）

- 顶栏双态文案（代码级实证）：`${pct}% context used` 或 `${pct}% until auto-compact`（倒计时到真实压缩触发点，"Thin clients adopt it so the indicator counts down to the worker's real compaction trigger"）。
- 低余量横幅：`Context low (N% remaining) · Run /compact to compact & continue`；auto-compact 可关（`· auto-compact is off · /config to turn it on`）。
- **后台预压缩**："recompute the compaction summary in the background before it is needed. Only applies when auto-compact is on" —— 压缩在阈值前后台预计算，到达时零等待。压缩有 hook 面（pre_compact / compact_start / PreCompact hook 可阻断）。

### 6.3 模式系统

- 权限模式全集（实证）：`plan / default / acceptEdits(auto-accept edits) / dontAsk / bypassPermissions`，shift+tab = confirm:cycleMode 循环。
- plan 模式硬约束（system 注入原文）："Plan mode is active… you MUST NOT make any edits"；退出走 ExitPlanMode 工具 → UI 弹 "Claude wants to exit plan mode Yes/No"。
- 特殊组合档 `opusplan`："Opus in plan mode, else Sonnet" —— **按模式切模型**的思路可借鉴为「plan 用便宜档、执行用当前档」。

### 6.4 队列 / 回退 / 分支

- 队列消息：「Press up to edit queued messages, Enter to send them immediately」（↑ 编辑队首、Enter 立即发送）——比 Hermes 的纯排队更顺手。
- /rewind：「Snapshot files before edits so /rewind can restore them」「roll back the turn's tool edits (**bash-made changes excluded**)」——checkpoint 粒度=回合，且明确不背 bash 副作用的锅。Zorge Phase 3.2 应采用同语义。
- 会话分支：「You are now in the new branch… Use /resume to return to the original」——branch 是轻量操作，resume 列表跨分支。

### 6.5 键位总表（实证摘录）

| 键 | 行为 |
|---|---|
| esc / 双击 esc | 中断 / 清空输入 |
| shift+tab | 权限模式循环 |
| ctrl+o | transcript 全量视图切换 |
| ctrl+t | todos 面板 |
| ctrl+r | 历史搜索 |
| ↑（队列存在时） | 编辑队首消息 |

### 6.6 趣味层

Gerund spinner 动词表（数百个）：Pondering / Ruminating / Simmering / Vibing / Reticulating… 配合计时。低成本高记忆点，建议中文化移植（「推演中」「反刍中」「煨煮中」…）。

### 6.7 DSH 全局包补充结论

`AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` 仅是**启动器**（profile boot + plugin 管理 + patch 叠加），交互面在其 profile 组合包里（本会话已在 C:\Users\19395\node_modules\@deepseek-ai 全量盘点过）。新增信息：README 提及 `dsh --profile tui --resume <id>` 形态——生态内有 TUI profile 先例，`--resume` 属于应用层 flag 的约定值得照抄（启动器只认自己的 flag，其余全量透传）。
