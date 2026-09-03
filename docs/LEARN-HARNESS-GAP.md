# Zorge × Learn Harness Engineering —— 经验落成与差距审计

> 来源：`C:\Users\19395\learn-harness-engineering-main`（walkinglabs 项目制课程，14 讲 + 8 项目 + harness-creator skill）。
> 用途：把该课程的五子系统框架、四家前沿产品设计拆解、14 讲教训，映射到 Zorge 现状，形成可执行差距清单。
> 日期：2026 年（Zorge v0.4.0 + dogfooding 战役后）。

---

## 一、核心框架：五子系统模型

> **Harness = 模型权重之外的一切工程基础设施**（OpenAI："repo IS the spec"；Anthropic："reliability comes from the harness, not the model"）。

| 子系统 | 最小产物 | 职责 | Zorge 现状 | 评级 |
|--------|---------|------|-----------|------|
| **Instructions** | AGENTS.md / CLAUDE.md | 启动路径、工作规则、完成定义 | ZIS.md + 六档契约 + 负向工具清单 | ⚠️ 未目录页化 |
| **Tools** | shell / 文件 / 测试工具 | 最少权限，但别禁用 shell | 工具层完整（read/glob/grep/bash/write/edit + MCP + skills） | ✅ |
| **Environment** | package.json / .nvmrc / Docker | 环境自描述、可复现 | workspace 概念存在，无环境自描述 | ⚠️ |
| **State** | PROGRESS.md / feature_list.json | 长任务进度追踪 | rollout jsonl + checkpoint + compact + resume/branch | ✅ |
| **Feedback** | 显式验证命令清单 | **最高 ROI 子系统** | 审批四档 + diff + 护栏 + EXIT_CODE:0 | ⚠️ 验证命令未显式入 prompt |

**量化方法**：单变量消融实验——固定模型，逐个移除子系统看哪个导致最大性能下降。Zorge 的 dogfooding 战役本质是一次消融（暴露 #9 格式漂移 = Feedback 子系统缺口）。

---

## 二、四家前沿产品设计拆解（经验提炼）

### 1. Claude Code ——"加法"路线

- **四层记忆**：organization → user → project → local 四级 CLAUDE.md，越具体越靠后注入；子目录按需加载；auto memory（≤200 行 / 25KB）。
- **五级压缩管道**（非"满了就摘要"）：无损剪枝 → 结构化蒸馏 → 有损 LLM 摘要，带熔断器。
- **四类扩展职责分离**：CLAUDE.md 管 "what"、Skills 管 "how"、MCP 管 "where"、hooks 管 "when to enforce"——防上下文泄漏。
- **hooks 做确定性验证**：PostToolUse 强制检查写回、Stop 拦截"宣布完成"——"做事的人"与"检查的人"分离（Anthropic 实证：agent 会自信地赞美自己的工作）。
- **子代理 sidechain**：子代理会话独立文件，不膨胀父上下文。

### 2. Codex ——"减法"路线

- **AGENTS.md = 目录页非百科**：~100 行，超限拆 docs/ 按需读——"give the map, not the manual"。
- **只写不变量，不微管理实现**：硬约束 + 验证命令，其余交给模型。
- **git worktree 环境隔离**：每任务独立 worktree + 本地可观测栈——边界靠环境强制。
- **上下文工程四策略**：Write（写进文件）/ Select（只拉必要 token）/ Compress（自定义 compact_prompt）/ Isolate（子代理隔离）。
- **增量环境上下文**：build_environment_update_item 只输出变更字段，不每轮重复全量系统上下文。

### 3. DeepSeek Harness ——"harness 即操作系统"

- **一切皆插件**（Cordis）：模型适配器/工具注册表/会话日志/agent 循环都是插件——"no privileged core to patch"。
- **能力缝三层**：Service Definition → Provider → Consumer——工具面不变量，环境可整体替换。
- **事件管道**：turn/step/llm/assistant/tool 全流程事件点，权限/记忆/策略/可观测以监听器附着，不硬编码进循环。
- **"Model-visible means logged"**：凡进入模型请求的内容必须能从日志重建，运行时不变量强制。

### 4. Pi ——"最小核心 + 可编程扩展"

- **四可定制层**：Extensions（TS 生命周期钩子）/ Skills（按需加载）/ Prompt templates（/name 展开）/ Themes。
- **可插拔压缩**：压缩策略本身是接口；默认溢出恢复 + 超阈值双触发，保留最近 ~20k token，链式增量压缩。
- **会话树**：sessions stored as trees，/tree 回到任意历史节点续写——结构化重放 > 强制摘要。
- **prompt cache 友好**：技能按需加载，不炸缓存。

### 三家对比（一句话）

| 产品 | 路线 | 核心动作 |
|------|------|---------|
| Claude Code | 加法 | 记忆/权限/子代理进核心，开箱即用 |
| Codex | 减法 | 仓库约定 + 环境隔离为默认 |
| DeepSeek Harness | 插件化 | harness 独立成 OS，agent 是可替换应用 |
| Pi | 可编程 | 决定权交给扩展点，最小核心 |

---

## 三、14 讲教训速查

| 讲 | 教训 | Zorge 实证/对应 |
|----|------|----------------|
| L01 | 强模型 ≠ 可靠执行，可靠性来自 harness | dogfood #9（格式漂移）实证 |
| L02 | 五子系统框架 | 本文档 |
| L03 | 仓库是唯一真实来源——agent 看不到 = 不存在 | RBW 铁律 |
| L04 | 巨型指令文件必败 → 拆目录页 + 按需读 | ✅ ZIS.md 目录页化（A-T10）：55 行目录页 + docs/ZIS-DETAILS/ 分章 |
| L05 | 长任务失去连续性的机制 | compact / resume（M2/M3） |
| L06 | 初始化需要独立阶段（/init 生成指令） | ✅ /init 已交付（P1-T13：生成 .zorge/AGENTS.md + feature_list.json + ENV.md，PromptBuilder 读回验证命令闭环） |
| L07 | agent 越界与半成品（scope 边界） | 审批 / plan 模式 |
| L08 | 特性列表是 harness 原语（feature_list.json） | ⚠️ 无特性追踪 |
| L09 | agent 过早宣布胜利 → 需确定性检查 | EXIT_CODE:0 信号（#10 修复） |
| L10 | 端到端测试改变结果——全流程跑通才算数 | dogfood 红→绿 |
| L11 | 可观测性属于 harness 内部 | rollout jsonl |
| L12 | 每会话必须留干净交接态 | session-handoff 思想 |
| L13 | 单循环工程（手动→自动化循环） | --headless 已备 |
| L14 | 单循环长成图（Goodhart/盲视/冲突三失败） | AgentTree 已预留 |

---

## 四、harness-creator Skill 实操清单

**最小产物**：AGENTS.md + feature_list.json + progress.md + init.sh +（可选）session-handoff.md。

**设计规则**：
- 根指令文件保持短（路由 + 不变量，非全手册）
- 验证命令显式可运行
- 要求证据才标记 feature 完成
- 一次一个活跃 feature（除非显式多 agent 边界）
- 用 append/update 状态文件，不依赖聊天历史
- 破坏性行为永不藏进脚本，覆盖需显式批准

---

## 五、Zorge 差距清单（可执行）

### P0（直接影响可靠性）

| # | 缺口 | 来源 | 建议修复 |
|---|------|------|---------|
| 1 | ~~Instructions 未目录页化~~ | L04 / Codex | ✅ A-T10 已交付：docs/ZIS.md 目录页（55 行）+ docs/ZIS-DETAILS/ 五章 |
| 2 | **验证命令未显式入 prompt** | Codex / CC hooks | 项目级验证命令作为资产显式注入 PromptBuilder（而非靠模型猜） |
| 3 | **环境自描述缺失** | L02 | workspace 增加环境自描述（运行时版本/依赖锁定/验证命令清单） |

### P1（增强）

| # | 缺口 | 来源 | 建议修复 |
|---|------|------|---------|
| 4 | ~~无 /init 命令~~ | L06 | ✅ 已交付（P1-T13：生成项目指令目录页 + feature_list.json 模板 + ENV.md，idempotent） |
| 5 | 无特性追踪 | L08 | feature_list.json（当前 feature/状态/证据/下一步） |
| 6 | 压缩策略写死 | Pi | compact 策略接口化（主题/代码感知/换模型摘要） |
| 7 | 工具预执行钩子未事件化 | DeepSeek | tools/pre-execute 事件点（安全/策略以监听器附着） |
| 8 | 环境上下文全量重复 | Codex | 只输出变更字段（增量上下文） |

### P2（前瞻）

| # | 缺口 | 来源 | 建议修复 |
|---|------|------|---------|
| 9 | 会话树（非线性分支） | Pi | /tree 回任意节点；branch 是线性，树是下一步 |
| 10 | 图工程（多 agent 并行） | L14 | AgentTree 已预留；Goodhart/盲视/冲突三失败需设计规避 |

---

## 六、方法论资产

1. **单变量消融**：评估 harness 组件边际价值的标准实验（移除一个→观测性能下降）。
2. **"做事的人"与"检查的人"分离**：验证不能信任模型自评（CC hooks / Zorge EXIT_CODE:0）。
3. **"Model-visible means logged"**：进模型上下文 = 必须可重建（DSH 第一性约束）。
4. **结构化重放 > 强制摘要**：会话树（Pi）优于每轮摘要（Zorge 的 compact 可向此演进）。
5. **give the map, not the manual**：指令目录页化是四家共识。

---

## 七、一句话总结

> **Zorge 在 Tools / State / Feedback 已达标，最大缺口在 Instructions 目录页化（P0-1）与验证命令显式化（P0-2）——这是 learn-harness 框架下 ROI 最高的下一步。方法论资产（消融实验 / 检查者分离 / Model-visible-means-logged / 结构化重放）可直接指导后续战役。**

## 参考

- 原项目：`C:\Users\19395\learn-harness-engineering-main`（walkinglabs/learn-harness-engineering，14 讲 + 8 项目 + skills/harness-creator）
- 四家拆解：docs/en/harness-designs/{claude-code, codex, deepseek, pi}/index.md
- 核心讲座：docs/en/lectures/lecture-02-what-a-harness-actually-is/index.md
- Skill：skills/harness-creator/SKILL.md
