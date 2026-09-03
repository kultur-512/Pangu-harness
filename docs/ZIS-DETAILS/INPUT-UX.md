# ZIS 细节 · 输入手感（从 docs/ZIS.md 迁移，A-T10）

> 流式体验 / 键位 / typeahead / Ink 富终端 / 示例与排障。

## 默认流式体验（进程内事件流 + 真流式 delta + 可选富 UI，对标 Hermes）

从蓝图 v1.1 起，**直接运行 `zorge`（无参数）** 默认进入流式交互模式：

- **传输（P0.2）**：默认**进程内事件直连**（in-process，无端口、无 loopback HTTP）。远程/浏览器场景可用 `/serve` 显式启动 SSE 服务。
- **Provider 单例（P0-fix）**：全进程共享 `getSharedModelProvider()`，`/model` 热切换、远程模型缓存、`.zorge.json` 探测结果在 REPL / 内嵌执行器 / serve 三端一致；解析失败自动做一次热重载重试（拾取运行中新建的配置或环境变量）。
- **真流式（P1.1-P1.4）**：
  - 模型客户端支持 `streamChat()`（OpenAI 兼容 SSE：`delta.reasoning_content` → thinking、`delta.content` → text；不支持流式的端点自动回退整段 complete()）。
  - ZorgeChaser 在 client 拦截层把 token 流转成 **协议 v2 事件**：`thinking.start/delta`、`message.start/delta`（引擎与 UI 依旧零耦合）。
  - 富 UI 在 Feed 与输入框之间出现**实时流式区**：💭 思考尾随滚动 + 回答逐字浮现（▍光标）；消息按「冻结块」增量渲染——已完结段落只解析一次，仅活动尾巴随 delta 更新（O(tail) 成本）。
  - 经典行模式保持干净的步级输出，忽略 v2 delta（不刷屏）。
- 终端事件清单：`phase / step / critique / tool / budget / softLimit / degradation / progress / thinking.* / message.* / result / done(⏱) / error`。
- **思维链阶梯（P1.5a）**：high=think、max=think hard、ex/zorge=ultrathink 注入 `<thinking_budget>`；quick/standard 保持简洁。
- **富交互 UI（Path B，ink@5 + react）**：固定顶栏（档位/模型/工作区/预算条/上下文计量/phase/RUN）+ 滚动 Feed（ToolCard / 💭 ThoughtBlock / Markdown）+ 实时流式区 + 常驻底栏；**ctrl+o** 切换 transcript 全文展开。
- **降级纪律**：富 UI 失败→行模式；`--classic` 强制经典；非 TTY 静默经典。

**核心约束（红线）**：
- 引擎（ZorgeChaser、VerifyCritiqueLoop 等）**完全不知晓** SSE 或 UI。
- `optionalDependencies`（ink/react 等）缺失或运行时失败 → 静默降级，功能不受影响。
- smoke/verify 永远在非 TTY 下运行，天然覆盖降级路径。

当前状态（与用户反馈对齐，持续迭代中）：
- 默认 `zorge` 为「通道升级」：进程内事件直连（P0.2，无端口无日志），远程 UI 走 `/serve`。
- 当 ink + react 可用且 TTY 支持时，自动进入“交互升级”：
  - 固定顶栏（档位/模型/工作区/预算进度条/上下文计量/phase/RUN）
  - 滚动 Feed：step 头 + 💭 ThoughtBlock（ctrl+o transcript 全文展开）+ 计划 Markdown + 内联 ToolCard
  - budget/softLimit 更新 TopBar 预算条；step 累计更新上下文计量
  - 额外支持 degradation、progress、thought、markdown 等事件
  - 思维链阶梯：high=think / max=think hard / ex·zorge=ultrathink（注入 prompt）
- 富 UI 不可用时，回退到“干净的行模式流式终端”（结构化着色行，同一事件流）。
- `--classic` / `-C` / `--line` 强制绕过流式路径与富 UI。
- 行模式 prompt 恢复、Ctrl+C 中断、/edit 拉回上次输出均已就位。
- 核心引擎完全不知晓传输/UI；ink/react 为 optionalDependencies，缺失即静默降级。
- smoke 测试在非 TTY 下运行，天然覆盖降级。

**isTTY 红线（M2.0 正式入档）**：
- `isSmokeEnvironment()` = `!process.stdout.isTTY || ZORGE_SMOKE==='1'` 是真实执行的最外安全闸。
- **任何脚本伪造 `process.stdout.isTTY = true` 触发真实 spawn/写盘前，必须先经人工评审**；
  M1 验收驱动（scripts/m1-acceptance.mjs）是经评审的唯一例外（无头环境验收战）。
- 测试覆盖 mock 路径一律使用 `ZORGE_SMOKE=1`，**禁止伪造 isTTY**。
- M2 起新增 IO（file-history、rollout）同样置于该闸之后：smoke/CI 下零真实文件副作用。

---

## P4：输入手感（持续协作）

### 排队与插话（P4-4.2/4.3）
- 任务运行中输入保持开启：普通文本 → `queued ×N`（回合结束自动依次执行）；
  `!插话内容`（或 `!steer 内容`）→ `steered ×N`，下一轮 prompt 头部注入
  `【用户插话（运行中收到，必须在本轮考虑）】`块；`/` 命令运行中仍即时执行。
- Ctrl+C 中断：丢弃未注入插话，保留排队任务；双 Esc 清空输入+队列。
- rich InputBar 运行中显示 `queued ×N（steer M）` 徽标。

### 键位总表（P4-4.8，对齐 CC）

| 键 | 行为 | 备注 |
|---|---|---|
| Enter | 提交（运行中=排队/插话路由） | rich + line |
| shift+tab | 模式环 plan → default → auto-accept → full → plan | rich；line 用 /mode |
| ctrl+o | transcript 全文展开切换 | rich（P0.1） |
| ctrl+t | 轻量状态面板（队列 + 插话 + 最近 5 个 checkpoint） | rich；与 CC todos 面板的差异见下 |
| 双 Esc（300ms） | 清空当前输入 + 清空队列 | rich |
| Esc / 回车（ConfirmBar） | 拒绝（安全默认） | rich |
| Tab（行模式） | 斜杠命令补全：精确前缀优先，miss 后 fuzzy（/tl→/tier） | line |

与 CC 的差异：无 ExitPlanMode 确认卡（shift+tab 切出即退出 plan）；ctrl+t 为队列/插话/
checkpoint 轻量面板而非 todos 系统；full 与 auto-accept 在 Zorge 中等价（无 bypass 级）。

### 模式环（P4-4.7）
- plan：读免审；写类与 bash 在 adapter 前置拒绝（`✗ PLAN_MODE: 计划模式下禁止执行，先输出方案`）；
  PromptBuilder 注入 `<plan_mode>` 硬约束块。
- 无键位环境：`/mode`（cycle）或 `/mode plan|default|auto-accept|full` 即可，ModeRing 的可测入口。

### 粘贴 / CJK / spinner（P4-4.4/4.5/4.9）
- 粘贴 >3 行或 >2000 字符 → 行模式折叠为 `[粘贴 N 行，Enter 展开确认提交]`，再次回车提交；
  rich 端待 ink 粘贴事件支持（注明）。
- `stringWidth`：CJK/全角/emoji=2、零宽=0——供下游渲染器使用；readline/ink 各自内部
  已处理光标宽度（注明后跳过接线）。
- 行模式运行中每 4s 更新双语 gerund 标签（推演中/反刍中/Pondering/Ruminating…）+ `⏱ Ns`；
  定时器 unref，任务结束清除。

---

## 命令系统

### 斜杠命令（/）

| 命令            | 别名     | 分类     | 说明                              |
|-----------------|----------|----------|-----------------------------------|
| /help           | ? h      | system   | 显示帮助或具体命令用法            |
| /exit /quit /q  | -        | system   | 退出 REPL                         |
| /clear          | -        | system   | 清屏                              |
| /history        | -        | system   | 查看本会话最近执行记录            |
| /status         | -        | state    | 显示当前档位、工作区、模型、统计  |
| /tier [name]    | -        | state    | 查看或切换档位                    |
| /workspace [path] | ws     | state    | 查看或切换工作区                  |
| /model [name]   | -        | state    | 查看或切换模型                    |
| run "任务"      | r        | task     | 执行真实任务（流式步骤反馈）      |
| simulate "任务" | s        | task     | 模拟执行（不写文件，预估）        |
| review [files]  | -        | task     | 只读审查 + 白名单测试             |
| /memory ...     | -        | session  | 记忆管理（list/clear/...）        |
| /trace <id>     | -        | session  | 查看某条 turn 的详情              |
| /session ...    | -        | session  | save / load / list 会话           |
| /config ...     | -        | config   | 查看/设置配置（简化）             |
| /init           | -        | config   | 在当前目录生成 .zorge.json        |

## 交互增强（最新）

### 多行输入

当前实现使用**简单可靠的方式**：

- 输入 `:`（或 `::`）进入多行模式，提示符变为 `...`
- 逐行输入内容
- **空行**（直接回车）提交整个多行内容
- 在多行输入过程中按 `Ctrl+C` 可取消

**注意**：目前暂未实现经典的 `Esc + Enter` 提交多行（这是 Claude Code 等工具的习惯）。如果你习惯 Esc+Enter，可以在后续迭代中补齐。目前请使用 `:` + 空行。

也支持直接在单行粘贴多行文本后回车执行（取决于终端）。

### 自动补全（Tab）

- `/` 命令前缀补全（基于注册命令表）
- `@` 路径补全（实时扫描当前工作区文件/目录）
  - 例如输入 `run @src/u` → Tab 补全 `run @src/utils.ts` 等
- 常见任务前缀建议（`run `、`simulate `、`review `）

### 中断与控制

- 任务执行中按 `Ctrl+C`：请求中断当前 `solveIssue`
- 空闲时按 `Ctrl+C` 或 `Ctrl+D`：退出 REPL
- 多行输入中 `Ctrl+C`：取消多行，回到主提示符

### 高级上下文构造（PromptBuilder）

REPL 在调用 `ZorgeChaser` 之前，会通过 `PromptBuilder` 构造更丰富的 prompt：

- **P0-2 新增**：结构化 `<tier_constraint>` XML 块（最高优先级）
  - 每次 `buildForTask()` 都会**重新查询** `TierConstraintRegistry.get(session.tier)`
  - 包含 `max_tool_calls_per_step`、`forbid`、`require`、`execution_style` 等明确约束
  - 6 个档位全部有对应约束（quick/standard/high/max/ex/zorge）
  - Tier 切换后下一次任务立即生效（无缓存）

- 基于当前 `tierConfig` 的**铁律强度、记忆加载、Critique 策略**描述
- 自动加载**提炼记忆卡片**（按档位过滤：light/medium/high/full）
- 高档位提示锚点探索行为
- 最近 3 轮 Turn 的紧凑摘要
- 超过阈值时做简单压缩

这使得即使不依赖核心内部注入，REPL 侧也能提供“档位契约 + 历史教训”。

**示例**（high 档位会包含）：
```xml
<tier_constraint tier="high">
  <max_tool_calls_per_step>8</max_tool_calls_per_step>
  <forbid>skipping_verification, premature_success_claims</forbid>
  <require>read_before_write, verify_before_claim, real_test_execution</require>
  <execution_style>thorough</execution_style>
</tier_constraint>
```

---

## 颜色与 UI

- 优先使用 `chalk`（通过 `optionalDependencies` 安装）
- 缺失或加载失败时自动降级到 `src/utils/ansi.ts` 手写 ANSI（red/green/yellow/blue/gray/bold/clearScreen）
- Spinner 使用简化实现（无 ora 时退化）

---

## Ink 富终端模式（Path B，可选增强，Claude Code 风格）

ZIS 支持**可选的富终端体验**（基于 ink@5 + react@18），目标是提供类似 Claude Code 的固定底栏 + 滚动输出 + 结构化卡片。

### 激活条件（自动）
- stdout/stdin 均为 TTY
- 终端能力检测通过 `multiline`（至少支持较好的按键与布局）
- `ink` 和 `react` 成功通过**动态 import** 加载（它们位于 `optionalDependencies`）

满足以上时，`Repl.start()` 会**优先尝试**启动 Ink 模式，成功后**不再进入经典行模式循环**。

不满足或任意失败时，**完全静默回退**到经典行模式（见下文“降级行为”）。

### 界面分区（三区，底栏常驻）
- **TopBar（顶栏）**：档位色码 | 模型 | 工作区（缩短） | 预算进度条（`[████░░░░] 42%`） | 当前 phase / RUN 状态
- **Feed（中部滚动区）**：流式事件（step / critique / tool / thought / budget / text / markdown）。窗口化最近项，空状态有提示。
- **InputBar（底栏，常驻）** + **ConfirmBar（条件覆盖）**：
  - 普通输入：Enter 提交，↑↓ 历史，Ctrl+J 换行
  - 运行中：输入区显示 "running" 并禁用输入，但 Ctrl+C 仍可立即中止
  - 高档位写操作：ConfirmBar 覆盖（黄色双边框），提示消息 + `[y/N]`，Enter 默认安全（No）

### 主要交互与快捷键（Ink 模式）
| 按键              | 行为                              |
|-------------------|-----------------------------------|
| Enter             | 提交当前输入（命令或任务）        |
| ↑ / ↓             | 遍历输入历史                      |
| Ctrl + J          | 插入换行（多行输入）              |
| Ctrl + C（任务中）| 立即请求中止当前 solveIssue       |
| Ctrl + C（空闲）  | 退出 REPL                         |
| y / Y / yes       | ConfirmBar 下确认写操作           |
| n / N / Enter / Esc | ConfirmBar 下拒绝（安全默认）   |
| Tab（行模式）     | 命令/路径补全（Ink 模式下由系统原生处理） |

工具调用以 **ToolCard** 形式实时出现（图标 + 目标 + 状态着色 + 可选结果预览）。
思考内容以 **💭 ThoughtBlock** 形式出现（可展开 full）。
`softLimit` / budget 事件会同时更新 TopBar 进度条颜色与 Feed 中的 budget 项。

### Markdown / 代码块（本期范围）
Feed 中支持轻量 Markdown：
- `#` / `##` 标题着色
- `**粗体**`
- 围栏代码块（```lang）+ 基础语法着色（常见 JS/TS/JSON/Bash/Python 的关键字、字符串、数字、注释）

这不是完整 CommonMark 解析器，而是为“本期”快速可用而设计的手写轻量实现。如需更完整的高亮，后续可考虑可选 `ink-markdown` 等。

### 降级行为（强制纪律，零感知）
任何以下情况都会**静默**回退，不打印警告、不改变现有行模式行为：
- 非 TTY 环境（CI、管道、重定向、某些旧终端）
- `ink` 或 `react` 未安装或动态 import 失败
- 终端能力不足（`!caps.multiline`）
- 启动或渲染过程中任意异常

此时 `Repl` 会明确调用内部 `startLegacy()`，走原有 while 循环 + 经典 readline 流程。
smoke 测试永远在非 TTY 下运行，天然验证降级路径。

**核心零耦合**：`ZorgeChaser`、`VerifyCritiqueLoop` 等引擎完全不知道 ink 的存在。所有 UI 事件通过 `UiBridge` + `OutputRenderer.setFeedSink` 单向注入。

### 可选依赖声明
```json
"peerDependencies": { "react": "^18.3.0" },
"optionalDependencies": {
  "ink": "^5.0.0",
  "react": "^18.3.0",
  "chalk": "^5.3.0",
  "ora": "^8.0.1",
  "prompts": "^2.4.2"
}
```
ink 5.x 要求 React 18 作为 peer，因此同时声明了 peerDependencies 以减少 npm install 时的警告。

---

## 典型使用示例

```bash
zorge
# 进入后
  ▸ /tier high
  ▸ run "把 src/utils.ts 里的 parse 函数改成更严格的类型守卫并加测试"
  ▸ /status
  ▸ /session save my-feature
  ▸ /exit

# 之后恢复
zorge
  ▸ /session load my-feature
```

单次：
```bash
zorge simulate --issue "重构登录并验证" --tier max --yes
zorge memory clear --category READ_BEFORE_WRITE_VIOLATION
```

---

## 故障排查

- 看不到颜色 → 检查终端是否支持，或手动 `npm install chalk`
- `EPERM mkdir ~/.zorge` → 在受限环境属正常，REPL 已容错
- 旧命令行为变化 → 确认是否被 REPL oneShot 接管，参数解析更简单
- 想回退到最老的纯单文件 CLI → 可在 `src/cli.ts` 里临时恢复旧逻辑（不推荐）

---

