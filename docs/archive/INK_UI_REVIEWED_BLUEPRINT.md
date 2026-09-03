# Zorge Ink UI 细化施工蓝图（Path B）

**决策确认**：路径 B（引入 ink@5 + react@18）  
**本期重点**：先实现底栏常驻 + 流式 Feed + Markdown/代码块渲染  
**纪律红线**：任何环境必须能 100% 静默回退到现有行模式 REPL

---

## 1. 依赖取舍审查意见（审查员视角）

**结论**：可以接受打破 `dependencies: {}`，但必须用 **optionalDependencies + 运行时零感知降级** 来延续纪律。

**推荐方案**（已执行）：
```json
"optionalDependencies": {
  "chalk": "^5.3.0",
  "ora": "^8.0.1",
  "prompts": "^2.4.2",
  "ink": "^5.0.0",
  "react": "^18.3.0"
}
```

**审查要点与要求**：

1. **安装失败必须不阻断**  
   `npm install` 在沙箱、权限问题、国内镜像等场景下跳过 ink/react 是允许的，不能让安装失败。

2. **运行时必须静默降级**  
   唯一允许引入 ink 的地方是 `src/cli/repl/ui/startInkUI.ts`，必须使用动态 import：
   ```ts
   try {
     const ink = await import('ink');
     const React = await import('react');
   } catch {
     return { started: false }; // 绝对静默
   }
   ```
   任何失败（包括 TTY 检查失败）都必须**不打印任何信息**，直接走现有行模式。

3. **启用条件要严格**  
   建议同时满足：
   - 动态 import 成功
   - `process.stdout.isTTY && process.stdin.isTTY`
   - `getTerminalCapabilities().multiline`（或至少 color + keypress 较好）

4. **代价说明**  
   ink 会拉入 react-reconciler、yoga-layout 等约 10-12 个传递依赖，安装体积增加约 2-4MB。  
   在可接受范围内，但必须在 README/CHANGELOG 中说明“桌面交互增强为可选”。

5. **红线**  
   如果因为引入 ink 导致 smoke 测试、CI、旧 Windows 环境、PowerShell ISE 等场景变差，则视为失败。

**总结**：Path B 可以走，但**降级路径是强制项**，不是锦上添花。

---

## 2. 架构设计

### 核心原则
- 引擎（ZorgeChaser、VerifyCritiqueLoop、RunCommand 等）**永远不感知 ink**。
- 所有 UI 状态收敛到单一 `UiState`。
- 通过 `UiBridge` 单向接收引擎事件。
- 输入在 ink 模式下完全由 `InputBar` 接管，不创建 readline。
- `OutputRenderer` 保持双轨输出（stdout + 可选 feed sink）。

### 布局结构
```
┌────────────────────────────────────────────────────┐
│ TopBar（档位·模型·工作区·消耗条）                   │
├────────────────────────────────────────────────────┤
│                                                    │
│ Feed（滚动输出区）                                  │
│  - 普通文本                                        │
│  - Step / Critique                                 │
│  - ToolCard（可折叠）                              │
│  - ThoughtBlock（💭 可展开）                       │
│  - Markdown / 代码块                               │
│                                                    │
├────────────────────────────────────────────────────┤
│ InputBar（底栏常驻） + ConfirmBar（条件覆盖）        │
└────────────────────────────────────────────────────┘
```

### 状态模型（UiState）
```ts
export type FeedItem =
  | { id: string; type: 'text'; text: string; level?: 'info'|'warn'|'error'|'success' }
  | { id: string; type: 'phase'; phase: string }
  | { id: string; type: 'step'; stepNumber: number; thinking?: string; plan?: string; toolCalls?: any[] }
  | { id: string; type: 'critique'; stepNumber: number; critique: string }
  | { id: string; type: 'tool'; tool: string; target?: string; argsSummary?: string; result?: string; status: 'running'|'ok'|'fail' }
  | { id: string; type: 'thought'; short: string; full?: string }
  | { id: string; type: 'budget'; usedRatio: number }
  | { id: string; type: 'markdown'; content: string };

export interface UiState {
  top: { tier: string; model: string; workspace: string; budgetRatio: number };
  feed: FeedItem[];
  input: { value: string; history: string[]; multiline: boolean };
  confirm?: { message: string; onResolve: (yes: boolean) => void };
  running: boolean;
}
```

---

## 3. 文件规划与职责

```
src/cli/repl/ui/
├── startInkUI.ts          // 降级门神（最关键文件）
├── bridge.ts              // UiBridge 实现 + 事件适配
├── ZorgeApp.tsx           // 根布局 + useReducer
├── TopBar.tsx
├── Feed.tsx
├── FeedItem.tsx
├── ToolCard.tsx
├── ThoughtBlock.tsx
├── InputBar.tsx
├── ConfirmBar.tsx
├── Markdown.tsx           // 本期重点：#、```、** 着色
└── types.ts               // UI 局部类型
```

**现有文件最小改造**：
- `Repl.ts`：启动时先尝试 `tryStartInkUI`，成功则不进入旧循环。
- `OutputRenderer.ts`：增加 `setFeedSink`。
- `InputReader.ts`：ink 模式下不创建。
- `types.ts`：添加 FeedItem / UiState / UiBridge（已完成部分）。
- `RunCommand.ts` / `Repl.executeTask`：onStep 转发。

---

## 4. 分阶段计划（U1–U6）

**每阶段门禁**（必须全部通过）：
- `npm run build`
- `node verify-zorge-cleanup.mjs` → PASS
- `node scripts/test-repl-smoke.mjs` → 全绿（非 TTY 强制走行模式）

| 阶段 | 重点 | 关键交付 | 验收标准 |
|------|------|----------|----------|
| **U1** | 基础 + 降级 | startInkUI.ts、bridge 骨架、空三区布局、Repl 早期尝试、OutputRenderer setFeedSink | TTY 看到布局；非 TTY/smoke 完全一致 |
| **U2** | 顶栏 + 底栏 | TopBar 真实数据、InputBar 支持输入+提交+历史 | /help、/tier、/model、直接任务可从底栏执行 |
| **U3** | 流式 Feed | Feed + FeedItem + onStep 完整桥接 + 自动滚尾 | run "..." 能看到 step/critique 流，Ctrl+C 可中断 |
| **U4** | 卡片系统 | ToolCard、ThoughtBlock、ConfirmBar | 工具卡片美观，结果可折叠，高档位写操作弹出 y/N |
| **U5** | Markdown + 预算 | Markdown.tsx（#、```、**）、TopBar 消耗条联动 | 代码块有基础着色，softLimit 事件实时更新条 |
| **U6** | 打磨回归 | resize、历史完善、16 命令双模式验证 | 所有门禁通过 + 文档更新 |

---

## 5. 风险与缓解（策划视角）

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| ink 安装失败 | 高 | optionalDependencies + 运行时静默降级（强制） |
| 高频更新导致卡顿 | 中 | 16ms 批量 + 只渲染最后 N 条 |
| resize 布局错乱 | 中 | useStdout 监听 + Feed 动态计算高度 |
| ConfirmBar 与输入冲突 | 中 | ConfirmBar 独占渲染，期间暂停普通输入 |
| smoke / CI 回归 | 高 | smoke 永在非 TTY；U1 阶段必须验证降级路径 |
| 代码体积与启动速度 | 低 | 仅在 TTY + 能力满足时才加载 |

---

## 6. 立即可执行的下一步（推荐顺序）

1. 创建 `src/cli/repl/ui/` 目录。
2. `types.ts` 中 UI 契约已添加（继续补全 FeedItem 等）。
3. 实现 `startInkUI.ts`（降级门神，U1 核心）。
4. 实现 `bridge.ts`。
5. 实现骨架 `ZorgeApp.tsx` + `TopBar.tsx` + `Feed.tsx` + `InputBar.tsx`。
6. 在 `Repl.ts` 中接入早期尝试。
7. 给 `OutputRenderer` 加 `setFeedSink` 支持。
8. 跑三道门禁（build + verify + smoke）。

---

**一句话总结（审查员+策划）**：

路径 B 可行，但必须把“静默降级”做成强制且可验证的能力。U1 的核心不是炫酷的 UI，而是把降级门神和空布局立起来，确保非 TTY 环境和 smoke 测试完全不受影响。底栏 + 流式 Feed + Markdown 是本期交付重点，按 U1→U6 逐层叠加，每阶段都保三道门禁。

需要我现在开始写 U1 的完整代码（startInkUI.ts + bridge + 骨架组件 + Repl 接入）吗？
