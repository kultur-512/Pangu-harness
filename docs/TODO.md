# Zorge 待办清单（TODO / BACKLOG）

> 维护：审查员 + 编码 Agent 协作更新。
> 状态约定：`[待实测]` = 代码已交付、门禁绿、待真实终端验证；`[待办]` = 未开工或未交付；`[外部依赖]` = 依赖外部条件（网关/资源/用户操作）。
> 每项完成时划掉并注明提交/日期。

---

## 一、待实测（代码已交付，需真实 TTY 验证）

### T-01 rich 输入链路修复（1cfbbf5）—— 待终端实测
- **内容**：InputBar useInput 包 latestRef（消除 ink effect 重订阅时序依赖——快速输入不再命中旧闭包）
- **验证点**：
  1. 输入 `/` → 菜单立即出现（不再提交）
  2. 输入 `/model` → 必弹 provider 二级（不再显示"当前模型"）
  3. 完整链路：/model → provider → model → Enter 执行
- **状态**：`[待实测]`（2026-09-01 用户暂无法实测）

### T-02 rich 本地命令 + provider 预取（212a495）—— 待终端实测
- **内容**：rich 斜杠命令本地执行（/help /status /clear /tier + 未知斜杠本地警告，永不进引擎）；provider models 启动预取写 .zorge.json + providerOptions 纯本地读
- **验证点**：
  1. rich 输入 `/help` → 本地立即显示（零模型调用）
  2. `/model` → 二级菜单即时出现（无远程等待）
  3. 首次启动预取填充 models → 重启后即时
  4. `.zorge.json` 的 apiKey/baseUrl 字段完好（预取只增 models）
  5. `a6:glm-5.3-flash` 真实调用返回（422 已修）
- **状态**：`[待实测]`（2026-09-01 用户暂无法实测）

### T-03 驻留菜单方向/铺满（047f2d3）—— 待终端实测确认
- **内容**：菜单 direction='down'（从上往下）+ 三区自适应铺满（TopBar 顶 / Feed 中 / InputBar 底，resize 自适应）
- **验证点**：菜单从上往下、resize 时布局自适应
- **状态**：`[待实测]`（用户反馈过"UI 没有铺满上下"，修复后待复测）

### T-20 CC 统一 typeahead 重构（0c7cd2c）—— 待终端实测
- **内容**：交互层从"独立弹窗菜单"重构为 CC 统一 typeahead 建议引擎（建议条 + ghost text + Tab 接受 + ↑↓ 分流 + 输入缓冲 undo/redo）——这是此前所有菜单 bug（不弹/方向反/不铺满/等远程）的架构根治
- **验证点**：
  1. 输入 `/` → 建议条显示在输入框【正上方】（非弹窗）
  2. 输入 `/mo` → ghost text 灰色显示 "del"（/model 建议剩余）
  3. `/model` → provider 建议；`/model scnet 空格` → 模型建议（蓝色）
  4. Tab 接受 / ↑↓ 切换（无建议时历史导航分流）/ Enter 提交 / Esc 清建议（不清输入）/ Ctrl+Z+Y undo-redo
  5. 输入即显示（全本地同步，零等待）
- **文件建议注**：ctx.files 当前传 `[]`（SuggestionBar 就绪，FS 文件建议待后续注入）
- **状态**：`[待实测]`（2026-09-01 用户暂无法实测）

---

## 二、待办（未开工或未交付）

### T-04 T7 三路对照终局（a6 中转站）—— [外部依赖]
- **内容**：Zorge（a6）/ Claude Code / Hermes 三路对照，验证 #9+#10 修复双闭环
- **前置**：`new.maoyu.cfd` 网关稳定 or 三家统一可用中转（当前 a6 可用，claude 可用，hermes 网关不稳定）
- **复跑命令**：见 docs/DOGFOOD-REPORT.md 的 T7 复跑记录
- **状态**：`[外部依赖]`——等待网关/模型可用性稳定

### T-05 rich 模式补全经典命令 —— [待办]
- **内容**：rich dispatcher 现支持 /help /status /clear /tier /model /approvals 等；`/memory /review /history /trace /session /workspace /config /init` 在 rich 路径显示"未知命令"（属经典 Repl registry，sseInteractive 无实现）——如需 rich 支持逐个移植
- **状态**：`[待办]`（212a495 已标注）

### T-06 a6 上游模型不可用排查 —— [外部依赖]
- **内容**：`deepseek-v4-pro-0813` / `gpt-5.6-luna` 在 a6 返回 503/400 upstream_unavailable（上游瞬态）——非 Zorge 请求问题，稍后重试
- **状态**：`[外部依赖]`

### T-07 行模式运行中实时输入（排队语义）—— [待办]
- **内容**：行模式（bare readline）在任务运行时不收输入；终端行缓冲输入在任务结束后到达并自动执行（效果等价排队）。实时 `queued ×N` 徽标仅 rich 模式有
- **状态**：`[待办]`（P4-4.2 遗留，偏差已申报）

### T-08 ctrl+r 交互式反向搜索 —— [待办]
- **内容**：历史反向搜索未做（非 DoD 项；KeyHandler 白名单触及会牵动 classic 主循环，留待后续）
- **状态**：`[待办]`（P4-4.8 遗留）

### T-09 /agents rich 独立面板 —— [待办]
- **内容**：/agents 复用 feedOrLine 文本渲染，未做独立 React 面板（与 ctrl+t 轻量面板同策略）
- **状态**：`[待办]`（P5-5.3 遗留）

---

## 三、learn-harness 框架缺口（docs/LEARN-HARNESS-GAP.md 映射）

> 状态说明（fix-p2 文档对齐）：T-10~T-19 已全部交付（git log 证实），以下标记为 ✅ 已交付；
> 原"[待办]"标注已过时。剩余未闭合项见 T-21~T-25（审查缺陷清零 / 双实现统一 / serve 协议补全）。

### T-10 P0：ZIS.md 目录页化 —— ✅ 已交付（A-T10）
- **内容**：Instructions 子系统未目录页化（L04/Codex）——ZIS.md 拆"根目录页（~100 行：路由+不变量+验证命令）"+ docs/ 细节按需读
- **状态**：`✅ 已交付`（c5cf9da：ZIS.md 55 行目录页 + docs/ZIS-DETAILS/ 五章）

### T-11 P0：验证命令显式入 prompt —— ✅ 已交付（fix-p1）
- **内容**：Feedback 子系统——项目级验证命令作为资产显式注入 PromptBuilder（而非靠模型猜）
- **状态**：`✅ 已交付`（fix-p1：projectInstructions.ts 读回 .zorge/AGENTS.md 验证命令块注入 PromptBuilder）

### T-12 P0：环境自描述 —— ✅ 已交付（A-T12）
- **内容**：workspace 环境自描述（运行时版本/依赖锁定/验证命令清单）
- **状态**：`✅ 已交付`（1189e21：describeEnvironment → .zorge/ENV.md + 关键词门控注入）

### T-13 P1：/init 命令 —— ✅ 已交付（P1-T13）
- **内容**：生成项目指令/验证命令清单（对齐 CC /init）
- **状态**：`✅ 已交付`（4e1f04b：InitCommand + rich 统一复用；fix-p2 已更新 LEARN-HARNESS-GAP 漂移）

### T-14 P1：特性追踪 feature_list.json —— ✅ 已交付（P1-T14）
- **内容**：当前 feature/状态/证据/下一步（L08：特性列表是 harness 原语）
- **状态**：`✅ 已交付`（4e1f04b：FeatureTracker + /feature list/add/done/next，done 强制证据）

### T-15 P1：压缩策略可插拔 —— ✅ 已交付（P1-T15）
- **内容**：compact 策略接口化（主题/代码感知/换模型摘要，对齐 Pi）
- **状态**：`✅ 已交付`（1bf6ab0：CompactStrategy 接口 + default/topic 内置 + .zorge.json 选择）

### T-16 P1：tools/pre-execute 事件化 —— ✅ 已交付（P1-T16）
- **内容**：工具预执行钩子事件点（安全/策略以监听器附着，对齐 DeepSeek）
- **状态**：`✅ 已交付`（75525f3：tools/pre-execute + post-execute emit 事件点；注意：当前为 emit-only 广播，无可拦截钩子）

### T-17 P1：增量环境上下文 —— ✅ 已交付（P1-T17）
- **内容**：只输出变更字段（对齐 Codex build_environment_update_item）
- **状态**：`✅ 已交付`（75525f3：buildEnvDelta/renderEnvDelta 注入 PromptBuilder）

### T-18 P2：会话树 —— ⚠️ 视图级已交付
- **内容**：/tree 回任意节点；branch 是线性，树是下一步（对齐 Pi）
- **状态**：`⚠️ 视图级`（a66a974：listSessionTree + /tree 渲染；切换需退出重启 /resume）

### T-19 P2：图工程 —— ⚠️ 建模级已交付
- **内容**：多 agent 并行图（L14）；AgentTree 已预留；Goodhart/盲视/冲突三失败需设计规避
- **状态**：`⚠️ 建模级`（79b5299 + 8500771：AgentTree 边/路由建模 + high+ 档并行 rollout 引擎）

---

## 四、历史遗留（已记录，低优先）

- bash.test 孤儿进程（ping taskkill 幸存）——已修（8b10133），留档
- OutputRenderer progressBar ANSI 断言环境性——M2.5 已修
- e2e/approval 文件级进程挂起——M2.0 已修

---

## 五、只读审查发现（fix-p0-sec/fn/path + fix-p1 + fix-p2 已闭环）

> 2026-09 只读审查（12 功能 bug + 5 安全 + 死代码/文档漂移）已按 5 批修复。
> 以下为修复后仍存在的**结构性缺口**（非本次修复范围，留待后续航向）：
> 二级审查（docs/REVIEW-2ND-AUDIT.md）另发现 3 项，见 T-27~T-29。

- **T-21** 模型接入面 = 单一 OpenAI Chat Completions 文本协议：无原生 tool calling
  （请求不带 `tools` 参数、响应忽略 `message.tool_calls`、无 tool_call_id 回填）——
  工具循环靠 GLM XML 文本标签 + 正则回读解析。对齐 CC/Codex 的最大单项差距。
- **T-22** 流式主路径断路：`ProviderRegistry.createClientSync` 只暴露 `complete`，
  丢弃 `streamChat` → 生产恒走非流式，`thinking.delta/message.delta` 端到端不发出；
  `delta.tool_calls` 流式缺失。
- **T-23** PASS 判定链路：`classifySignal` 只认大写 `ALL_TESTS_PASSED`，真实工具输出的
  `EXIT_CODE:0` 不触发 PASS → 成功靠 ZorgeChaser 步数启发式（35+2×steps）判定；
  打分公式含 `!detectedFormat` 恒加分（严格路径 detectedFormat 恒空）。
- **T-24** serve 协议补全：仅 POST /api/run 单端点；无会话/用量/审批/子代理端点；
  事件直通无规范化（S4 鉴权已修）。
- **T-25** 双实现统一：/init（已统一）、命令分发（registry vs sseInteractive 内置）、
  SessionStore vs rollout jsonl（双真相漂移）——命令分发统一待办。
- **T-26** 无 429 重试/退避：`VerifyCritiqueLoop` 对模型调用零容错，单次瞬时失败杀整个 rollout。

---

## 六、二级审查发现（docs/REVIEW-2ND-AUDIT.md，2026-09）

> 二级审查员验收 5 批修复后记录。前两项为修复指令清单遗漏（原始审查已识别），
> 第三项为 B5 修复引入的回归。
> ✅ 三项均已修复并提交（commit `redesign-p0`，分支 `chore/zorge-cc-redesign`），配套回归测试绿。

- **T-27【遗留·高危 → 已修复】MCP 'a' 决策错误解锁 bash**（engineAdapter.ts）：
  `sessionAllowlist.add('bash')` → 按 MCP 工具全名放行（`mcp_<server>_<tool>`），绝不解锁 bash。
- **T-28【遗留·高危 → 已修复】readonly 白名单命令链穿透**（readonlyAllowlist.ts）：
  新增 `CHAIN_OR_REDIRECT_RE` 整体拒绝含 `;`/`&&`/`||`/`|`/`>`/`>>`/`<` 的命令链（`ls; rm -rf .` 拒绝），而非只查首 token。
- **T-29【回归·P1 → 已修复】B5 修复后双 Esc 清空失效**（typeahead.ts `doubleEscState` + InputBar.tsx）：
  双 Esc 计时与 suggestionsDismissed 解耦（任何 Esc 都更新计时，300ms 内第二次无条件触发清空）。

---

## 更新日志

- 2026-09-01：新建本清单。落档 T-01（rich 输入链路）、T-02（rich 本地命令+预取）、T-03（菜单方向/铺满）为待实测；T-04~T-09 为既有待办；T-10~T-19 为 learn-harness 框架缺口。
