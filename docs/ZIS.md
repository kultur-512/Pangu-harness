# Zorge（目录页）

> 本文件是**目录页**（Codex AGENTS.md 语义，~100 行）：路由 + 不变量 + 链接。
> 细节在 `docs/ZIS-DETAILS/*.md`，按需阅读（L04：give the map, not the manual）。

## 这是什么

零强依赖工程 Agent CLI（TypeScript ESM，dependencies 恒空）：交互式 REPL 执行编码任务，
含 SSE 流式引擎、审批安全闸、会话持久化（jsonl 追加式）、六档强度、typeahead 建议引擎、
可选 Ink 富终端（Claude Code 风格）。

## 快速开始

```bash
zorge            # 交互式 REPL（rich TTY 自动启用 Ink 富终端）
zorge "任务"      # 一次性执行
```

- `/model list` → 拉取模型列表；`/model <name>` → 切换（a6/scnet provider:model）
- `/model` 空格 → 两级子菜单（provider → 模型），Tab 补全、↑↓ 选择、Enter 提交
- 六档 tier：`quick / standard / high / max / ex / zorge`（`/tier high` 切换）
- 直接输入任务或 `/run "..."` → 执行（引擎串行/并行 rollout 见 ARCHITECTURE.md）
- `--branch <name>` 分支会话；`--resume <id>` 续写；`/tree` 会话树

## 命令总表（registry 26 + 内置）

```
/help /status /tier /model /clear /undo /rewind /compact /usage /resume
/tree /agents /approvals /memory /review /feature /init /history /trace
/session /workspace /config /run /simulate /serve /exit
内置：/edit /e（编辑上次输出）；/q /quit（=/exit）；/model list（远程模型）
```

- `/init` → 生成 `.zorge/AGENTS.md`（项目指令目录页）+ `feature_list.json` + `ENV.md`
- `/feature list|add|done|next` → 特性追踪（done 需证据，一次一个 active）

## 不变量（硬约束，模型必须遵守）

- **写前必读（RBW）**：修改文件前先读（read 工具）
- **变更需可验证**：验证命令显式列出（见下），不允许"逻辑上应该通过"
- **斜杠命令本地执行，永不进引擎**（rich/行模式一致）
- 负向工具清单（`<negative_tool_list>`）命中 → TOOL_FORMAT_ERROR + 三连击硬停
- 环境自描述在 `.zorge/ENV.md`（Node 版本 / 依赖 / 验证命令），变化才增量注入

## 验证命令

| 门禁 | 命令 |
|---|---|
| 类型检查 | `npx tsc --noEmit` |
| 构建 | `npm run build` |
| 测试 | `npm test`（node --test --import tsx "tests/**/*.test.ts"） |
| 清理 | `node verify-zorge-cleanup.mjs` |
| 冒烟 | `node scripts/test-repl-smoke.mjs` |

M2.0 挂起门禁：计时器 unref、句柄关闭、进程干净退出（node --test 0 cancelled）。

## 架构速览（细节 → docs/ZIS-DETAILS/ARCHITECTURE.md）

- **引擎**：ZorgeChaser → VerifyCritiqueLoop → engineAdapter（工具 + 审批 + 护栏 + pre/post-execute 事件点）
- **并行 rollout**：TestTimeOrchestrator.runMultiple 真并行（Promise.allSettled + 写互斥 + 预算聚合），AgentTree 图模型驱动渲染
- **上下文**：PromptBuilder（思维链阶梯 / 记忆卡 / 当前特性 / 环境增量）
- **会话**：RolloutStore（jsonl 追加式 + branchOf + 会话树）
- **交互**：typeahead 建议引擎（命令/provider/model/历史单源 + 建议条 + ghost text）

## 文档索引

| 主题 | 文件 |
|---|---|
| 架构（含并行 rollout / 图工程 / 六档 / 构建） | docs/ZIS-DETAILS/ARCHITECTURE.md |
| 会话资产（分支 / rewind / compact / resume / 持久化） | docs/ZIS-DETAILS/SESSION-ASSETS.md |
| 输入手感（流式 / 键位 / typeahead / Ink / 示例 / 排障） | docs/ZIS-DETAILS/INPUT-UX.md |
| 生态（skills / MCP / 子代理树 / 相关文档） | docs/ZIS-DETAILS/ECOSYSTEM.md |
| 安全（审批 / 护栏 / 负向清单 / 安全闸） | docs/ZIS-DETAILS/SAFETY.md |
| 实战检验报告（T1-T7 + 短板 + T7 三路对照） | docs/DOGFOOD-REPORT.md |
| 框架对标（learn-harness 五子系统 + 缺口清单） | docs/LEARN-HARNESS-GAP.md |
| Claude Code 源码重设计规格（CC 设计思想 × Zorge） | docs/ZORGE-REDESIGN-CC.md |
| 与 Claude Code 对齐路线图（P0-P5） | ROADMAP-CLI-PARITY.md |
| 三 Agent 协作体系（编码/一级审查/二级审查约束 + 流程） | docs/agents/ |
| 三 Agent 交接工作区（共享状态 + 交接归档） | .agents/ |

## 维护态（0.4.0）

Zorge 进入维护态：P0-P5 全部完成、dogfooding 战役（T1-T7 + 短板 #9 修复）已合入、
409+ 用例零失败。后续变更走标准流程：bug 修复提 issue（复现 + 门禁清单）、
每批独立提交（`fix-*:` / `feat-*:` / `P1-Txx:` 格式）、零新增依赖。
