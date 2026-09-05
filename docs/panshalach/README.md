# Panshalach — 基于 openPangu 的记忆增强长程上下文智能体

> **命题**：基于 openPangu-1B/7B/7B-VL 构建具备长程上下文管理能力的智能体（华为 · 国产操作系统软件组）。
> **场景主线**：软件工程长期维护——跨多轮需求演进、跨文件/长文档关联分析、持续任务状态跟踪。
> **一句话**：把"每轮都从零记"的 Agent，变成"有卡片记忆 + 会话资产 + 事件/状态持续跟踪"的长程智能体，基于 openPangu 推理验证。
> **当前版本 v0.7.0**（终止语义重构：判官摘除 + 意图分类 + AbortSignal 贯穿）· 外部产品 **烛龙 Zhulong** / 内部代号 **盤沙拉克 Panshalach**。

## 0.7.0 架构速览

- **单层终止**：外置验证判官（continuationJudge）与 TestTimeOrchestrator 已摘除归档（`archive/2026-09-05-removals/`）——chaser 单次 `loop.run`，回合上界 = 单次 `maxSteps`，无续跑×N。
- **回合三态**：`completed`（真实验证 PASS，喂记忆成功卡）/ `answered`（end_turn 有面向用户正文，计入成功并呈现正文，**不**进记忆成功卡）/ `no-verification`（空白空转，失败）；另有 max-steps / consecutive-failures / aborted。
- **意图分类**（`src/cli/taskIntent.ts`）：`chat` 单次 complete 直答（不进循环、不灌格式教学与工具 schema）/ `search` 受限只读循环（≤3 步、禁写禁 bash、搜不到询问用户）/ `task`（execution）完整验证循环 / `meta`；`PANSHA_INTENT_GATE=0` 逃生门。
- **AbortSignal 贯穿**：`runAgentTask → solveIssue → loop → 模型请求（fetch/streamChat）→ engineAdapter/executor`——Ctrl+C 真正中止任务（回合记 `aborted`），UI 不再"提前返回但网关继续刷 POST"。
- **预算真实累计**：`estimatedUsedTokens` 按每次模型调用累加（修复 `[最终预算 0%]` 恒 0）。

> 0.7 方案与遗留边界全文见 [FIX-0.7-TERMINATION.md](FIX-0.7-TERMINATION.md)；路线见 [ROADMAP-NEXT.md](ROADMAP-NEXT.md)。

## 文档导航

| 文档 | 内容 | 用途 |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 系统分层架构、记忆模块设计、推理流程、资源消耗、核心创新点 | **命题提交物 (1) 架构设计文档**（雏形） |
| [MEMORY-DESIGN.md](MEMORY-DESIGN.md) | 记忆增强层深挖：卡片 schema、提炼/过滤/衰减/注入、差距与补齐路线 | 记忆子系统设计说明 |
| [EVALUATION.md](EVALUATION.md) | 场景设定、评测方法、基线对比指标、openPangu 运行步骤与数据表 | **命题提交物 (2) 效果评估报告**（骨架，待真实数据） |
| [USER-GUIDE.md](USER-GUIDE.md) | 安装、配置 openPangu、命令总表、档位/审批/记忆命令 | 用户手册 |
| [ROADMAP.md](ROADMAP.md) | 从"评估基线"到"完整命题交付"的里程碑 | 执行计划 |
| [ROADMAP-NEXT.md](ROADMAP-NEXT.md) | U1-U9 时间盒内的 R0-R9 剩余路线 + 实施合同 + 遗留表 | 当前执行路线 |
| [FIX-0.7-TERMINATION.md](FIX-0.7-TERMINATION.md) | 0.7.0 终止语义重构方案（根因 R1-R7 / 三态 / 意图 / AbortSignal） | 0.7 设计依据 |
| [REFACTOR-ASSESSMENT.md](../../REFACTOR-ASSESSMENT.md) | 现有工程代码逐模块对照命题的改造路径评估 | 重构依据 |

## 目录（仓库根）

```
src/
  PanshalachChaser.ts            核心执行引擎（solveIssue 单次 loop.run + 意图路由，0.7）
  cli/taskIntent.ts              入口意图分类：chat / search / task / meta（0.7）
  loop/VerifyCritiqueLoop.ts     执行循环（三路解析、Read-Before-Write、Verify-Before-Claim 铁律、回合三态）
  loop/trajectory.ts             轨迹类型（0.7 自 TestTimeOrchestrator 迁出；continueCount 已删）
  tools/*                        真实工具引擎：read_file/write_file/edit_file/bash/glob/grep + 四档审批
  memory/*                       记忆卡提炼/过滤/衰减/合并（持久化）
  cli/repl/*                     交互式 REPL、会话资产(rollout jsonl/branch/compact)、提示组装、ConfigManager/modelSeed
  archive/2026-09-05-removals/   已摘除装置归档（判官/TestTimeOrchestrator/打分器/锚点注入…）
  server/*                       SSE 服务化（前端/远程演示）
docs/panshalach/                 命题交付文档（本目录）
REFACTOR-ASSESSMENT.md           重构评估报告
```

## 安装与部署（0.6.5 起）

```bash
cd <repo>
npm install        # devDependencies（tsx/typescript）
npm run build      # → dist/
npm link           # 全局部署：生成 zhulong / panshalach bin（旧别名 zorge 保留）
```

- **bin**：`zhulong`（对外主名）/ `panshalach` / `zorge`（兼容别名），均指向 `dist/cli.js`。
- **配置两级加载**：用户级 `~/.panshalach/config.json` 为基底 → 项目级 `.panshalach.json` 深合并覆盖（项目级优先）；用户级目录可用 `PANSHA_USER_CONFIG_DIR` 重定向。
- **模型选择优先级**：`PANSHA_MODEL` env > 配置文件 `model` 字段（0.6.5 modelSeed 播种——此前配置 model 从未生效）> `/model` 显式切换。
- **审批档位**：`--approval <readonly|default|full>`（或 `PANSHA_APPROVAL` env）——headless/一次性执行不再锁死 readonly。

## 长程能力速览

- **记忆卡（结构化记忆）**：失败教训 / 成功经验 / 用户偏好三类卡，含类别分档可见性、参照文件过滤、四段阶梯衰减、同主题合并、容量控制。
- **会话资产（事件日志形态）**：追加式 jsonl（turn/approval/rewind + 业务事件/压缩标记/注入审计）、`--resume`/`--branch` 续接、崩溃容错。
- **上下文压缩**：模型摘要旧轮次 + 保留最近 6 轮；压缩时补漏提炼成功卡（0.7 起信号收紧为 `stopReason==='completed'`，纯问答不产成功卡）。
- **任务状态跟踪**：`feature_list.json` 单一 active feature + 下一步 + 证据（演进为多轮任务状态机）。
- **意图分类（0.7）**：chat 单次直答 / search 受限只读（≤3 步、搜不到询问用户）/ task 完整验证循环——问答不再被灌工具 schema 空转。
- **真中止（0.7）**：AbortSignal 贯穿 solveIssue→loop→模型请求/工具执行，Ctrl+C 即停（回合记 `aborted`）。
- **注入工程**：L0 硬约束(≤3) / L1 记忆卡(按档位 3/6/8/10) / 分档契约 / 注入去重 / token 预算 / 参照文件过滤。
- **执行纪律**：读前必读、验证后声明、可回滚、审批分级——支撑长周期持续执行的可靠性。

> 内部兼容名说明：`.panshalach.json`、`.panshalach-memory.json`、`~/.panshalach/`、`PANSHA_*`、`PanshalachChaser` 均为内部存储/旧兼容名，不影响对外品牌 **Panshalach**；收敛计划见 [ROADMAP.md](ROADMAP.md)。
