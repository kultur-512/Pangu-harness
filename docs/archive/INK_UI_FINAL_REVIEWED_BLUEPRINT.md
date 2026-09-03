# Zorge Ink UI 细化施工蓝图（Path B 正式版）

**决策**：路径 B（引入 ink@5 + react@18）  
**本期范围**：底栏常驻 + 流式 Feed + ToolCard + Thought + Confirm + 轻量 Markdown/代码块  
**纪律红线**：任何环境必须能 100% 静默回退到现有行模式 REPL（非 TTY / ink 不可用时零感知）

---

## 1. 依赖取舍审查意见（审查员+策划）

**结论**：可以接受打破 `dependencies: {}`，但必须用 **optionalDependencies + 运行时强制静默降级** 来延续等价纪律。

**已修改 package.json**：
```json
"optionalDependencies": {
  "chalk": "^5.3.0",
  "ora": "^8.0.1",
  "prompts": "^2.4.2",
  "ink": "^5.0.0",
  "react": "^18.3.0"
}
```

**审查要点与强制要求**：

1. **安装失败不阻断**  
   `npm install` 因沙箱、权限、镜像等问题跳过 ink/react 是允许的，不能让安装整体失败。

2. **运行时必须静默降级**  
   唯一允许 `import('ink')` 和 `import('react')` 的地方是 `src/cli/repl/ui/startInkUI.ts`，必须使用动态 import + try/catch。
   - 任何失败（模块不存在、解析失败、版本不兼容等）→ **立即静默返回 `{ started: false }`**，不打印任何日志或警告。

3. **启用条件要严格**  
   建议同时满足：
   - 动态 import 成功
   - `process.stdout.isTTY && process.stdin.isTTY`
   - `getTerminalCapabilities().multiline`（至少 color + keypress 较好）

4. **代价可接受**  
   ink 会引入 react-reconciler、yoga-layout 等约 10-12 个传递依赖，安装体积增加 ~2-4MB。  
   需要在 README 中说明“高级终端 UI 为可选增强”。

5. **红线**  
   如果因为 ink 导致 smoke 测试、CI、旧 Windows cmd、PowerShell ISE 等场景体验变差，视为引入失败。

**一句话审查意见**：
> “我们用 optionalDependencies 换取了 Claude Code 级底栏体验，但必须把‘静默降级’做成强制且可验证的能力。降级路径不是锦上添花，而是及格线。”

---

## 2. 架构总则

**黄金法则**：
- 核心引擎（ZorgeChaser、VerifyCritiqueLoop、RunCommand 等）**永远不 import ui/** 下的任何东西。
- 所有 UI 状态收敛到单一 `UiState`（React useReducer）。
- 通过 `UiBridge` 单向接收引擎事件。
- ink 模式下**不创建** readline，输入完全由 `InputBar` 接管。
- `OutputRenderer` 保持双轨：始终写 stdout，同时可选推 feed sink。

**布局结构**（三区）：
```
TopBar（档位色码 · 模型 · 工作区 · 消耗条）
────────────────────────────────────
Feed（滚动区，支持窗口化 + 自动滚尾）
  - 普通文本
  - Step / Critique
  - ToolCard（可折叠结果）
  - ThoughtBlock（💭 可展开）
  - Markdown / 代码块（本期轻解析）
────────────────────────────────────
InputBar（底栏常驻）
  + ConfirmBar（高档位写操作时覆盖）
```

---

## 3. 核心数据契约（已添加到 types.ts）

```ts
export type FeedItem =
  | { id: string; type: 'text'; text: string; level?: 'info'|'warn'|'error'|'success' }
  | { id: string; type: 'phase'; phase: 'explore'|'rollout'|'judge'|'done' }
  | { id: string; type: 'step'; stepNumber: number; thinking?: string; plan?: string; toolCalls?: any[] }
  | { id: string; type: 'critique'; stepNumber: number; critique: string }
  | { id: string; type: 'tool'; tool: string; target?: string; argsSummary?: string; result?: string; status: 'running'|'ok'|'fail' }
  | { id: string; type: 'thought'; short: string; full?: string }
  | { id: string; type: 'budget'; usedRatio: number }
  | { id: string; type: 'markdown'; content: string };

export interface UiState { ... }
export interface UiBridge { ... }
export interface InkStartResult { started: boolean; }
```

---

## 4. 文件结构与职责

```
src/cli/repl/ui/
├── startInkUI.ts          // ★ 降级门神（U1 最重要）
├── bridge.ts              // UiBridge 实现 + 事件适配
├── ZorgeApp.tsx           // 根 + 三区布局 + useReducer
├── TopBar.tsx
├── Feed.tsx
├── FeedItem.tsx
├── ToolCard.tsx
├── ThoughtBlock.tsx
├── InputBar.tsx
├── ConfirmBar.tsx
├── Markdown.tsx           // 本期：# 标题、``` 代码块、**粗体**（着色）
└── types.ts
```

**现有文件最小改造**：
- `Repl.ts`：启动时先 `await tryStartInkUI(...)`，成功则不进入旧 while 循环。
- `OutputRenderer.ts`：增加 `setFeedSink()`。
- `InputReader.ts`：ink 模式下不实例化。
- `RunCommand.ts` / `Repl.executeTask`：onStep 转发给 bridge。

---

## 5. 分阶段计划（U1–U6）

**每阶段必过三道门禁**：
- `npm run build`
- `verify-zorge-cleanup` → PASS
- `test-repl-smoke` → 全绿（非 TTY 强制走行模式）

| 阶段 | 主题 | 关键交付 | 验收 |
|------|------|----------|------|
| **U1** | 基础 + 降级 | startInkUI.ts、bridge、ZorgeApp 空三区、Repl 早期尝试、OutputRenderer setFeedSink | TTY 看到布局；非 TTY/smoke 完全一致 |
| **U2** | 顶栏 + 底栏 | TopBar 真实数据、InputBar（输入+提交+历史） | 常用命令和任务可从底栏执行 |
| **U3** | 流式 Feed | Feed + onStep 桥接 + 自动滚尾 + Ctrl+C 中断 | run "..." 看到 step/critique 流，可中断 |
| **U4** | 卡片系统 | ToolCard、ThoughtBlock、ConfirmBar | 工具卡片美观，结果可折叠，高档位弹出 y/N |
| **U5** | Markdown + 预算 | Markdown.tsx、TopBar 消耗条联动 | 代码块有基础着色，softLimit 实时更新 |
| **U6** | 打磨回归 | resize、历史、16 命令双模式验证 | 所有门禁 + 文档 |

---

## 6. 风险与缓解

- ink 安装失败 → optionalDependencies + 运行时静默降级（强制，已要求）
- 高频更新卡顿 → 16ms 批处理 + 只渲染尾部窗口
- 布局/resize 问题 → useStdout 监听 + Feed 动态高度
- Confirm 与输入冲突 → ConfirmBar 独占 + 暂停普通输入
- smoke 回归 → smoke 永在非 TTY；U1 必须验证降级路径

---

## 7. 立即行动清单（推荐顺序）

1. 创建 `src/cli/repl/ui/` 目录（已部分完成）。
2. `types.ts` UI 契约（已添加部分）。
3. 实现 `startInkUI.ts`（降级门神，当前最优先）。
4. 实现 `bridge.ts`。
5. 实现骨架 `ZorgeApp.tsx` + `TopBar.tsx` + `Feed.tsx` + `InputBar.tsx`。
6. 在 `Repl.ts` 中接入早期尝试。
7. 给 `OutputRenderer` 加 `setFeedSink`。
8. 跑 build + verify + smoke 三道门禁。

---

**一句话总结（审查员+策划）**：

我们用 optionalDependencies + 强制静默降级，安全地引入 ink 换取 Claude Code 级底栏体验，同时把“任何环境都能用”的纪律完整保留。核心零耦合，U1 的核心不是炫酷 UI，而是把降级门神和空布局立起来，确保非 TTY 环境和 smoke 测试零回归。

需要我现在继续完善 U1 代码（细化 startInkUI、bridge、ZorgeApp + TopBar/Feed/InputBar 骨架）并跑门禁吗？
