# Panshalach 使用手册（烛龙 Zhulong）

> 烛龙（Zhulong）· 内部代号盤沙拉克 Panshalach：基于 openPangu 的记忆增强通用智能体。
> 本手册对齐 **v0.8.8**（0.7 终止语义重构/意图前移/记忆落定 → 0.8 turn 四模块 + messages 双通道 + 执行层七项强化 + Claude Code 级交互手感 + 记忆链治理 + 身份画像通用化）。

## 1. 环境要求
- Node ≥ 18（含全局 fetch；开发实测 Node 22）；TypeScript 5.6（构建）。
- 零运行时依赖（`dependencies: {}`）；ink/react/chalk 为可选富 UI（非 TTY 自动降级行模式）。
- 推理：openPangu 端点（本机 / 昇腾 vLLM-ascend / MindIE，OpenAI 兼容）。无端点时可配置任意 OpenAI 兼容网关先跑通流程。

## 2. 安装与启动（0.6.5 起全局部署）
```bash
cd <repo>
npm install        # devDependencies（tsx/typescript）
npm run build      # → dist/
npm link           # 全局部署：生成 zhulong / panshalach bin（旧别名 zorge 保留）
```
启动：
```bash
zhulong                             # 交互式 REPL（对外主名）
panshalach --help                   # 帮助（同义 bin）
panshalach run "任务..."            # 单条任务（one-shot）
panshalach --headless run "任务..." # 兼容别名（0.8 起非 TTY 默认真实执行；写仍受审批档位门禁）
panshalach --approval full run "…"  # one-shot/headless 指定审批档位（见 §4）
```

## 3. 配置（两级加载 + 模型播种）

**两级配置加载**（0.6.5 修正）：
- 用户级：`~/.panshalach/config.json`（基底；目录可用 `PANSHA_USER_CONFIG_DIR` 重定向）
- 项目级：`<workspace>/.panshalach.json`（深合并**覆盖**用户级——项目级优先）

项目根 `.panshalach.json` 示例：

```json
{
  "model": "openpangu:openPangu-7B",
  "providers": {
    "openpangu": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKey": "EMPTY",
      "models": ["openPangu-1B", "openPangu-7B", "openPangu-7B-VL"],
      "modelContexts": { "openPangu-1B": 4096, "openPangu-7B": 8192, "openPangu-7B-VL": 8192 }
    }
  }
}
```

**模型选择优先级**（0.6.5 modelSeed 播种）：
**记忆链 env（0.8.4/0.8.5）**：`PANSHA_SEMANTIC_SEARCH`（`0`=关闭语义混合检索，默认开；异常自动降级纯词面）· `PANSHA_MEMORY_LIMIT`（显式注入卡数帽，未设时按窗口比例预算自适应）· `PANSHA_TODAY`（锚定"今天"，仅评测/测试用；非法值自动回退真实当天）· `PANSHA_CHAT_MEMORY=0`（关闭对话事实沉淀）。

1. `PANSHA_MODEL` env（永远优先）；
2. 配置文件 `model` 字段（0.6.5 起兜底播种生效——此前该字段从未被读取，不带 env 必报"未配置可用的模型客户端"）；
3. REPL 内 `/model` 显式切换。

模型路由用 `openpangu:` 前缀（`provider:model`），如 `openpangu:openPangu-7B`；启动后 `/model list`（遍历已配置 provider 拉模型）→ `/model openpangu:openPangu-7B` 切换。

**上下文窗口预算（0.7.3 起挂真值）**：auto-compact 阈值与执行循环的窗口预算按当前模型的真实窗口计算——优先级：`PANSHA_CTX_WINDOW` env（显式覆盖）> 配置 `modelContexts` > `/model list` 端点探测缓存。**未知窗口回落 32768 保守值**（只多压缩不误判，8K 小模型不再被 128000 假定撑爆）；`/model list` 对未知上下文如实显示"未知"并持久化 `null`（不再写 256000 假值），`/model` 切换后占用计量清零重取。

若 openPangu 网关需要 key（如昇腾云/ModelArts）：把 `apiKey` 换成真实 key；或用 env 三件套（key 不进配置文件）：`PANSHA_OPENPANGU_API_KEY`（可再加 `_BASE_URL`/`_MODEL` 覆盖）；或配 `apiKeyCmd`（执行命令取 stdout 首行作密钥）。`SCNET_API_KEY` 仅作为 scnet provider 的历史别名。

> 适配说明：模型协议原生 `tool_calls`（OpenAI JSON，`detectedFormat:'openai-json'`）为主路径——0.6.5 起请求侧随每次请求透传 `tools + tool_choice:auto`（原生 function calling 闭环）；文本协议/`<>` 严格三路探测为兜底（`PANSHA_USE_LEGACY_PARSER=1` 可强制走文本解析）。

## 4. 审批档位（--approval 三档）

| 档位 | 行为 |
|---|---|
| `readonly` | 只读工具放行，写文件/执行类一律拒绝 |
| `default` | 读放行；写需确认 |
| `full` | 全部放行（写不确认） |

- one-shot/headless：`--approval <readonly|default|full>` 或 `PANSHA_APPROVAL` env（0.6.5 前锁死 readonly，写文件必然被拒）。**0.7.3 起审批语义在全部入口真实生效**——one-shot / classic / simulate 向执行引擎透传 `approvalMode`、会话放行清单与审批桥（此前 flag 只改会话字段、引擎收不到）。
- REPL 内：`/approvals <mode>` 随时切换；`max/ex/pangu` 档位任务开始前另有确认面板。审批提示选 **`a`（总是允许）**：对 `write_file`/`edit_file` 决策持久化到项目配置 `.panshalach.json` 的 `approvalAllowlist`（0.7.3 起）——下次会话启动自动并入放行清单；对 **`bash` 仅本会话内放行且不落盘**（2026-09-13 修缮：防一次 'a' 等于任意命令跨会话永久免审），且危险命令（rm -rf / git push -f 等）即便在放行清单内仍会再次弹卡确认。

## 5. 交互手感（0.8 · Claude Code 级）

| 操作 | 行为 |
|---|---|
| 输入 `/` | 即时弹出斜杠命令菜单：继续输入实时过滤（前缀精确→模糊兜底）、↑↓ 导航反显、分组小标题、Enter 执行、Esc 关闭；任务运行中/审批挂起不激活 |
| `shift+tab` | 档位环循环：⏸ plan（蓝）→ ⏵ default（灰）→ ⏵⏵ auto-accept（青）→ ⏵⏵⏵ full（品红）——每档专属符号与颜色的徽标行/回执 |
| `/model` | 菜单化呈现：编号行 + 青色模型名 + 绿色当前项（`>` 前缀 + "当前生效"）；`/model <名称|编号>` 直达，`/model list` 拉远程列表 |
| `/tier` | 思考强度水平滑杆（对标 CC /effort）：更快←→更强刻度 + ▲ 光标，←/→ 调节、Enter 确认、Esc 取消；ex/pangu 为品红扩展区；`/tier <名称|编号>` 直达 |
| `?` | 问号是给模型的普通输入；帮助只走 `/help`（常用 8 条 + 全量命令） |

## 6. 意图分类与执行行为（0.7 落地 · 0.8 通用画像）

输入任务后，入口先做轻量意图分类（`src/cli/taskIntent.ts`，纯函数）：

| 意图 | 触发 | 行为 |
|---|---|---|
| `chat` | 问候/自我询问/纯问答（"1"、"你好"、"你是谁"） | **单次 complete 直接回答**：不进 agent 循环、不灌格式教学与工具 schema；`stopReason='answered'`，正文直接呈现 |
| `search` | 提到文件/路径但无操作动词（"hello.txt"、"src/foo.ts"） | **受限只读循环**：≤3 步、强制 readonly、禁写禁 bash；搜到报告位置与概要，**搜不到则询问用户具体用意**（不猜、不创建） |
| `task`（execution） | 工程动词/工具/命令/@path（"修复…"、"运行测试"、"改 src/a.ts"） | 完整验证循环：思维链 → 工具调用 → 验证信号（PASS/FAIL）→ 回合落定 |
| `meta` | `/命令`、`r 任务`、`s 任务` 前缀 | 不进 agent（本地命令处理） |

- 逃生门：`PANSHA_INTENT_GATE=0` 关闭分类，全部按 execution 走完整循环。
- **回合结局四态**：`completed`（真实验证 PASS → UI"已通过验证"，喂记忆成功卡）/ `answered`（end_turn 有面向用户正文 → UI"已回复"并显示正文，**不**喂成功卡）/ `no-verification`（空白空转 → UI"未通过验证"）/ `error`（0.7.4：模型/网络/解析异常 → UI"✗ 任务执行失败"并提示检查端点——**与用户中断严格区分**，模型故障不再伪装成"已中断"）；另有 `max-steps`/`consecutive-failures`/`aborted`（真中断，保持"已中断·现场已保留"）。
  - 0.7.3 起 `completed` **真机可达**：执行引擎对真实成功的工具结果（bash `EXIT_CODE:0` 尾行、写/改成功）确定性追加 `VERIFICATION: PASS` 规范尾标，验证信号不再只认 smoke mock；截断响应（`finish_reason=length`）禁判 answered，execution 意图下"只说话不动手"首次会被注入格式提醒重试一步。
  - 0.7.4 起模型端点异常不再空转或伪装中断：EMPTY_RESPONSE/网络错误经重试后仍失败 → 回合落 `error`，UI 显示错误首行 + 端点检查提示（diffusion/embedding 类模型不被 LM Studio chat 端点支持）。

## 7. Ctrl+C 与中断（AbortSignal 贯穿 + 中断/错误语义分离）

- 运行中 Ctrl+C **真正中止任务**：信号贯穿 `runAgentTask → solveIssue → loop → 模型请求（fetch/streamChat）→ 工具执行`，回合记 `stopReason='aborted'`，UI 显示"已中断"并等待底层 settle——不再"提示符回来了、网关还在刷 POST"（0.7.3 起 classic REPL 路径同样贯穿，不再假中止）。
- **中断 vs 错误（0.7.4）**：只有用户/信号主动中止才显示"已中断·现场已保留"；模型/网络/解析异常落 `stopReason='error'`，显示"✗ 任务执行失败 · <错误首行> · 检查模型端点是否为对话模型（diffusion/embedding 不受支持）· 或重试"。
- 已知边界（如实声明）：fetch 已发出后 abort 中断的是读取/连接，网关侧生成可能仍在后台算完；bash 子进程强杀已落地（0.7.1 tree-kill：Windows `taskkill /T /F`，POSIX `kill(-pid)`）。
- 会话安全（0.7.3 起**现场保留有数据支撑**）：中断的回合写入 session 与 rollout jsonl（可 `/rewind`/`--resume` 续接），并保留中断时已流出的部分正文（turn 的 `partialText` 字段）；中断前已解析未执行的工具调用补合成结果保持 call/result 成对；已写盘文件可用 `/undo` 撤销。
- **dist-fresh 提醒（0.7.4）**：npm link 的全局 bin 指向 dist/——若 src 有比 dist 更新的改动，交互模式启动时会出现"⚠ dist 落后于 src，请执行 npm run build"黄字提醒（headless/一次性执行不打扰）。

## 8. 命令总表（REPL 内 `/` 前缀）

| 命令 | 作用 |
|---|---|
| `/tier` / `/tier <t\|N>` | 六档思考强度滑杆（quick/standard/high/max/ex/pangu，默认 high；编号与刻度同序） |
| `/model` / `/model <name\|N>` / `/model list` | 模型菜单 / 切换（编号直达）/ 拉远程列表 |
| `/approvals <mode>` | 审批 readonly/default/full |
| `/undo` `/rewind` | 撤销最近写盘 / 按回合回放 |
| `/compact` | 压缩会话历史（保留最近 6 轮 + 摘要 + 血统账本） |
| `/resume` `/tree` | 会话续接 / 会话树（branch）；`--resume last` 可 one-shot 续接 |
| `/memory` | 记忆管理（见 §10） |
| `/feature list\|add\|done` | 当前特性跟踪（任务状态） |
| `/run "任务"` `r 任务` | 执行任务；`s 任务` simulate |
| `/review` `/trace` `/usage` `/status` `/config` `/init` `/session` `/history` `/workspace` `/agents` `/serve` `/exit` | 其余命令 |

> 全部命令在 REPL 输入 `/` 即有即时菜单可浏览（过滤/↑↓/分组）——本表与菜单同源（命令注册表元数据）。

## 9. 档位速查（单 rollout）

六档均为单 rollout（0.6.2 起）；0.7 判官摘除后**回合上界 = 单次 maxSteps**，无续跑×N。`search` 意图无论档位一律 ≤3 步。记忆加载为窗口预算 × 档位乘数（light 0.6 / medium 1.0 / high 1.2 / full 1.4），非固定条数。

| tier | 用途 | 步数上界（单 rollout） | 记忆加载 | 高纪律 |
|---|---|---|---|---|
| quick | 热修复 | 10 | 轻量（0.6×） | 无 |
| standard | 常规修改 | 15 | 轻量（0.6×） | 无 |
| high（默认） | 日常主力 | 20 | 中等（1.0×） | 无 |
| max | 重要/高风险 | 25 | 高（1.2×） | 强 |
| ex | 极难/核心 | 30 | 高（1.2×） | 强 |
| pangu | 终极长程 | 40 | 全量（1.4×） | 强 |

写工具（write_file/edit_file）0.6.5 起**全档位注册**（安全性由审批门禁兜底，不靠隐藏工具）；预算软限按每次模型调用真实累计（0.7 修复 `[最终预算 0%]` 恒 0），`/usage` 可查。

## 10. 记忆命令（长程记忆入口）

```
/memory list [--kind failure|success|preference]   列出记忆卡
/memory remember [--pin] <内容>                     记住偏好（--pin 冻结衰减）
/memory forget <id>                                 删除卡
/memory merge                                       同主题自动合并（原卡归档）
/memory search <词>                                 关键词检索
/memory stats                                       注入审计视图（按 kind 卡数 + 注入账本 + 最近注入事件）
/memory export [file] / import <file> [--merge false]   导出/导入
```
记忆卡存于 `<workspace>/.panshalach-memory.json`（内部名），自动加入 `.gitignore`。

> 0.7 信号收紧：success 卡只来自 `stopReason==='completed'`（真实验证通过）或用户正向反馈——**纯问答/闲聊的 answered 回合不再产生成功卡**（UI 成功 ≠ 记忆成功）。
> 0.7.2 起任务落定**自动产卡**：completed 任务在落定点自动 refine→save（无需 `/memory remember`）；被注入的卡若其参照文件被本任务真实写集触碰，自动 `markVerified` 保鲜（发 `memory.finalized` 事件）。覆盖 SSE/server/headless 路径。
> 0.8.1 记忆链治理（对抗性审计驱动）：产卡携带任务信息（修复通用卡零信息）、markVerified 断链接通、count 封顶 min(count,3) 防"永生卡"霸榜。

## 11. 长程使用姿势
1. 开场用 `/init` 生成项目指令页 `.panshalach/AGENTS.md`（验证命令 + 不变量），agent 每轮能读到"如何验证"。
2. 关键约束用 `/memory remember` 或让回合写闭环（R1 里程碑后自动提炼）沉淀；执行类任务尽量给出验证方式（"跑 npm test 验证"）以提高 completed 率。
3. 只找文件不改动：直接说文件名（触发 search 只读搜索）；它搜不到会反问你意图，而不是乱建文件。
4. 长任务用 `/feature add "…"` 跟踪单一进度；每轮结束 `/feature done <id> <证据>`。
5. 会话长了自动/手动 `/compact`；跨进程用 `/resume` 续接。
6. 远程/前端演示：`/serve --port 3456`（SSE，Bearer token 或 localhost-only）。

## 12. 内部名说明（品牌迁移中）
对外品牌为**烛龙 Zhulong**；内部仍使用历史名保证既有会话/记忆/脚本兼容：
`.panshalach.json` / `.panshalach-memory.json` / `~/.panshalach/` / `PANSHA_*` 环境变量 / `PanshalachChaser` 类 / `zorge` bin（保留别名）。
收敛到统一名的迁移计划见 [ROADMAP-NEXT.md](ROADMAP-NEXT.md) §C。
