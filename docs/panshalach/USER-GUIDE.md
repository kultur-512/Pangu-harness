# Panshalach 使用手册

> Panshalach：基于 openPangu 的记忆增强长程上下文智能体（内部兼容名 zorge，见文末"内部名说明"）。

## 1. 环境要求
- Node ≥ 18（含全局 fetch）；TypeScript 5.6（构建）。
- 零运行时依赖（`dependencies: {}`）；ink/react/chalk 为可选富 UI（非 TTY 自动降级行模式）。
- 推理：openPangu 端点（本机 / 昇腾 vLLM-ascend / MindIE，OpenAI 兼容）。无端点时可配置任意 OpenAI 兼容网关先跑通流程。

## 2. 安装与启动
```bash
cd <repo>
npm install            # devDependencies（tsx/typescript）
npm run build          # → dist/
# 全局可用（可选）
npm install -g .       # 提供 panshalach（与旧别名 zorge）两个 bin
```
启动：
```bash
panshalach                          # 交互式 REPL（默认）
panshalach --help                   # 帮助
panshalach run "任务..."            # 单条任务（旧 CLI 兼容）
panshalach --headless run "任务..." # 显式逃逸 isTTY 守卫（真实执行）
```

## 3. 配置 openPangu（本机 / 昇腾）

编辑项目根 `.zorge.json`（内部名，见文末）：

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
也可用环境变量（通用 provider 路由）：
```bash
export ZORGE_MODEL="openpangu:openPangu-7B"
```
若 openPangu 网关需要 key（如昇腾云/ModelArts）：把 `apiKey` 换成真实 key，或设 `SCNET_API_KEY`（现有 env 注入通道——后续里程碑改为 `PANG_OPENPANGU_API_KEY`，见 ROADMAP）。
启动后在 REPL `/model list`（遍历已配置 provider 拉模型）→ `/model openpangu:openPangu-7B` 切换。

> 适配说明：模型协议三路自适应（OpenAI JSON tool_calls · 文本协议 · `<>` 严格）由探测器自动判断；openPangu 输出 JSON 工具调用/文本格式均可容错。

## 4. 命令总表（REPL 内 `/` 前缀）

| 命令 | 作用 |
|---|---|
| `/tier <t>` | 六档强度 quick/standard/high/max/ex/zorge（默认 high） |
| `/model list | <name>` | 拉模型/切换模型 |
| `/approvals <mode>` | 审批 readonly/default/full |
| `/undo` `/rewind` | 撤销最近写盘 / 按回合回放 |
| `/compact` | 压缩会话历史（保留最近 6 轮 + 摘要） |
| `/resume` `/tree` | 会话续接 / 会话树（branch） |
| `/memory` | 记忆管理（见下） |
| `/feature list|add|done` | 当前特性跟踪（任务状态） |
| `/run "任务"` `r 任务` | 执行任务；`s 任务` simulate |
| `/review` `/trace` `/usage` `/status` `/config` `/init` `/session` `/history` `/workspace` `/agents` `/serve` `/exit` | 其余命令 |

## 5. 档位速查（强度 = 验证密度 + 记忆注入 + 预算）

| tier | 用途 | rollout×步 | 记忆加载 | 并行 | 审批 |
|---|---|---|---|---|---|
| quick | 热修复 | 1×10 | 无 | 1 | readonly |
| standard | 常规修改 | 1×15 | 3 | 1 | default |
| high（默认） | 日常主力 | 2×20 | 6 | 2 | 默认 |
| max / ex / zorge | 重要/极难/终极 | 3-5×(25-40) | 8-10 | 2-4 | 写需确认/全确认 |

## 6. 记忆命令（长程记忆入口）

```
/memory list [--kind failure|success|preference]   列出记忆卡
/memory remember [--pin] <内容>                     记住偏好（--pin 冻结衰减）
/memory forget <id>                                 删除卡
/memory merge                                       同主题自动合并（原卡归档）
/memory search <词>                                 关键词检索
/memory export [file] / import <file> [--merge false]   导出/导入
```
记忆卡存于 `<workspace>/.zorge-memory.json`（内部名），自动加入 `.gitignore`。

## 7. 长程使用姿势
1. 开场用 `/init` 生成项目指令页 `.zorge/AGENTS.md`（验证命令 + 不变量），agent 每轮能读到"如何验证"。
2. 关键约束用 `/memory remember` 或让回合写闭环（P2 里程碑后自动提炼）沉淀。
3. 长任务用 `/feature add "…"` 跟踪单一进度；每轮结束 `/feature done <id> <证据>`。
4. 会话长了自动/手动 `/compact`；跨进程用 `/resume` 续接。
5. 远程/前端演示：`/serve --port 3456`（SSE，Bearer token 或 localhost-only）。

## 8. 内部名说明（品牌迁移中）
Panshalach 为对外品牌。当前内部仍使用历史名保证既有会话/记忆/脚本兼容：
`.zorge.json` / `.zorge-memory.json` / `~/.zorge/` / `ZORGE_*` 环境变量 / `ZorgeChaser` 类 / `zorge` bin（保留别名）。
收敛到 Panshalach 名的迁移计划见 [ROADMAP.md](ROADMAP.md) P6。
