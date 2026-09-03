# Zorge SSE 前端流式传输（已实现）

## 目标
让前端（浏览器 / 其他客户端）可以通过 **Server-Sent Events (SSE)** 实时接收 Zorge Agent 的执行过程（step、critique、tool、budget、phase 等），实现类似 Claude Code / Cursor 的流式体验。

## 已交付内容

### 核心模块
- `src/server/sse.ts`  
  纯 Node 实现的 SSE 连接封装（心跳、自动关闭、事件发送）。

- `src/server/agentServer.ts`  
  轻量 HTTP + SSE 服务器：
  - `POST /api/run`：提交任务，返回 SSE 流
  - `GET /health`：健康检查
  - 内部复用 `PromptBuilder + ZorgeChaser + onStep`，把所有事件转成 SSE。

- `src/cli/repl/commands/ServeCommand.ts`  
  新命令 `serve`，在 REPL 里一键启动 SSE 服务器。

### 前端演示
- `examples/frontend-sse-demo.html`  
  独立单文件前端（无需构建），支持：
  - 输入任务、选择 tier、工作区
  - 实时 Feed（step / critique / tool 卡片 / budget）
  - 状态、得分、耗时展示
  - 中断按钮
  - 事件日志

### 集成点
- `Repl.ts` 已注册 `ServeCommand`
- 完全**可选**，不影响原有 CLI / Ink 模式 / smoke 测试
- 与 `onStep` 事件体系打通（phase/step/critique/tool/softLimit/result 等）

## 使用方法

### 1. 启动 SSE 服务器

方式 A（推荐，在交互式 REPL 里启动）：
```bash
npx zorge
# 进入后输入
serve
# 或指定端口
serve --port 4000
```

方式 B（直接启动）：
```bash
node dist/cli.js serve --port 3456
```

服务器默认监听 `http://127.0.0.1:3456`

### 2. 前端调用

打开 `examples/frontend-sse-demo.html`（直接用浏览器打开即可）。

或用 curl / fetch 直接调用：

```bash
curl -N -X POST http://127.0.0.1:3456/api/run \
  -H "Content-Type: application/json" \
  -d '{
    "task": "写一个加法函数并加上单元测试",
    "tier": "high",
    "workspace": "."
  }'
```

SSE 事件格式示例：
```
event: start
data: {"runId":"run_xxx","task":"..."}

event: phase
data: {"phase":"explore"}

event: step
data: {"stepNumber":1,"thinking":"...","toolCalls":[...]}

event: tool
data: {"tool":"write_file","target":"src/add.ts","status":"ok"}

event: critique
data: {"critique":"..."}

event: budget
data: {"usedRatio":0.42}

event: done
data: {"success":true,"score":85,"durationMs":12345}
```

## 事件列表（当前转发）

| 事件名       | 说明                        | 典型数据字段                     |
|--------------|-----------------------------|----------------------------------|
| start        | 任务开始                    | runId, task                      |
| phase        | 阶段变化                    | phase (explore/rollout/judge)    |
| step         | 每一步思考/计划/工具调用    | stepNumber, thinking, plan, toolCalls |
| critique     | 验证批评                    | critique                         |
| tool         | 工具执行结果                | tool, target, status, result     |
| budget / softLimit | 预算使用           | usedRatio                        |
| result       | 最终结果                    | success, score, budgetReport     |
| done         | 流结束（成功或失败）        | success, score, durationMs       |
| error        | 错误                        | message                          |

前端 demo 会把 `step/tool/critique/budget` 渲染成漂亮的卡片和着色行。

## 架构说明

- 服务器端完全复用现有执行路径（`ZorgeChaser.solveIssue({ onStep })`）。
- `onStep` 里的所有事件都会被序列化后通过 `sse.send(type, data)` 推给前端。
- 与 Ink UI **零耦合**：SSE 是独立的服务层。
- 不修改核心引擎，不影响 CLI 行模式和 Ink 模式。

## 当前限制 / 注意事项

1. 需要模型客户端可用（和 CLI 一样）。如果没配置模型，`/api/run` 会返回错误事件。
2. 目前是单任务串行（一个连接一个 run）。如需并发可后续扩展。
3. 前端 demo 是纯静态 HTML，生产环境建议做 token / 鉴权包装。
4. 目前只做了 **POST /api/run** 流式执行，后续可加：
   - `/api/status`
   - 会话列表
   - 历史回放

## 下一步建议（可选）

- 把 SSE 服务做成独立进程（`zorge serve --daemon`）
- 在 `ZIS.md` 里补充 SSE 使用章节
- 增加更细粒度的前端卡片（思考链默认折叠、工具结果展开等）
- 支持前端传 `simulate: true`
- 增加简单鉴权（Bearer Token）

---

**已完成**：前端可以通过 SSE 实时看到 Zorge 的完整思考、工具调用、验证、预算过程。

需要我现在帮你测试一次端到端（启动 serve + 打开 demo 跑一个真实任务），还是继续加其他功能？ 
