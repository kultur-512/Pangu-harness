# ZIS 细节 · 生态（从 docs/ZIS.md 迁移，A-T10）

> skills / MCP / 子代理树 / 相关文档索引。

## P5：生态

### skills（P5-5.1）
- 目录约定：`~/.zorge/skills/<name>/SKILL.md`（用户级）+ `<workspace>/.zorge/skills/<name>/SKILL.md`
  （项目级，同名覆盖用户级）。技能名限 `[a-z0-9-]`（防路径注入）。
- SKILL.md 格式：`---` frontmatter（`name` / `description` / `triggers: [关键词]`）+ 正文。
- 任务匹配：task 含任一 trigger（大小写不敏感）或 description 2 字窗口命中 → 注入
  `【可用技能（任务命中，遵循其指引）】` 块；上限 3 个技能、每个 ≤2000 字符。
- 解析失败/非法名 → 跳过并警告，不崩。

### MCP（P5-5.2）
- 配置：`.zorge.json` 追加 `mcpServers: { "<name>": { command, args, env } }`。
- 手写 JSON-RPC 2.0 over stdio：initialize → initialized → tools/list → tools/call；
  30s 超时（unref + clearTimeout）；通知忽略；stderr 记录。
- 工具注册为 `mcp_<server>_<tool>`（命名空间防冲突），内置工具同名时内置优先；
  走既有 classify（default 确认 / readonly 拒绝 / full 放行；plan 同样拒绝；
  写类工具名启发式 danger）。
- 生命周期：启动时懒加载 + 会话退出 `close()`（防挂起）；server 崩溃 →
  `MCP_SERVER_DOWN` 优雅错误。

### 子代理树（P5-5.3）
- `/agents`：rollout 树形视图（`/agents <id>` 详情），顶部汇总
  `N rollouts · X done · Y running · Z pending · F failed · 总耗时 T`。
- **诚实性**：当前引擎串行执行 rollout（TestTimeOrchestrator for+await），
  /agents 显示 done → running → pending 串行进度，不伪造并行；引擎将来并行化后
  同一 AgentTree 渲染真实树（父-子）。
- 数据源：onEvent 的 step/critique 事件带 rolloutId + stepNumber → upsert；任务边界
  markAll(running→done)。




当前限制（透明告知）：
- 富 UI 的 Markdown 是轻量实现（标题、**粗体**、围栏代码块 + 基础着色），非完整 CommonMark。
- 代码块目前不支持运行时折叠/复制（后续可加）。
- 顶栏预算条由 softLimit/budget 驱动；上下文计量为 chars/4 启发式（名义窗口可用 ZORGE_CTX_WINDOW 覆盖）。
- 思考深度指令为提示层约束，端点是否原生支持 thinking 参数取决于 provider。
- 行模式仍是“结构化文本”，不是卡片；想看卡片需 ink 环境。
- 引擎当前解析工具调用但不真正执行（Phase 2 待做）；部分极端错误路径仍以文本进 Feed。

---

## 相关文档

- 全面介绍：`README.md`（安装/快速开始/命令/架构/FAQ）
- 与 Claude Code 对齐路线图（P0-P5）：`ROADMAP-CLI-PARITY.md`
- 实战检验报告（T1-T7 + 短板 + T7 三路对照）：`DOGFOOD-REPORT.md`
- 历史开发蓝图（30 轮/ink UI 等）：`docs/archive/`（含 ARCHIVE.md 索引）
- 六档体系：`src/tiers/TierConfig.ts`
- 核心引擎：`src/ZorgeChaser.ts`

---

