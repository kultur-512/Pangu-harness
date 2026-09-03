# Zorge

零强依赖的工程 Agent CLI——真实工具执行 + 四档审批 + 会话资产 + 生态接入。

## 特性

- **真实执行**：`read` / `glob` / `grep` / `bash` / `write` / `edit` + LCS diff + RBW 铁律 + 原子写
- **安全审批**：`readonly` / `default` / `full` / `plan` 四档 + 60s 超时 + 会话 allowlist
- **会话资产**：jsonl 追加式 + `--resume` + `--branch` + `/undo` + `/rewind` + 后台预压缩
- **上下文工程**：六档强度（quick→zorge）+ 思维链阶梯 + 记忆卡 + 铁律契约 + 负向工具清单（防格式漂移）
- **输入手感**：排队消息 + 插话 steering + fuzzy 斜杠补全 + 模式环（shift+tab）+ 粘贴检测
- **生态**：skills 目录约定 + MCP stdio client + 子代理树（`/agents`）
- **工程纪律**：零强依赖（`dependencies: {}`）、optionalDependencies 降级、313 用例零失败、干净退出

## 安装

```bash
npm install -g .    # 或 npm link
zorge --version
```

## 快速开始

1. 配置 `.zorge.json`（参考 `.zorge.json.example`，填入模型与 baseUrl）
2. `zorge` → `/tier high` → 输入任务
3. `/model list` → 选模型；`/approvals default` → 写操作确认

## 配置（.zorge.json 字段）

| 字段 | 说明 |
|---|---|
| `model` / `providers` | 模型与多供应商（OpenAI 兼容）配置 |
| `usagePrices` | /usage 成本核算单价（可选） |
| `mcpServers` | MCP stdio server 配置（command/args/env） |
| `repl` / `memory` / `confirmation` | 交互/记忆/审批细分项 |

## 命令总表（与 /help 同款）

```
tier / model / approvals / undo / rewind / compact / usage / resume / agents /
status / memory / review / config / init / history / trace / session / workspace /
clear / help / exit
```

## 模式环

`plan → default → auto-accept → full`（shift+tab 循环；无键位环境用 `/mode` 兜底）。
`plan` 只读输出方案；`default` 写操作确认；`auto-accept`/`full` 写免确认（danger 仍红标）。

## 架构

```
ZorgeChaser(引擎) → VerifyCritiqueLoop(循环) → engineAdapter(工具+审批+护栏)
        → [executor / approval / fileHistory / mcpClient]
PromptBuilder(上下文) ← Session / RolloutStore(会话资产)
交互：sseInteractive / classicRepl（ink 可选，非 TTY 降级行模式）
```

## 实战检验

[docs/DOGFOOD-REPORT.md](docs/DOGFOOD-REPORT.md)——dogfooding T1-T7、8 条短板、
短板 #9 修复（负向工具清单 + 运行时护栏）与 T7 三路对照记录。

## FAQ

- **为什么零依赖？** 可控 + 降级：核心引擎零运行时依赖，UI/颜色类放在 optionalDependencies。
- **非 TTY 会怎样？** 默认 mock（安全红线）；`zorge --headless` 或 `ZORGE_HEADLESS=1` 显式逃生口开启真实执行（`ZORGE_SMOKE=1` 仍最高优先）。
- **密钥安全？** `.zorge.json` 入 gitignore；密钥不进代码（探测脚本密钥已剥离）。
- **与 Claude Code 差异？** 见 [docs/ROADMAP-CLI-PARITY.md](docs/ROADMAP-CLI-PARITY.md)。

## 文档

- [docs/ZIS.md](docs/ZIS.md) — 中文使用手册（含键位总表/模式/生态）
- [docs/ROADMAP-CLI-PARITY.md](docs/ROADMAP-CLI-PARITY.md) — 与 Claude Code 对齐路线图（P0-P5 完成）
- [docs/archive/](docs/archive/) — 历史开发蓝图归档