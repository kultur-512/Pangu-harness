# ZIS 细节 · 会话资产（从 docs/ZIS.md 迁移，A-T10）

> 会话持久化 / 分支 / rewind / compact / resume。

### --resume（M2.2）
- 会话事件追加写入 `~/.zorge/rollouts/<id>.jsonl`（meta/turn/approval，崩溃容忍：坏行跳过）。
- `zorge --resume last`（或 `--resume <id>`）恢复 turns + 审批模式/放行清单，启动横幅显示恢复轮数。

### /compact + auto-compact（M2.3）
- `/compact`：模型摘要替代旧轮次（保留最近 6 轮），模型失败回退确定性要点列表（零信息丢失）。
- 触发前估算 tokens，压缩后 TopBar 计量重置；估算公式 = chars/4 + 4k 基线。
- auto-compact：估算 ≥85% 且 >12 轮时，下一任务开始前自动压缩；TopBar 在 70% 后切换为
  `⏳ N% until auto-compact` 倒计时（85% 变红）。

### --headless 逃生口
- 默认：非 TTY 或 ZORGE_SMOKE=1 → 引擎 mock，零真实执行（安全红线，不变）。
- `ZORGE_HEADLESS=1` 或 `zorge --headless`：显式开启无头真实执行
  （CI/批量/dogfooding 场景）。必须显式设置，永不默认开启。
- 优先级：ZORGE_SMOKE=1 > ZORGE_HEADLESS=1 > isTTY 检测（SMOKE 最高优先，
  防止 CI 误开 HEADLESS 导致真实执行）。
- 一次性模式：`zorge --headless run "任务文本"`（真实执行 + 只读审批默认，
  写类/bash 仍需审批通道）。

### /usage（M2.4）
- 本地核算：累计 tokens（预算报告汇总）、当前上下文估算、最近一轮 estimatedUsedTokens/usageRatio、
  累计时长。成本 = 70/30 输入输出近似 × `.zorge.json` 可选 `usagePrices` 单价（不读取 apiKey）。

---

## P3 剩余：分支 / rewind / 后台压缩

### 会话分支（P3-3.5）
- `zorge --branch <name>`：从最近会话（或 `--resume <id>` 指定的会话）只读 fork 出
  `<origin>--branch-<name>`——原 jsonl 永不被修改，分支 = 原事件原样重放 + 分支指针。
- 分支可再分支；`isBranch` 解析到最顶 origin；`/resume` 列出会话与分支（`[branch of <origin>]` 标记）
  并提示切换命令；分支内 `/status` 显示 `branch of <originId>`。
- 对齐 CC "You are now in the new branch… Use /resume to return to the original"。

### /rewind（P3-3.6）
- 回合级回放：`/rewind` 列出最近 5 个回合计（turnLabel + 文件数 + checkpoint 数）；
  `/rewind <N|last>` 预览 diff 汇总 + `y/n` 确认；`--dry-run` 零副作用预览。
- 语义：恢复到目标回合**结束态**（该回合及之前所有 checkpoint 的 before 版本）；
  create 回退=删除文件；bash 副作用天然排除（file-history 只跟踪 write/edit）。
- 每次恢复都是"检查点优先"（可逆）；恢复后写 rollout `rewind` 审计事件；`/undo` 单条语义不变。

### 后台预压缩（P3-3.7）
- 阈值（≥85% 上下文 且 >12 轮）触发时：**先后台并发计算摘要**（不阻塞输入、不改 session.turns），
  任务边界处如果已就绪则零等待应用 `✓ 已自动压缩 N 轮历史(后台)`。
- 防重入：同一会话同时只有一个压缩在跑；`cancel()` 会话退出时清理。
- 模型失败 → 确定性摘要兜底（永不丢信息、永不阻塞）；>95% 临界仍走同步兜底。

---

## 会话与持久化

- 每个 turn 结束后自动保存
- 位置：`~/.zorge/sessions/<uuid>.json`
- 命令：
  - `/session save [name]`
  - `/session load <name|id>`
  - `/session list`（或 `/sessions`）
- 启动时可通过 `/load` 恢复历史上下文

**注意**：在受限沙箱环境首次保存可能遇到权限问题，REPL 已做延迟目录创建 + 容错处理。

---

