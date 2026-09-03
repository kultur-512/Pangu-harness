# Zorge Ink UI — 细化施工蓝图 (Path B：底栏优先 + 本期含 Markdown/代码块)

**决策**：采用 ink@5 + react@18 实现真正的 Claude Code 风格底栏 + 富文本流。
**纪律红线**：任何环境下必须能完全静默回退到现有行模式 REPL，零感知降级。

---

## 1. 依赖取舍审查意见

**结论**：接受引入，但必须用 **optionalDependencies + 运行时降级** 延续“环境无关可用”的等价纪律。

**已执行修改**（package.json）：
```json
"optionalDependencies": {
  "chalk": "^5.3.0",
  "ora": "^8.0.1",
  "prompts": "^2.4.2",
  "ink": "^5.0.0",
  "react": "^18.3.0"
}
```

**强制规则**（必须写进代码并门禁）：
1. 永远不在顶层静态 import ink / react。
2. 只在 `src/cli/repl/ui/startInkUI.ts` 里做 `await import('ink')` + `await import('react')`。
3. 任一失败或 TTY/caps 检查不通过 → **静默返回 null**，不打印任何提示。
4. 行模式路径（smoke 测试）必须 100% 保持原有行为。
5. ink 传递依赖（react-reconciler、yoga-layout 等）约 10-12 个包，+2~4MB 可接受。

**代价说明**：打破了严格的 `dependencies: {}`，但用 optional + 运行时回退保住了“任何环境都能用”的精神。

---

## 2. 架构总则

- **核心零感知**：ZorgeChaser、VerifyCritiqueLoop、RunCommand 等永远不 import ui 目录任何东西。
- **单一状态**：`UiState`（用 React useReducer）。
- **单向桥接**：Engine 事件 → `UiBridge` → dispatch → 渲染。
- **输入所有权**：
  - ink 模式：`InputBar` 完全接管（不创建 readline）。
  - 行模式：继续使用现有 `InputReader`。
- **输出双轨**：
  - `OutputRenderer` 始终写 stdout（保证日志/无头场景）。
  - ink 模式下同时把内容通过 sink 推到 feed（`{type:'text'}`）。
- **降级是默认路径**：smoke 测试永远在非 TTY 跑，天然保护行模式。

---

## 3. 核心契约（仅新增）

在 `src/cli/repl/types.ts` 中已添加（仅增不改）：

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

## 4. 文件规划（精确）

```
src/cli/repl/ui/
├── startInkUI.ts          // 降级门神：动态 import + TTY + caps 检查
├── bridge.ts              // UiBridge 实现 + 事件桥接
├── ZorgeApp.tsx           // 根组件（三区布局 + useReducer）
├── TopBar.tsx             // 档位色码 + 模型 + 工作区 + 消耗条
├── Feed.tsx               // 滚动输出区（窗口化渲染）
├── FeedItem.tsx           // 分发器
├── ToolCard.tsx           // 工具卡片（icon + 摘要 + 结果折叠）
├── ThoughtBlock.tsx       // 💭 思考折叠块
├── InputBar.tsx           // 底栏输入（多行 + 历史 + 补全）
├── ConfirmBar.tsx         // 内联确认（y/N）
├── Markdown.tsx           // 轻量 markdown + 代码块着色（本期范围）
└── types.ts               // UI 局部类型（可 re-export 主契约）
```

**需要改造的现有文件**（最小改动）：
- `Repl.ts`：启动时先尝试 `tryStartInkUI`，成功则不进入旧行循环。
- `OutputRenderer.ts`：增加 `setFeedSink`，写操作同时推 sink。
- `InputReader.ts`：ink 模式下不创建 readline（决策在 Repl 上层）。
- `types.ts`：已添加 UI 契约。
- `RunCommand.ts` / `Repl.executeTask`：onStep 回调转发给 bridge。

---

## 5. 交互细节（本期范围）

| 特性         | 实现要点 |
|--------------|----------|
| 底栏常驻     | ZorgeApp 固定 Box 底部，Feed 占据上方可滚动区域 |
| 多行输入     | Enter 提交，Shift+Enter / Ctrl+J 换行（或 ink-text-input） |
| 流式输出     | onStep 事件 → bridge.pushFeed → React 自动渲染 |
| 工具卡片     | ⚙ Bash / 📄 Read / ✏️ Write / 🔍 Grep / 🧪 Test + 参数摘要 + 结果折叠 |
| 结果状态     | ✓ PASS（绿） / ✗ FAIL（红） / … 截断（灰） |
| 思考折叠     | 💭 单行，空格展开全文 |
| 内联确认     | ConfirmBar 覆盖输入区：`确认 Write src/x.ts? [y/N]` |
| Markdown     | # 标题、``` 代码块（基础着色）、**粗体**（本期手写轻解析） |
| 消耗条       | TopBar 实时反映 softLimit 事件 |

---

## 6. 分阶段计划（U1–U6）+ 门禁

**每阶段必过门禁**：
- `npm run build` EXIT 0
- `node verify-zorge-cleanup.mjs` → PASS
- `node scripts/test-repl-smoke.mjs` → 全绿（非 TTY 强制走行模式）

| 阶段 | 目标 | 关键交付 | 验收要点 |
|------|------|----------|----------|
| **U1** | 基础 + 降级 | startInkUI.ts、bridge 骨架、空三区布局、Repl 早期尝试 | TTY 看到布局；非 TTY/smoke 零变化 |
| **U2** | 顶栏 + 底栏 | TopBar（状态）、InputBar（输入+提交+历史） | /help /tier /model + 直接任务可从底栏执行 |
| **U3** | 流式 Feed | Feed + FeedItem + onStep 桥接 + 自动滚尾 | run "..." 能看到 step/critique 流，Ctrl+C 可中断 |
| **U4** | 卡片 + 确认 | ToolCard、ThoughtBlock、ConfirmBar | 工具卡片美观，结果可折叠，高档位写操作弹出 y/N |
| **U5** | Markdown + 预算 | Markdown.tsx + TopBar 消耗条联动 | 代码块着色，softLimit 事件实时更新条 |
| **U6** | 打磨回归 | 全部 16 命令双模式验证、resize、历史、最终门禁 | smoke / verify / tsc 全绿 |

---

## 7. 风险与应对

| 风险 | 应对 |
|------|------|
| ink 安装失败 | optionalDependencies + 运行时静默降级（强制） |
| 高频更新卡顿 | 16ms 批量入队 + 只渲染尾部窗口 |
| resize 布局错乱 | useStdout 监听尺寸，Feed 动态算高度 |
| 输入与确认重叠 | ConfirmBar 独占渲染，期间暂停普通输入 |
| 回退路径被破坏 | ink 模式永不创建 readline；smoke 永在非 TTY |

---

## 8. 立即可执行的下一步

1. 创建 `src/cli/repl/ui/` 目录。
2. `types.ts` 中 UI 契约已添加（完成）。
3. 实现 `startInkUI.ts`（降级门神，最优先）。
4. 实现 `bridge.ts`。
5. 实现骨架 `ZorgeApp.tsx` + `TopBar.tsx` + `Feed.tsx` + `InputBar.tsx`。
6. 在 `Repl.ts` 中接入早期尝试。
7. 给 `OutputRenderer` 加 `setFeedSink`。
8. 跑三道门禁。

---

**一句话总结**：

我们用 optionalDependencies + 强制静默降级，安全地引入 ink 换取 Claude Code 级底栏体验，同时把“任何环境都能用”的纪律等价物完整保留；核心零耦合，U1 先把降级门神和空布局立起来，后续逐层叠加功能，每阶段都保 smoke 全绿。

需要我现在开始写 **U1** 代码（startInkUI.ts + 骨架组件 + Repl 接入点）吗？
