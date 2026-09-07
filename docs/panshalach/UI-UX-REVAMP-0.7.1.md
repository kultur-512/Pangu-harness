# 烛龙 UI/UX 手感改良全量方案（0.7.1）

> **执行状态：已执行**（commits e88048a 批次 A + 72bdf21 批次 B）——改造包 P0/P1/P2/P3 全部落地 line 模式主路径，含评审修复与 `/mode plan` 落错档既有 bug 修复；真机 TTY 手测仍待端点。验收数字见 CHANGELOG「0.7.1」段（批次 A 后 570 例、批次 B 后 625 例）。**后记（0.7.4）**：本方案 P2-2 的 `?` 快捷帮助面板已按控制人裁决改为透传给模型（帮助只走 `/help`），文中相关描述为 0.7.1 时点行为。

> 依据：CC 2.1.88 源码解剖（sourcemap 原始 TS，25 条可移植原则）× 本项目 REPL 病灶清单（12 项 / Top8）。
> 核心判断：交互资产（Completer/SlashPicker/FuzzyMatcher/stringWidth/HelpCommand 分组版/耗时渲染）已在库中，**接线断在默认 line 模式**。主线是接线 + 堵信任级伤口，不是新造组件。
> 约束：ink 未安装，line 模式（sseInteractive.ts）是唯一真实主路径；一切改良必须落在 line 模式。

## 改造包 P0 —— 信任级（Ctrl+C / 污染 / 审批）

### P0-1 Ctrl+C 全链路修复（病灶 #1）
- `process.on('SIGINT')` 兜底（任务运行中 readline pause 后 ^C 无人接，参照 Repl.ts:134-137 的双保险注释）。
- 空闲 Ctrl+C 改 **二次确认**：首按显示灰字 `再按一次 Ctrl+C 退出 · Ctrl+C 正在执行时 = 中断任务`，2s 内再按才退出（CC double-press 模式）。
- 消除幽灵退出：任务结束后 resume 时丢弃缓冲期内积压的 ^C（abort 已置空时忽略一次 SIGINT）。
- 中断提示去重（"已请求中断…"与"任务已被中断"合并为一条）。
- **验收**：任务运行中 Ctrl+C ≤1s 内停止网关请求；空闲连按两次才退出；任务结束后不会意外退出。

### P0-2 gerund 输出污染修复（病灶 #2 一部分）
- gerund 标签不再用裸 `\r` 原地写：输出正式内容前先 `\r\x1b[K`（清行）再 writeLine；gerund 重绘统一走单点函数。
- **验收**：连续输出后对话记录中不出现 `研磨中… ⏱ 12s[Step 1]` 拼接。

### P0-3 审批体验三连伤（病灶 #7）
- 审批等待期间**暂停 gerund 重绘**（paint 循环检查审批挂起标志）。
- 审批 readline 接 SIGINT：Ctrl+C = 拒绝（等效 n），不再卡满 60s。
- 超时倒计时可见：提示行带 `(N s 后自动拒绝)`，每秒更新。
- 选项光谱化（CC 原则 4/12）：`y=本次允许 · a=本会话总是允许 · n=拒绝（可附说明）`；拒绝回车后可选输入一句"告诉它该怎么做"注入下一轮 prompt。
- **验收**：审批提示行不被覆盖；Ctrl+C 立即拒绝；倒计时可见。

## 改造包 P1 —— 反馈级（流式 / 工具卡片 / 结束总结）

### P1-1 真流式渲染（病灶 #3）
- line 模式接住 `thinking.delta`：默认**单行滚动状态**（dim 斜体 `∴ ` + 最新一行截断到终端宽度），thinking 结束折叠为灰字 `∴ 思考了 Ns（/verbose 展开）`。
- `message.delta`（正文）流式逐字打印（中文场景按行 flush，避免半字符）。
- `answered` 不再只贴 600 字截断——正文已在流式中呈现，结束行只给统计。
- **验收**：提问 chat 类问题，回答逐字出现；思考过程默认单行滚动不刷屏。

### P1-2 工具执行实时卡片（病灶 #4）
- 引擎已有 `tools/pre-execute` / `tools/post-execute` 事件（engineAdapter emitEvent），line 模式接线渲染：
  - 头行：`▸ bash  echo "zhulong-deployed" > hello.txt`（工具名青色 + 参数摘要，bash 截 160 字符）
  - 结果行：`  ⎿ Wrote 1 line · 4ms`（**CC 动词句式**：动词+加粗数字+单位；运行中现在进行时 `Writing…`，完成过去时 `Wrote`）
  - 错误：`  ⎿ ✗ UNKNOWN_TOOL · 可用: bash, read_file…`（红，一句人话 + 可展开）
- read_file → `Read 120 lines`；write_file → `Wrote N lines to path`；edit_file → `Added N, removed M` + diff hunk（复用 ToolResult 已有的 ⟦DIFF⟧ 标记）；grep/glob → `Found 8 files`。
- **验收**：任务运行中每个工具调用实时出现头行+结果行，无黑箱期。

### P1-3 任务结束总结（病灶 #6）
- 结束行升级为总结块（全部 dim，CC /cost 式）：
  ```
  ✓ 已通过验证 · 12 步 · 38.2s · ~4.2k tokens
    下一步: /undo 回退 · /memory 查看沉淀 · 继续描述下一个任务
  ```
- 耗时进程内计时（不依赖缺失的 done 事件）；token 从 usageService 取；`下一步` 按 stopReason 分支建议（no-verification→"模型未完成验证，可补充要求或 /retry"；aborted→"已中断，现场已保留"）。
- **验收**：每个任务结束都有 耗时+步数+token+场景化下一步。

## 改造包 P2 —— 引导级（横幅 / 补全 / 帮助 / 状态）

### P2-1 启动横幅 v2（病灶 #1）
```
烛龙 Zhulong v0.7.1
  模型 openpangu-embedded-1b-i1 · 档位 high · 模式 default · C:\ws
  ? 快捷帮助 · /help 全部命令 · Ctrl+C 中断/退出
```
- 模型/档位/模式来自 session 与 ConfigManager（P0 同源）；cwd 超宽截断（stringWidth）。
- 空输入回车给灰字提示 `输入任务描述，或 ? 看快捷帮助`。

### P2-2 Tab 补全 + `?` 快捷帮助 + 未知命令建议（病灶 #5）
- line 模式 readline 接 **Completer**（已存在，classic 路径在用）+ FuzzyMatcher。
- `?`（行首单独输入）→ 快捷帮助面板（常用 8 条 + 提示 /help 看全部）。
- 未知命令：`未知命令 /modl · 你是不是想要 /mode? (回车执行)`。
- **验收**：Tab 补全 / 命令、`?` 出快捷面板、错字有建议。

### P2-3 /help 统一（病灶三张脸）
- line `/help` 复用 HelpCommand 的分组排版（26 命令分类表），废弃 7 命令版与单行版。

### P2-4 状态可见化（病灶 #9）
- 提示符升级：`▸ ` → 模式徽标行（输入行上方 dim）：`⏸ plan · shift+tab 切换` / `⏵ default` / `⏵⏵ auto-accept`（line 模式绑 shift+tab：readline keypress 捕获）。
- /mode 切换回执 CC 式复述：`已切换: default · 写操作需确认`。

## 改造包 P3 —— 质感级

### P3-1 CJK 宽度治理（病灶 #11）
- `stringWidth`（已在库，零调用）接进：横幅截断、table() 对齐（替换 `.length`）、thinking 单行截断、工具参数摘要截断。
- thinking 倾泻修复：单行滚动渲染（P1-1 已含），展开模式按 `宽度-4` 折行 + 2 空格缩进。

### P3-2 文案统一（病灶 #10）
- gerund 词表纯中文化保留趣味（推演中/研磨中/凝神中/翻检中/抽丝剥茧中…）；phase 值本地化（explore→侦察 rollout→执行）；删 `Critique:` 死前缀。

### P3-3 情境 tip（CC 原则 17 轻量版）
- 三个触发点各一条、每会话最多 2 条、dim 一行：启动时（新手未跑过任务）`Try 修复 xxx 的一个 bug`；等待 >30s `长时间无进展可 Ctrl+C 中断后补充上下文`；上下文 >75% `接近自动压缩阈值，/compact 可立即压缩`。

## 不做（明确排除）
- 不引 ink/react（optional 依赖装机不可控，line 模式即主路径——把"富 UI 幻觉税"翻转成"line 模式即产品"）。
- 不做 /cost 费用估算（本地模型无价格口径，token 计数已够）。
- 不动 0.7.0 意图分类/终止语义/AbortSignal 主链（只消费其事件）。

## 验收门
1. `npx tsc --noEmit` 干净；`node --test --import tsx --test-concurrency=4` 全绿（方案时点基线 545 例；执行后实际值见 CHANGELOG 0.7.1 段）。
2. 真实 LM Studio 手测：流式问答可见、工具卡片实时、Ctrl+C 三态正确、审批不卡、Tab 补全可用。
3. review 子智能体过审（对照本方案逐条核销）。

## 实施切分（防冲突）
- 批次 A（单子智能体串行，主战场 sseInteractive.ts + approval.ts + GerundSpinner + engineAdapter 事件透传）：P0 全部 + P1 全部。
- 批次 B（A 完成后）：P2 全部 + P3 全部。
- 每批次后：tsc + 定向测试 + 真跑冒烟。
