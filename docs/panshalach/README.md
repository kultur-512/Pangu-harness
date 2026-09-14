# 烛龙 Zhulong — 基于 openPangu 的记忆增强通用智能体

> **命题**：基于 openPangu-1B/7B/7B-VL 构建具备长程上下文管理能力的智能体（华为 · 国产操作系统软件组）。
> **一句话**：把"每轮都从零记"的 Agent，变成"有卡片记忆 + 会话资产 + 事件/状态持续跟踪"的长程智能体；既擅长软件工程（读写代码、执行命令、验证变更），也直接回答日常对话、知识问答与创作（0.8.0-rc 身份画像对齐）。
> **当前版本 v0.8.0-rc**（0.7 终止语义重构/意图前移/记忆落定 → **0.8 换地基：turn 四模块 + messages 双通道协议 + stable/volatile 三段 prompt + 执行层七项强化 + Claude Code 级交互手感 + 记忆链三缺陷治理**）· 分版详录见 [CHANGELOG.md](../../CHANGELOG.md) · 外部产品 **烛龙 Zhulong** / 内部代号 **盤沙拉克 Panshalach**。

## 0.8.0-rc 架构速览

- **turn 会话壳四模块**（`src/cli/repl/turn/`）：2115 行巨函数 sseInteractive 拆为 `TurnContext`（巨状态显式化）/ `TurnController`（任务提交/审批桥/中断/排队 drain）/ `TurnRenderer`（SSE 事件渲染/CC 式视觉纯函数）/ `CommandRouter`（命令注册派发）+ `SlashMenu`（斜杠即时菜单纯函数状态机）——sseInteractive 收缩为会话壳。
- **messages 双通道协议**（M1-PROTOCOL）：`ChatMessage`（system/user/assistant/tool role）+ `ModelClient.chat()/streamChatMessages()` 加性接口，`complete(prompt)` 文本协议保留为降级路径；`PANSHA_MESSAGES_MODE=off` 逃生门。
- **stable/volatile 三段 prompt**：stable 段（身份+L0+档位契约）任务间字节级相同 → 置 system 首消息命中网关前缀缓存；volatile 段（记忆卡/环境/任务）每任务变。
- **执行层七项**（M2，hermes 对齐落地）：读并发+写 barrier 分段调度 / 卡死硬闸 `src/loop/guardrails.ts`（同参失败 5 次阻断·同工具 8 次强制终局·幂等无进展 5 次）/ 工具大输出落盘 scratch + read_file 回读 / 真实 usage 计量 / 错误分类器 + overflow→强制 compact / 敏感路径全档位写保护 / Turn.role 字段。
- **CC 级交互**：输入 `/` 即时弹出斜杠菜单（过滤/↑↓/分组/滚动）· shift+tab 档位环每档专属色徽标（plan 蓝/auto-accept 青/full 品红）· `/model` 菜单化（编号直达/当前项绿色）· `/tier` 思考强度水平滑杆（←→ 调节/Enter 确认/Esc 取消）。
- **记忆链治理**（0.8.1 审计驱动三修复）：通用卡产卡携带任务信息（零信息卡根因）/ markVerified 断链接通（injectedCardIds ∩ 真实写集）/ count 封顶 min(count,3) 防"永生卡"；success 卡只认 `stopReason==='completed'`。
- **身份画像通用化**：通用全能智能体（工程/对话/知识/创作皆为所长），档位语义限定为工程执行参数——1B 小模型不再把"工程助手"执行成"只答工程"。
- **回合七态终止**：completed / answered / max-steps / consecutive-failures / aborted / no-verification / error（`TurnStopReason`）——模型故障与用户中断严格分离。

## 文档导航（活文档）

| 文档 | 内容 | 用途 |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 系统分层架构、记忆模块设计、推理流程、资源消耗、核心创新点 | **命题提交物 (1) 架构设计文档** |
| [MEMORY-DESIGN.md](MEMORY-DESIGN.md) | 记忆增强层深挖：卡片 schema、提炼/过滤/衰减/注入、已知差距 | 记忆子系统设计说明 |
| [EVALUATION.md](EVALUATION.md) | 场景设定、消融口径（A/B/C/C4）、指标、数据表（真实数据回填位） | **命题提交物 (2) 效果评估报告** |
| [SUBMISSION.md](SUBMISSION.md) | 国创赛项目书：概述/方案/创新点/差异化/部署/评测 | 命题提交物（项目书） |
| [EVAL-FEASIBILITY.md](EVAL-FEASIBILITY.md) | 评测基准选型与可行性评估（外部基准接入裁决 + 落地方案） | 评测决策文档 |
| [DEPLOY-CN.md](DEPLOY-CN.md) | 从零到一部署：本机已验证路径 + 昇腾/麒麟框架（待实测）+ PANSHA_* 全集 | 部署指南 |
| [USER-GUIDE.md](USER-GUIDE.md) | 安装、配置、交互手感（斜杠菜单/档位环/滑杆）、命令总表 | 用户手册 |
| [ROADMAP-NEXT.md](ROADMAP-NEXT.md) | R0-R9 路线 + 实施合同 + 遗留表（0.8 M3 项/记忆审计剩余项） | 当前执行路线 |
| [../../CHANGELOG.md](../../CHANGELOG.md) | 分版本变更详录（各版本段即变更申报记录） | 变更史 |

> 迭代过程文档已归档至 [archive/2026-09-12-process-docs/](../../archive/2026-09-12-process-docs/)（0.7.x 各版方案、GAP-MATRIX、hermes 对齐、反思/审查报告、solution 方案系列 10 篇、REFACTOR-ASSESSMENT 历史报告、WORK-PLAN 并行计划——共 17 项）——内容已被上述活文档吸收，仅供追溯设计缘由。

## 目录（仓库根）

```
src/
  PanshalachChaser.ts            核心执行引擎（solveIssue + 意图路由 + chat 直答三级回落 + think 剥离）
  cli/taskIntent.ts              入口意图分类：chat / search / task / meta
  cli/repl/turn/                 会话壳四模块 + SlashMenu（0.8 拆分：Context/Controller/Renderer/CommandRouter）
  loop/VerifyCritiqueLoop.ts     执行循环（messages 双轨/三路解析/铁律/七态终止/guardrails 接入）
  loop/guardrails.ts             卡死硬闸（同参失败/同工具失败/幂等无进展）
  model/errorClassify.ts         API 错误八类分类（overflow 优先，auth/billing 快速失败）
  tools/*                        真实工具引擎 + 四档审批 + 敏感路径写保护 + 大输出落盘
  memory/                        记忆卡 store / 事件账本 / 任务状态 / 轨迹写集 / embed v0
  model/openai-compatible.ts     chat()/streamChatMessages() 双通道 + usage 解析 + withRetry
  cli/repl/*                     REPL、会话资产(rollout jsonl/branch/compact)、PromptBuilder 三段拆分
  server/*                       SSE 服务化（前端/远程演示）
docs/panshalach/                 命题交付文档（本目录）
archive/                         已摘除装置与过程文档归档
```

## 安装与部署

```bash
cd <repo>
npm install        # devDependencies（tsx/typescript）
npm run build      # → dist/
npm link           # 全局部署：生成 zhulong / panshalach bin（旧别名 zorge 保留）
```

- **bin**：`zhulong`（对外主名）/ `panshalach` / `zorge`（兼容别名），均指向 `dist/cli.js`。
- **配置两级加载**：用户级 `~/.panshalach/config.json` 为基底 → 项目级 `.panshalach.json` 深合并覆盖（项目级优先）。
- **模型选择优先级**：`PANSHA_MODEL` env > 配置 `model` 字段（modelSeed 播种）> `/model` 切换。
- **审批档位**：`--approval <readonly|default|full>`（或 `PANSHA_APPROVAL` env）；非 TTY 管道审批自动拒绝（不挂起）。

## 长程能力速览

- **记忆卡（结构化记忆）**：失败教训 / 成功经验 / 用户偏好；类别分档可见性 + 参照文件过滤 + 四段阶梯衰减 + 验证保鲜 + 同主题合并 + 容量控制（`/memory`）。
- **会话资产**：追加式 rollout jsonl（turn/approval/rewind + 业务事件/压缩标记/注入审计）+ `--resume`/`--branch`/`/tree` 续接与分支。
- **上下文压缩**：模型摘要旧轮 + 保留最近 6 轮 + 血统账本（generation/coveredTurnIds 防覆盖期丢轮）+ 压缩补漏提炼成功卡 + overflow 强制压缩。
- **任务状态跟踪**：TaskState（原始需求锚/决策/未决/进度）+ `/feature` 单特性视图。
- **注入工程**：stable/volatile 三段（前缀缓存友好）/ L0 硬约束 / L1 记忆注入(分档 3/6/8/10 + token 预算) / 逐任务注入审计（injectedCardIds + promptHash）。
- **执行纪律**：Read-Before-Write、Verify-Before-Claim、可回滚、审批分级、卡死硬闸、敏感路径写保护。
- **意图分流**：chat 单次直答（不进循环、通用画像有问必答）/ search 受限只读（≤3 步、搜不到询问用户）/ task 完整验证循环。

> 内部兼容名说明：`.panshalach.json`、`.panshalach-memory.json`、`~/.panshalach/`、`PANSHA_*`、`PanshalachChaser` 均为内部存储/兼容名，对外品牌为**烛龙 Zhulong**；P6 存储名迁移收口见 [ROADMAP-NEXT.md](ROADMAP-NEXT.md) §C。
