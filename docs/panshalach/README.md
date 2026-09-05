# Panshalach — 基于 openPangu 的记忆增强长程上下文智能体

> **命题**：基于 openPangu-1B/7B/7B-VL 构建具备长程上下文管理能力的智能体（华为 · 国产操作系统软件组）。
> **场景主线**：软件工程长期维护——跨多轮需求演进、跨文件/长文档关联分析、持续任务状态跟踪。
> **一句话**：把"每轮都从零记"的 Agent，变成"有卡片记忆 + 会话资产 + 事件/状态持续跟踪"的长程智能体，基于 openPangu 推理验证。

## 文档导航

| 文档 | 内容 | 用途 |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 系统分层架构、记忆模块设计、推理流程、资源消耗、核心创新点 | **命题提交物 (1) 架构设计文档**（雏形） |
| [MEMORY-DESIGN.md](MEMORY-DESIGN.md) | 记忆增强层深挖：卡片 schema、提炼/过滤/衰减/注入、差距与补齐路线 | 记忆子系统设计说明 |
| [EVALUATION.md](EVALUATION.md) | 场景设定、评测方法、基线对比指标、openPangu 运行步骤与数据表 | **命题提交物 (2) 效果评估报告**（骨架，待真实数据） |
| [USER-GUIDE.md](USER-GUIDE.md) | 安装、配置 openPangu、命令总表、档位/审批/记忆命令 | 用户手册 |
| [ROADMAP.md](ROADMAP.md) | 从"评估基线"到"完整命题交付"的里程碑 | 执行计划 |
| [REFACTOR-ASSESSMENT.md](../../REFACTOR-ASSESSMENT.md) | 现有工程代码逐模块对照命题的改造路径评估 | 重构依据 |

## 目录（仓库根）

```
src/
  PanshalachChaser.ts            核心执行引擎（类名=内部兼容名，后续里程碑更名 Panshalach）
  loop/VerifyCritiqueLoop   执行循环（三路解析、Read-Before-Write、Verify-Before-Claim 铁律）
  tools/*                   真实工具引擎：read_file/write_file/edit_file/bash/glob/grep + 四档审批
  memory/*                  记忆卡提炼/过滤/衰减/合并（持久化）
  cli/repl/*                交互式 REPL、会话资产(rollout jsonl/branch/compact)、提示组装
  orchestration/*           单 rollout 编排与轨迹记录
  server/*                  SSE 服务化（前端/远程演示）
docs/panshalach/            命题交付文档（本目录）
REFACTOR-ASSESSMENT.md      重构评估报告
```

## 长程能力速览

- **记忆卡（结构化记忆）**：失败教训 / 成功经验 / 用户偏好三类卡，含类别分档可见性、参照文件过滤、四段阶梯衰减、同主题合并、容量控制。
- **会话资产（事件日志形态）**：追加式 jsonl（turn/approval/rewind + 业务事件/压缩标记/注入审计）、`--resume`/`--branch` 续接、崩溃容错。
- **上下文压缩**：模型摘要旧轮次 + 保留最近 6 轮；压缩时补漏提炼成功卡。
- **任务状态跟踪**：`feature_list.json` 单一 active feature + 下一步 + 证据（演进为多轮任务状态机）。
- **注入工程**：L0 硬约束(≤3) / L1 记忆卡(按档位 3/6/8/10) / 分档契约 / 注入去重 / token 预算 / 参照文件过滤。
- **执行纪律**：读前必读、验证后声明、可回滚、审批分级——支撑长周期持续执行的可靠性。

> 内部兼容名说明：`.panshalach.json`、`.panshalach-memory.json`、`~/.panshalach/`、`PANSHA_*`、`PanshalachChaser` 均为内部存储/旧兼容名，不影响对外品牌 **Panshalach**；收敛计划见 [ROADMAP.md](ROADMAP.md)。
