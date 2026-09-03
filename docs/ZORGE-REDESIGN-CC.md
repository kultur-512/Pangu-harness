# Zorge × Claude Code 重设计规格（Redesign by CC Design Philosophy）

> 角色:二级审查员 · 交付物:设计规格(仅 docs,零代码改动)
> 依据:[catyans/claude-code-source-analysis](https://github.com/catyans/claude-code-source-analysis)
> ——2026-03-31 泄露的 Claude Code CLI 完整 TS 源码(~1,884 文件 / 512K+ 行)逐模块分析(第 00-18 章)。
> 用途:用 CC 的工业级设计思想,对 Zorge(零依赖 TS ESM 单体编码 agent CLI)做系统性重设计。
> 现状基准:docs/REVIEW-2ND-AUDIT.md(5 批修复后)+ docs/TODO.md(T-21~T-29 结构性缺口)。

---

## 一、为什么用 CC 的思想重设计 Zorge

Zorge 与 CC 的差距不是"少几个功能",而是**架构范式**差异:

| 维度 | CC(工业级) | Zorge(现状) |
|------|-----------|-------------|
| 核心循环 | QueryEngine **AsyncGenerator 状态机**(8 种 transition + 7 级错误恢复) | `VerifyCritiqueLoop` **硬编码 while**(complete→解析→执行→critique) |
| 工具协议 | `Tool<I,O,P>` 接口 30+ 方法 + Zod schema + `toToolResultBlockParam` 富回传 | executor 注册表 + 字符串化结果回传(纯文本) |
| 权限 | 工具自带 `checkPermissions` + ResolveOnce + 7 模式 + 6 路竞争 | 外层 `classify()` 集中 + 3 档 + 命令链穿透缺陷(T-28) |
| 状态 | 150+ 字段 DeepImmutable AppState + 35 行 Store + 单一 onChange | Session 直写 + 双真相漂移(SessionStore vs rollout) |
| 错误处理 | withRetry 指数退避 + 7 级恢复级联 + 熔断器 | 零容错(T-26:单次失败杀整个 rollout) |
| 扩展 | 工具/命令/Hook/Skill/插件 五类扩展点 | 只有命令注册 + skills 目录 + MCP(无 hook/plugin) |

**重设计目标**:把 Zorge 从"prompt 工程驱动的单体循环"升级为"状态机驱动的分层 harness"——
保留 Zorge 的零依赖纪律、六档 tier、三 agent 协作,吸收 CC 的架构骨架。

---

## 二、CC 七大设计原则 → Zorge 落地清单

| CC 原则 | 含义 | Zorge 落地 |
|---------|------|-----------|
| 1. 安全优先(fail-closed) | 工具默认 `isConcurrencySafe=false`;权限默认拒绝,直到显式证明安全 | 工具接口加三态位,默认全 false;权限决策默认 deny |
| 2. 构建时优化(DCE) | 编译期裁剪变体,单一代码库多部署 | 非优先:Zorge 是单体,先不做 feature-flag 编译 |
| 3. 启动性能(<500ms) | preAction 守卫 + 惰性加载 + 并行预取 | cli.ts 拆 bootstrap + 命令 handler;tools/schema 惰性加载 |
| 4. 全面流式化 | AsyncGenerator 是统一流式原语(取消/背压/组合) | VerifyCritiqueLoop → QueryEngine AsyncGenerator |
| 5. 不可变状态 | DeepImmutable + 单 Store + setState 新对象 | 引入 `src/store/createStore.ts` + AppState 类型 |
| 6. 渐进降级 | 7 级恢复级联,每级单次尝试、从轻到重 | withRetry + 错误分类 + 压缩/续接级联(T-26 解) |
| 7. 多模式统一 | 6 种执行模式共享 QueryEngine/工具/权限 | REPL/headless/serve 共享引擎核心(部分已有,补状态同步点) |

---

## 三、目标架构(分层)

```
entry (cli.ts 薄壳: bootstrap + preAction 守卫)
  │
  ▼
QueryEngine (AsyncGenerator 状态机 ← 改造 VerifyCritiqueLoop)
  │  8 transition: continue/tool_use/stop/max_tokens/error_recovery/budget_exceeded/abort/end_turn
  │  7 级恢复级联 + withRetry(指数退避) + 空闲看门狗 + 扣留机制
  │
  ├──▶ Tool System (Tool<I,O,P> 接口 + buildTool 工厂 + Zod schema)
  │       ├── partitionToolCalls(读并发/写串行, Semaphore≤10)
  │       ├── Context Modifier(工具后按序改上下文,并发安全)
  │       └── 长结果写盘 + 2KB 预览(防 token 爆炸)
  │
  ├──▶ Permission Pipeline (工具自带 checkPermissions)
  │       ├── ResolveOnce + 档位化(default/auto/plan/bypass + 现有 3 档)
  │       ├── Bash 3 层检查(23 项安全 → 路径约束 → 只读强制)
  │       └── 权限日志扇出(审计)
  │
  ├──▶ Store (createStore + AppState + onChangeAppState 同步点)
  │       └── Session/审批/模型/压缩状态统一入 store
  │
  └──▶ Service Layer
          ├── ModelProvider 抽象工厂(direct/anthropic/bedrock/openai-compatible)
          ├── MCP Transport 接口(stdio → streamableHTTP → SSE)
          └── Compaction 5 策略 + 熔断器
```

---

## 四、逐层重设计规格

### 4.1 查询引擎(最高优先,替代 VerifyCritiqueLoop)

**CC 机制**:query.ts 的 `async function* query(state)` 循环,6 阶段(pre-api → api → process → tools → stop hooks → transition);
状态机用 8 种 `Transition` 显式建模;7 级错误恢复级联(流式回退→折叠→响应式压缩→输出上限升级→多轮续接→停止钩子→预算续接);
`withRetry` 指数退避(500ms→32s + 25% 抖动,心跳保活);扣留机制(可恢复错误不先给 UI);空闲看门狗(45s 警告/90s 杀)。

**Zorge 现状**:VerifyCritiqueLoop 一个 `while(!done && stepNum < maxSteps)` 硬编码循环;`success` 靠字符串信号(`ALL_TESTS_PASSED`/`EXIT_CODE:0`)判定,无 transition 建模;模型调用零 try/catch(T-26);无看门狗/扣留。

**重设计**:
1. 新建 `src/query/QueryEngine.ts`:
   ```ts
   type QueryTransition = 'continue'|'tool_use'|'stop_sequence'|'end_turn'
                        |'max_tokens'|'error_recovery'|'budget_exceeded'|'abort';
   async function* query(state: QueryState): AsyncGenerator<QueryEvent> { ... }
   ```
   - VerifyCritiqueLoop 的铁律跟踪(critique 频率/RBW/验证密度)降级为 pre-api 阶段的条件注入 + stop hooks 的 fire-and-forget 记忆提取,不再硬编码进循环。
2. `withRetry<T>` 包装所有模型调用:retryable = [429, 529, ECONNRESET, ETIMEDOUT],baseDelay 500 / maxDelay 32s / jitter 0.25,心跳 10s(解 T-26)。
3. 看门狗:流式 45s 无事件警告、90s abort。
4. 保留 Zorge 特色:六档 tier 仍决定 maxSteps/critique 频率/铁律注入,但通过 `QueryState` 配置进入,而非逐处 if。
5. 停止条件显式化:`end_turn` 必须带验证证据(didRealVerification),把"Verify-Before-Claim"从字符串启发式升级为 transition 守卫(修 T-23 打分裂缝的根)。

### 4.2 工具系统(第二优先,替代 executor 注册表)

**CC 机制**:`Tool<I,O,P>` 接口按 6 类 30+ 方法;`buildTool` 工厂(PartialTool 只强制 4 字段);三态位 `isConcurrencySafe/isReadOnly/isDestructive`(fail-closed);`call(): AsyncGenerator<Progress,Output>`;`toToolResultBlockParam` 富回传;`partitionToolCalls`(读并发≤10/写串行);Context Modifier;长结果写盘 + 预览;`shouldDefer` 延迟加载 + ToolSearch。

**Zorge 现状**:7 工具 + MCP 命名空间,executor 别名归一;无 schema(参数靠字符串解析,模型可传任意形状);无三态位;写/读全走 withWriteLock 串行(有互斥但无并发读);结果纯文本拼接进验证串。

**重设计**:
1. `src/tools/types.ts` 引入:
   ```ts
   interface Tool<I=any, O=any> {
     name: string; description: string;
     inputSchema: ZodType<I>;            // schema 校验参数(修工具参数失真)
     isConcurrencySafe?: boolean;        // 默认 false
     isReadOnly?: boolean;               // 默认 false
     isDestructive?: boolean;            // 默认 false
     shouldDefer?: boolean;              // 预留延迟加载
     call(input: I, ctx: ToolContext): AsyncGenerator<any, O>;
     checkPermissions?(input: I, ctx): Promise<PermissionDecision>;
     toToolResultBlockParam?(o: O): string; // 结构化回传
   }
   ```
2. `buildTool(partial)` 工厂:只强制 name/description/inputSchema/call,其余默认 fail-closed。
3. **Zod schema 是前提**:先落 `zod`(唯一新增依赖,冲突"零依赖纪律"需人类拍板——见第九节权衡)。
4. `partitionToolCalls`:read/glob/grep 标 `isConcurrencySafe && isReadOnly` → 并发;write/edit/bash 串行;Semaphore≤10。
5. 长结果(>50KB)写 `.zorge/spill/` + 2KB 预览 + `file://` 引用。
6. 工具列表固定顺序(内置 TOOL_ORDER + MCP 按 server:name 排尾),保护 prompt 前缀。

### 4.3 权限系统(第三优先,修 T-27/T-28)

**CC 机制**:`hasPermissionsToUseTool` 快速路径(bypass → 工具自身 checkPermissions → 处理器);7 种模式(ask/auto/default/bypass/bubble/plan/ungated_auto);ResolveOnce 双标志(claimed/delivered);Bash 特化流程(Parse → 23 项安全 → 路径约束 → 操作符权限 → 模式);200ms 宽限期投机分类器;Hook 事件(20+ 类型,4 来源)。

**Zorge 现状**:`classify()` 集中纯函数,3 档(readonly/default/full)+ allowlist + 60s 超时;readonly 白名单只查首 token(T-28 命令链穿透);MCP 'a' 决策错误解锁 bash(T-27);无 hook;无 ResolveOnce。

**重设计**:
1. 权限决策迁入工具:`executor` 执行前调 `tool.checkPermissions`,外层 classify 降级为兜底默认(责任内聚)。
2. **修 T-28**:`isReadonlyAllowed` 改为完整命令解析——拒绝含 `;` `&&` `||` `|` `>` `>>` `<` 的命令(或拆 token 全量校验 + 正则行尾锚 `$`)。
3. **修 T-27**:MCP 'a' 决策 `sessionAllowlist.add(mt.name)`(工具全名),绝不解锁 bash。
4. 档位扩展:`readonly/default/full` 保留,加 `auto`(自动批准规则匹配)与 `plan`(只读+计划审批,与现有 planMode 合并);bypass 预留。
5. Bash 三层(借鉴 CC 23 项,先落地 Zorge 高危子集):
   - L1 语法:危险元字符(命令链/替换/重定向/换行/PATH 篡改/控制字符)
   - L2 路径:禁读 `/proc/self/environ`、`/dev/*` 等(对齐 FileRead 设备封锁)
   - L3 只读模式:write 操作检测(`>`, rm/mv/chmod 等),默认保守
6. ResolveOnce 封装 `approval.ts` 的竞争路径(为将来 hook/classifier 并行接入预留)。

### 4.4 状态管理(横切)

**CC 机制**:150+ 字段 DeepImmutable AppState,20 功能域;35 行 createStore(get/set/subscribe + Object.is);AppStateProvider 桥接 React;`onChangeAppState` 6 个同步点集中审计;4 个可变例外(含函数/Map)。

**Zorge 现状**:Session 类(直写可变字段)+ SessionStore 全量快照 + rollout jsonl(双真相漂移);审批/模型/压缩状态分散在 session/模块级变量。

**重设计**:
1. `src/store/createStore.ts`(35 行,照搬 CC 思路,零依赖):
   ```ts
   function createStore<T>(init: T) { /* getState/setState/subscribe */ }
   ```
2. 收敛状态:Session 核心字段(tier/workspace/model/approvalMode/allowlist/turns)为 store 单一真相;
   rollout/SessionStore 降级为"持久化适配器"(订阅 onChange 写入),消除双真相(T-25 会话部分)。
3. `onChangeAppState` 同步点:approvalMode→rollout 审计、model→settings、turns→jsonl。
4. DeepImmutable 视工作量:至少对 store 读面加 `Readonly<T>` 类型守卫(编译期防误改)。

### 4.5 服务层

**CC 机制**:4 Provider 工厂(direct/bedrock/vertex/foundry);40+ 错误分类;MCP 4 传输(stdio/SSE/streamableHTTP/WS)+ 4 层发现 + OAuth;5 种压缩策略(snip/micro/collapse/auto/session-memory)+ 熔断器(maxFailures=3)。

**Zorge 现状**:单一 OpenAI Chat Completions(T-21 无原生 tool calling);MCP 仅 stdio(T-22 流式断路 + T-24 serve 协议单端点);compactStrategies 接口化但只有 default/topic;无熔断。

**重设计**:
1. ModelProvider 抽象工厂(第一步最小):把现有 openai-compatible 提为 `provider: 'openai-compatible'` 实现,接口预留 `'responses'`(原生 tool calling)/`'anthropic'`;**T-21 落地 = 请求发 `tools` schema + 读 `message.tool_calls` + tool_call_id 回填**。
2. 错误分类表(401→提示刷新;429/529→withRetry 退避(T-26 复用 §4.1);context_length_exceeded→触发 reactive compact)。
3. MCP Transport 接口:stdio 先落地(已有),`StreamableHTTP` 次之(远程 MCP 必需)。
4. Compaction 补齐 3 策略:`auto`(90% 阈值 + 熔断)、`snip`(老 tool 输出截断)、`reactive`(context_length_exceeded 触发);
   熔断器 `CompactCircuitBreaker{maxFailures=3}` 保护 auto/reactive(改 compactService)。

### 4.6 记忆系统(结构性修复)

**CC 机制**:文件式记忆(memdir/),4 种类型;Sonnet 语义召回(从 manifest 选相关文件→注入);fire-and-forget 自动提取(不阻塞轮次);MEMORY.md 200 行/25KB 双级截断;团队记忆 + 密钥检测。

**Zorge 现状**(子代理 3 详报):RefinedMemoryStore(卡片 kind/衰减/投影缓存)**引擎只读不写**——最大结构性缺陷;无召回(靠关键词相关性排序);记忆年龄追踪缺失。

**重设计**:
1. **引擎写入闭环**(第一刀):回合结束 stop hook fire-and-forget 调 `RefinedMemoryStore.refine()`(补 refine 调用点,修复"只读不写")。
2. 召回升级:manifest → 文件级候选 → 注入(L1),替代纯关键词;复用现有投影缓存作 manifest 索引。
3. 记忆年龄:卡上加 `lastUsedAt` 四色(🟢🟡🟠🔴)注入提示。
4. 统一双路径:FailureMemory(进程内)收敛进 RefinedMemoryStore(持久化),按 kind 分(failure/success/preference)。

### 4.7 多 Agent(结构性扩展)

**CC 机制**:AgentTool + spawn 三档(subagent_type 过滤);Coordinator 四阶段(370 行系统提示);团队文件 + 跨进程消息路由(本地→UDS→Bridge→文件邮箱);120s 自动后台化;per-process nonce + O_EXCL 防御。

**Zorge 现状**(子代理 3 详报):AgentTree 只是 rollout 视图(串行引擎);无 spawn_agent 工具;无进程隔离(并行 rollout 共享工作区靠写互斥);无自动后台化。

**重设计**(远期,先出接口):
1. `spawn_agent` 工具(description 3-5 词 + prompt + subagent_type + run_in_background):先做进程内隔离 session(独立 QueryEngine + 独立 message buffer),worktree 隔离后置。
2. `/agents` 从 rollout 树升级为真 agent 树(节点 = agent session,边 = dep/rollback/approval——复用现有 AgentTree 图模型)。
3. Coordinator 权限模式预留(`bubble` 决策透传父 agent)。

### 4.8 命令系统

**CC 机制**:3 种类型(prompt/local-jsx/shell);COMMANDS 按 cwd 缓存 + 并行加载(skill+plugin+workflow);可用性过滤 + 模式白名单(remote/bridge);前缀匹配。

**Zorge 现状**:registry(26 命令)+ sseInteractive 内置分发**双实现并存**(T-25 命令分发部分);命令全同构(execute),无 UI 型/无 shell 型;无模式过滤。

**重设计**:
1. 统一命令类型:`{type:'action'|'prompt'|'local-jsx'|'shell'}`;现有 26 命令标 `action`(本地执行)。
2. 双实现合一:registry 为唯一真相,sseInteractive 内置分发改为调 registry(修 T-25)。
3. 模式过滤:`--headless`/`serve` 下白名单(`/status /tier /model /approvals /usage /compact /exit`),对齐 CC REMOTE_SAFE_COMMANDS。

### 4.9 Skill 与插件(远期)

**CC 机制**:BundledSkillDefinition(开箱 skill)+ PluginDefinition(type: defaultEnabled/isAvailable/skills/hooks/mcpServers)+ PluginWatcher(mtime + fs.watch 热加载)+ 惰性文件提取(O_EXCL|O_NOFOLLOW 三重防 TOCTOU)。

**Zorge 现状**:skills 目录约定(~/.zorge/skills + 项目级),触发注入 prompt;无插件概念;无热加载。

**重设计**(远期):PluginDefinition 类型 + watcher;skill frontmatter 加 `allowedTools` 字段(对齐 CC);O_EXCL 写入防御落 skills 提取。

---

## 五、迁移路线图(与 T-xx 整合)

### Phase 1 — 循环重构 + 安全(P0,约 1-2 周)
1. §4.3 权限:修 T-28(命令链)、T-27(MCP 提权)——**纯安全,先行**
2. §4.1 QueryEngine 骨架:VerifyCritiqueLoop 改 AsyncGenerator + transition + withRetry(T-26)
3. §4.4 createStore 落 Session(双真相收敛,部分 T-25)

### Phase 2 — 工具面 + 原生 tool calling(P0-P1,约 2-3 周)
4. §4.2 Tool 接口 + 三态位 + partition(读并发)+ Zod schema(需人类拍板依赖)
5. §4.5 T-21:请求 tools schema + 响应读 tool_calls + 回填
6. §4.5 压缩补齐 auto/reactive + 熔断器

### Phase 3 — 记忆 + 服务(P1,约 2 周)
7. §4.6 引擎写入闭环 + 召回升级
8. §4.5 MCP Transport(StreamableHTTP)+ 错误分类表

### Phase 4 — 多 Agent + 命令统一(P2,远期)
9. §4.7 spawn_agent(进程内隔离先)
10. §4.8 命令双实现合一 + 模式过滤
11. §4.9 Plugin(可选)

---

## 六、保留的 Zorge 特色(不因 CC 化而丢弃)

- **零强依赖纪律**:唯一例外候选 = Zod(§4.2 必需);若人类否决,降级为手写轻量 schema 校验器(逐字段类型断言)。其余 CC 模式全部零依赖可实现。
- **六档 tier**:保留,作为 QueryState 的高层配置(决定 budget/maxSteps/critique 节奏/记忆注入量),不再散落 if。
- **三 agent 协作体系**:docs/agents + .agents/ 工作区是协作 harness,与产品架构正交,不受本设计影响。
- **RBW / EXIT_CODE:0 / 负向工具清单**:作为 iron-law 策略保留,注入方式从 prompt 硬编升级为 pre-api 条件注入(经 QueryState)。
- **中文错误文案/目录页文档**(ZIS 体系):保留。

---

## 七、落地顺序与验收

| 里程碑 | 验收标准 |
|--------|---------|
| M-A:权限安全(Phase 1-1) | T-27/T-28 回归测试绿;`ls; rm -rf .` 拒绝 |
| M-B:查询引擎(Phase 1-2) | 单测模拟 429→重试成功;abort 在任意 yield 点生效;门禁全绿 |
| M-C:工具面(Phase 2-4/5) | 模型收到 tools schema;tool_call_id 回填;read 并发实测吞吐 |
| M-D:记忆闭环(Phase 3-7) | 一次回合后 .zorge-memory.json 出现新卡(引擎写) |
| M-E:命令统一(Phase 4-10) | sseInteractive /tier 与 registry 同一实现 |

每里程碑走三 agent 流程(编码 → 一级验收 → 二级复审 → 归档),交接文件见 `.agents/`。

---

## 八、设计来源索引

| 章节 | 吸收进本规格的机制 |
|------|-------------------|
| 02 查询引擎 | transition 状态机、7 级恢复、withRetry、看门狗、扣留 |
| 03 工具系统 | Tool 接口、buildTool、三态位、partition、Context Modifier |
| 04 BashTool | 三层安全、23 项检查、路径约束、投机分类 |
| 06 文件工具 | 设备路径封锁、字符串替换 edit、意外修改检测 |
| 07 权限系统 | ResolveOnce、7 模式、6 路竞争、Hook 事件 |
| 08 状态管理 | createStore、DeepImmutable、onChange 同步点 |
| 09 服务层 | Provider 工厂、错误分类、MCP 传输、5 压缩策略 + 熔断 |
| 11 记忆系统 | 文件记忆、语义召回、fire-and-forget 提取 |
| 12 Skill/插件 | PluginDefinition、watcher、O_EXCL 提取 |
| 14 命令系统 | 3 命令类型、cwd 缓存、模式白名单 |
| 16 数据流模式 | 消息规范化、Context Modifier、缓存构建、两阶段渲染 |
| 18 架构总结 | 7 大原则、可扩展性模型、7 层安全 |

---

## 九、需人类拍板的决策

1. **是否引入 Zod 作为唯一新增依赖**(§4.2/4.3 的 schema 基础)?零依赖纪律 vs CC 式 schema 校验。
2. **重设计走增量(逐 Phase 落地,保持可运行)还是分支重写**(一次性大改)?建议增量。
3. **Phase 1 与当前 T-21~T-29 的关系**:T-21/T-26 被本设计吸收,建议从 TODO 标"由 CC 重设计覆盖"。

---

## 十、在途工作对账(redesign-p0)

> 2026-09-03 编码 agent 在 `chore/zorge-cc-redesign` 分支执行修正方案 Phase 0 时记录。
> 工作区 7 个在途文件(非本会话产生)经核验归 T-27/T-28/T-29 三项遗留缺陷,已提交并标注状态。

- **T-27【高危·已修复】** `src/tools/engineAdapter.ts` — MCP `'a'`(always allow)决策改按工具全名放行(`mcp_<server>_<tool>`),`sessionAllowlist.add(mt.name)` 替代 `add('bash')`,绝不再解锁 bash。
- **T-28【高危·已修复】** `src/tools/readonlyAllowlist.ts` — 新增 `CHAIN_OR_REDIRECT_RE = /[;&|<>]/`,readonly 白名单先拒绝含命令链/重定向的命令(`ls; rm -rf .` / `echo x > file`),整体拒绝而非只查首 token。
- **T-29【回归·P1·已修复】** `src/cli/repl/typeahead.ts`(新纯函数 `doubleEscState`)+ `src/cli/repl/ui/InputBar.tsx` — 双 Esc 计时与 `suggestionsDismissed` 解耦:任何 Esc 都更新计时,300ms 内第二次无条件触发清空输入+队列。

配套回归测试:`tests/repl/typeahead.test.ts`(+4)、`tests/tools/bash.test.ts`(+2)、`tests/tools/executor.test.ts`(+2)。
门禁:`npm test` 505 用例 504 pass 1 skip(symlink 权限,既有),tsc/build 全绿。
