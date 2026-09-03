# Zorge 详细改动日志（CHANGELOG-DETAIL）

> 本文件记录 Zorge 自项目启动以来的全部改动（按战役/里程碑分组，逐提交落档）。
> 与 CHANGELOG.md（版本级摘要）互补：本文件是**提交级明细**，可追溯每一批的具体内容。
> 状态：截至 2026-09（89 提交，420+ 用例）。

---

## 0. 项目定位

Zorge：零强依赖的工程 Agent CLI——真实工具执行、四档审批、会话资产（resume/branch/undo/rewind/compact）、MCP 生态接入、CC/Hermes 同构交互。六档强度体系（quick/standard/high/max/ex/zorge）。

---

## 一、M1 真实执行（e47a11f → fe02590）

### baseline+M1-2.0（e47a11f）
- 仓库基线（git init 于 2.0 后，root commit 含 2.0 内容，如实标注）
- ToolCallFormatDetector Rule-ABC 修复（纯文本→格式漂移根因）
- ui require → static import（ESM 拆雷）

### M1-2.1 只读工具内核（9a7003a）
- `src/tools/`：pathGuard（resolveUnderWorkspace 围栏）/ readFile（cat -n 分页）/ glob（自实现）/ grep / executor（注册表+别名归一）/ engineAdapter（loop 兼容层 + isSmokeEnvironment 安全闸）
- ZorgeChaser stub → createEngineAdapter 接线（真实执行）

### M1-2.2 bash（8d12a6a）
- bash 工具（spawn + 树杀超时 + 20k 截断 + danger 标记）
- readonlyAllowlist（day-one readonly 执行于 adapter）

### M1-2.3 diff + 写工具（0fccf7c）
- LCS 行级 diff（computeLineDiff）
- write_file / edit_file（diff-first、RBW 铁律、原子 tmp→rename）
- ToolCard diff 渲染

### M1-2.4 审批层（cab12b7）
- approval.ts 三档（readonly/default/full，默认 readonly 第一天生效）
- /approvals 命令 + Session 持久化 + ConfirmBar 接线

### M1-2.5 收尾（fe02590）
- VerifyCritiqueLoop EXIT_CODE:0 识别（真实验证信号）
- ZorgeChaser 审批透传 + docs（ZIS M1 章 / ROADMAP P2 / M1-ACCEPTANCE）+ 验收驱动

**M1 验收**：buggy-calculator 端到端红→绿（真实 npm test 证据），Zorge 首次成为真 Agent。

---

## 二、M2 安全执行 + 会话资产（b0e8500 → b267ebe）

### M2.0 清债（b0e8500）
- ConfirmBar 真接线（bridge confirm 状态机 + y/n/a 键）
- 挂起根修：审批竞争计时器 clear/unref + e2e readline 释放
- isTTY 红线入档 + verify-m2-confirm

### M2.1 file-history checkpoint + /undo（5695ad3）
- workspace 哈希隔离 checkpoint + JSONL 索引，可逆，新建 undo=删除

### M2.2 rollout jsonl + --resume（9a3ce80）
- append-only jsonl（坏行容忍）+ --resume [id|last] + turn/审批审计

### M2.3 /compact + auto-compact（50bf902）
- 模型摘要 + 确定性兜底（保 6 轮）+ 85% 预检 + TopBar 倒计时

### M2.4 /usage（ff7a507）
- 本地成本核算（session stats + 可选 usagePrices，零密钥访问）

### M2-final（4c78ed2）
- unref 移除（时限正确性）+ docs + test 脚本 --import 修复

### M2-2.5 清债（b267ebe）
- memory 读纯化（loadFiltered 不再污染 lastUsedAt）+ 公开 effectiveWeightOf
- Reviewer 假 tsc 检测（工具失败≠通过护栏）
- provider 权威配置 + mock fetch 禁网测试
- renderer 能力桩（PSModulePath/TERM/NO_COLOR）

---

## 三、P3 会话资产剩余（8d4ce7f → 2060a15）

### P3-3.5 --branch（8d4ce7f）
- rollout 只读 fork（branchOf 指针 + 原事件重放）+ /resume 分支标记

### P3-3.6 /rewind（3dc3d56）
- 回合级回放（listByTurn 聚合 + preview/apply 拆分 + create-undo 删除 + bash 排除）

### P3-terminal 后台预压缩（2060a15）
- startBackgroundCompact（快照计算 + 防重入 + 任务边界 apply + 确定性兜底）

---

## 四、P4 输入手感（5ca3903 → b088247）

### P4-4.2/4.3 排队 + 插话（5ca3903）
- InputQueue（任务 FIFO + steering inbox）+ 运行中路由 + 下一轮注入 + abort 语义

### P4-4.1 fuzzy 补全（e9a3a0e）
- FuzzyMatcher（前缀/子串/子序列分层 + 别名 + top-8）+ Completer fuzzy fallback

### P4-4.7/4.8 模式环 + 键位（2338875）
- ModeRing（plan/default/auto-accept/full）+ plan 硬约束 + shift+tab + /mode

### P4-4.4/4.5/4.9 粘贴/CJK/spinner（a502a0e）
- PasteGuard（阈值折叠）+ stringWidth（CJK/emoji 手写）+ 双语 gerund

### P4-final（b088247）
- 键位/模式文档 + gerund 定时器 + 行模式粘贴确认流

---

## 五、P5 生态（b22a6bf → a2bb078）

### P5-5.1 skills 目录约定（b22a6bf）
- 双目录扫描（用户级+项目级，项目覆盖）+ frontmatter + CJK 匹配 + PromptBuilder 注入

### P5-5.2 MCP stdio client（07292a7）
- 手写 JSON-RPC 2.0（握手/超时/崩溃容错）+ executor 命名空间 + classify 门控

### P5-5.3 子代理树（13666b1）
- AgentTree（幂等 upsert + 状态阶梯 + 稳定序）+ /agents + 诚实串行标注

### P5-terminal（a2bb078）
- ROADMAP Phase 5 标记交付（P0-P5 全部完成）

---

## 六、dogfooding 战役（21480fe → 1f93840 合并）

### dogfood-T1..T7（fe0abb8 → 21480fe）
- T1 contextLines=0 修复 / T2 looksBinary off-by-one（播种逃过既有测试=覆盖盲区）/
  T3 ZWSP/ZWNJ 宽度 / T4 runSyncCompact 抽取 / T5 rollout 轨迹表 + pathGuard 证据 /
  T6 walkFiles maxFiles 机制测试 / T7 maxHunks（ctx 不计+全替换豁免）
- 8 条短板记录（docs/DOGFOOD-REPORT.md）
- **发现 #9**：真实任务工具格式漂移（iron_law_check 误调）——prompt 文本误当工具名

### 收尾三件（a35a286 → 1fcc3b7）
- dogfood-① --headless 逃生口（SMOKE 最高优先）
- dogfood-③ looksBinary 边界测试（回归守卫实证双红）
- dogfood-④/⑤ 杂项清理（.sandbox-test/、test-*.mjs、probe-*.cjs 移出追踪 + gitignore）

### 合并 + T7 补跑（1f93840 merge + 60ced16 doc-T7-a6）
- 4 bug 修复 + maxHunks + --headless 合入 master，v0.4.0
- T7 三路对照（a6 中转站）：Zorge 误调 5→1、得分 75 但零交付（RBW 卡死新短板 #10）

---

## 七、#9+#10 修复（85f386f → 7fbd573）

### fix-#9-① 负向清单（85f386f）
- `<negative_tool_list>` 注入（iron_law_check/thinking/plan/critique 声明非工具）

### fix-#9-② 运行时护栏（217f375）
- UNKNOWN_TOOL 记账（TOOL_FORMAT_ERROR）+ 意图引导 + 连续 3 次硬停 + 已知工具清零

### fix-#10 截断标记（7fbd573）
- buildHistoryPrompt 静默 300 字符截断 → 显式告知 + read_file 续读引导

---

## 八、文档固化（ac54cde → 7c7c14f）

- doc-C-1 历史蓝图归档（15 文件 → docs/archive/ + ARCHIVE.md）
- doc-C-2 README.md 新建（安装/快速开始/配置/命令/架构/FAQ）
- doc-C-3 package.json description 更新（多供应商，去 GLM 字样）
- doc-C-4 ZIS.md 一致性 + 维护态说明
- doc-C-5 CHANGELOG docs 节
- doc-B T7 复跑待网关记录（诚实 no-fabrication）

---

## 九、fix-a6-routing（1af2e46 → 0f83b7a merge）

- provider:model 通用前缀路由（bare-name 只认 scnet 的架构缺口）
- 非流式 complete 补 SSE 响应解析（a6 默认流式）
- ZORGE_MODEL env 种子（headless 多供应商）
- json() fallback + 18 单测

---

## 十、rich 交互修复链（5f6a405 → e5542bf）

### fix-user-visible（5f6a405）
- /model 本地分发（不再落引擎）+ 'default' 落 provider 路由 + 错误文案

### 驻留菜单修复轮（c79a732 → ed1aa82）
- Bug A listProviderNames（a6 入口）/ Bug B 删旧 /model 分支 / Bug C 行模式接线
- 覆盖式重绘（lmLastRows）/ 时序（prependListener）/ 重置（任意字符 re-arm）
- 字符渲染（三态）/ 子菜单（argMenuFor）/ 方向（↑↓）/ 窗口滚动 / Tab 补全

### fix-async-providers（5028e85）
- /model 两级菜单渲染（useEffect 加载 + 占位 + Esc 清空）

### fix-model-direct（e5542bf）
- /model 必达二级（不落命令）+ 菜单铺满 + **a6 422 修复（stream:false 显式）**

### fix-ink-render（8586ccd）
- Box 不能嵌 Text（非法 ink 树崩溃修复）

### fix-hang-gate（8b10133）
- bash 测试 ping→node sleeper（Windows taskkill 孤儿进程修复）

---

## 十一、CC/Hermes 双源移植（847cc90 → 0c7cd2c）

### arch-fix（30e294c）
- 行模式自绘菜单移除（-240 行，双源证实错误架构）→ readline 原生

### fuzzy-desc（847cc90）
- description 感知搜索（Hermes fuzzyScore 分层移植）+ WeakMap 索引缓存

### picker-gen（fabee85）
- 通用 FuzzyPicker 组件（CC design-system 架构移植）

### slash-mid（53eec7b）
- 句中 / 触发（Hermes inlineSlashTrigger）+ ghost text + rich 集成

### fix-picker-3/4 + fix-ui-direction + fix-rich-input + fix-rich-local-cmds
- ↑↓ 方向 / /model 两级 / 窗口滚动 / Tab 补全 / 方向 down / 三区铺满 / latestRef /
  本地命令铁律（斜杠永不进引擎）/ provider 启动预取

### cc-typeahead（0c7cd2c）——交互架构重构
- **统一 typeahead 引擎**（命令/provider/model/历史单源）+ SuggestionBar（非弹窗）+
  InputBuffer undo/redo + ghost text——取代独立弹窗菜单（此前所有菜单 bug 架构根治）

---

## 十二、learn-harness 框架缺口（4e1f04b → 8500771）

### P1-T13/14（4e1f04b）
- /init（生成 .zorge/AGENTS.md 目录页 + feature_list.json 模板）+ /feature 命令

### P1-T15（1bf6ab0）
- compact 策略可插拔（CompactStrategy 接口 + default/topic 内置）

### P1-T16/17（75525f3）
- tools/pre-execute + post-execute 事件点 + 增量环境上下文（EnvContext）

### P2-T18（a66a974）
- /tree 会话树（origin + 分支节点 + 循环守卫）

### P2-T19（79b5299）
- AgentTree 图模型（AgentEdge + addEdge + route）+ 三结构性失败规避记录

### A-T10（c5cf9da）
- ZIS.md 615→55 行目录页 + docs/ZIS-DETAILS/ 五章无损迁移

### A-T12（1189e21）
- 环境自描述（describeEnvironment → /init ENV.md + PromptBuilder ≤10 行注入）

### D-parallel（8500771）
- **并行 rollout 引擎**：runMultiple Promise.allSettled + write mutex（写串行读并发）+
  预算聚合（超额按 score 裁剪）+ high+ 并行 / quick-standard 串行 + AgentTree 真实并行树

---

## 十三、记忆系统（M1.1 起，进行中）

### M1.1 Positive Memory（2f802a8）
- kind 字段（failure/success/preference，旧卡默认 failure）
- positive refine 触发：attemptCount===1 AND（正向反馈 OR score≥85）——写盘≠成功红线
- kind 基线衰减（preference 0.6）+ pin 冻结 + count≥2 半衰期延长 + 8 测试

### 后续批次（M1.2 /remember+/forget、M1.3 compact 补漏、M2 注入管道、M3 可选）
- 见 docs/TODO.md T-21+ 与修订版施工指令

---

## 十四、审查缺陷修复（2026-09，5 批，fix-p0-sec → fix-p2）

> 来源：只读审查（12 功能 bug + 5 安全风险 + 死代码/文档漂移），按 P0 优先 5 批闭环。
> 全量门禁：497 用例 496 pass 0 fail 1 skip；tsc clean；零新增依赖。

### fix-p0-sec（S1-S5，安全五件）
- S1：ModelCommand 删除 SUPER DEFENSIVE 正则捞 key + [scnet-debug]/[scnet-raw] 输出（密钥永不出现在终端/日志，含 masked echo）
- S2：__lastScnetListError 从 globalThis 改模块私有
- S3：新增 utils/redact.ts（sk- 前缀/Bearer/键值对脱敏），ZorgeChaser 锚点 + read_file 工具共用
- S4：agentServer /api/run 可选 Bearer token（--serve-token / ZORGE_SERVE_TOKEN）+ 无 token 仅 localhost；CORS 配置化；isAuthorizedRequest 纯函数导出
- S5：providerPrefetch 原子写（tmp+rename）+ 写前重读合并，并发编辑不再被覆盖

### fix-p0-fn（B1+B12）
- B1：engineAdapter 写工具注册补 max 档（high/max/ex/zorge）
- B12：ModelProvider 向上发现 .zorge.json 的 require('path') 死代码 → ESM dirname + process.argv[1]

### fix-p0-path（B2+B7+B8，默认路径贯通）
- B2：runAgentTask 复用调用方 Session（tier/workspace/turns 生效）；无 session 新建兼容 serve
- B7：repl.ts 恢复路径写 session.__resumed 标记（此前死代码）
- B8：非 TTY 降级 startClassicRepl 携带恢复 session

### fix-p1（B3/B4/B5/B6 + /init 闭环）
- B3：lastAborted 中止置位，排队任务不再自动连锁执行
- B4：Repl.setSession —— /session load 真正生效
- B5：shift+tab 归 ZorgeApp 模式环；双 Esc 归 InputBar 单主（消除双处理竞态）
- B6：KeyHandler Esc 不再粘滞（任意非 Esc/非 Enter 键复位）
- /init 闭环（learn P0-2）：projectInstructions.ts 读回 AGENTS.md 验证命令注入 PromptBuilder；sseInteractive /init 复用 InitCommand

### fix-p2（B9/B10/B11 + 死代码 + 文档漂移）
- B9：Repl shell 误输入提示硬编码路径 → process.cwd()
- B10：InputReader 菜单 Esc 先存高度再清行（此前只清 1 行）
- B11：TreeCommand sessionId → id
- 死代码：progressBar / bridge.requestConfirm 标 @deprecated；demo-new-sample 修复导入并标注历史
- 文档漂移：AgentTree 串行/并行注释统一；LEARN-HARNESS-GAP.md /init 条目更新；TODO.md T-10~T-19 标记已交付 + 新增 T-21~T-26 结构性缺口

---

## 维护约定

- 每批施工完成，在本文件追加对应章节（按战役分组）
- 版本级摘要同步更新 CHANGELOG.md（0.4.0 → 后续 bump 时）
- 提交级明细与 git log 一一对应（可追溯）
