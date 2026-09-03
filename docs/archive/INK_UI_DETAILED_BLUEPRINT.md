# Zorge Ink UI 细化施工蓝图（Path B）

**版本**：v1.1（底栏优先 + 本期包含 Markdown/代码块渲染）  
**核心决策**：引入 ink@5 + react@18  
**纪律红线**：任何环境必须能 100% 静默回退到现有行模式 REPL

---

## 1. 依赖取舍审查意见

**审查结论**：接受打破 `dependencies: {}`，但必须用 **optionalDependencies + 运行时降级** 严格延续等价纪律。

**已执行**（package.json）：
```json
"optionalDependencies": {
  "chalk": "^5.3.0",
  "ora": "^8.0.1",
  "prompts": "^2.4.2",
  "ink": "^5.0.0",
  "react": "^18.3.0"
}
```

**强制规则**（必须代码化并作为门禁）：
1. 永远不在模块顶层静态 import ink / react。
2. 只允许在 `src/cli/repl/ui/startInkUI.ts` 中进行动态 `await import('ink')` + `await import('react')`。
3. 任意一步失败，或 TTY/caps 检查不通过 → **必须静默返回 null**，不得输出任何警告或提示。
4. 行模式路径（smoke 测试）必须完全不受影响。
5. ink 带来的传递依赖（react-reconciler、yoga-layout 等）约 10-12 个包，体积增加 ~2-4MB 可接受。

**为什么接受**：
- 换取真正的 Claude Code 级底栏 + 卡片流 + 结构化渲染，价值明显。
- 用 optional + 运行时检测把“破坏”控制在最小范围内。

**红线**：如果 ink 不可用，用户体验必须和今天完全一样。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        ZorgeApp (根)                         │
│  ┌──────────────┐  ┌────────────────────────────────────┐  │
│  │   TopBar     │  │              Feed (滚动区)          │  │
│  │ tier·model·ws│  │  Text | Step | Critique | ToolCard  │  │
│  │ + budget bar │  │  Thought | Markdown | Budget        │  │
│  └──────────────┘  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐│
│  │                    InputBar (底栏)                      ││
│  │  + ConfirmBar（条件覆盖）                                 ││
│  └────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

**数据流**：
- Engine（ZorgeChaser / Loop / RunCommand）只通过 `onStep` + 结果 + budget 事件。
- 事件 → `UiBridge.pushFeed / setTop / setConfirm`。
- `UiBridge` 驱动 React reducer（单一 `UiState`）。
- 输入完全由 `InputBar` 接管 → `bridge.submitInput()` → 复用现有命令/任务执行路径。

**核心原则**：
- 核心逻辑零感知 ink。
- ink 模式下不创建 readline。
- OutputRenderer 保持双轨（stdout + 可选 feed sink）。

---

## 3. 状态模型（UiState）

```ts
export type FeedItem = ...;   // 见 types.ts 已添加

export interface UiState {
  top: { tier: string; model: string; workspace: string; budgetRatio: number };
  feed: FeedItem[];
  input: { value: string; history: string[]; multiline: boolean };
  confirm?: { message: string; onResolve: (yes: boolean) => void };
  running: boolean;
}
```

---

## 4. 文件规划与职责

```
src/cli/repl/ui/
├── startInkUI.ts          // 降级门神（最重要）
├── bridge.ts              // UiBridge 实现 + 事件适配
├── ZorgeApp.tsx           // 根 + 布局 + useReducer
├── TopBar.tsx             // 状态栏（档位着色 + 模型 + 工作区 + 消耗条）
├── Feed.tsx               // 滚动列表 + 自动滚尾 + 窗口化
├── FeedItem.tsx           // 条目分发器
├── ToolCard.tsx           // 工具卡片（icon + 摘要 + 折叠结果）
├── ThoughtBlock.tsx       // 💭 折叠思考
├── InputBar.tsx           // 底栏输入（多行 + 历史 + 提交）
├── ConfirmBar.tsx         // y/N 内联确认
├── Markdown.tsx           // 轻量解析（#、```、**）
└── types.ts               // UI 局部类型
```

**现有文件改造清单**（最小改动）：
- `Repl.ts`：启动时先尝试 ink
- `OutputRenderer.ts`：增加 `setFeedSink`
- `InputReader.ts`：ink 模式下不实例化
- `types.ts`：已添加 UI 契约
- `RunCommand.ts` + `Repl.executeTask`：onStep 转发

---

## 5. 关键集成代码要点

### Repl.ts（启动控制）
```ts
async start() {
  const ink = await tryStartInkUI(this.session, this.renderer, this);
  if (ink?.started) return;           // ink 接管
  // 保留原有 while (this.running) 行模式循环
}
```

### OutputRenderer（双轨）
```ts
private feedSink?: (item: any) => void;
setFeedSink(sink?: (item: any) => void) { this.feedSink = sink; }

// 在 writeLine / info / warn / success / error / stream 中：
if (this.feedSink) this.feedSink({ type: 'text', text: ... });
```

### startInkUI.ts（核心降级逻辑）
```ts
export async function tryStartInkUI(...): Promise<InkStartResult> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return { started: false };
  const caps = getTerminalCapabilities();
  if (!caps.multiline) return { started: false };

  let ink: any, React: any;
  try {
    ink = (await import('ink')).default ?? await import('ink');
    React = (await import('react')).default ?? await import('react');
  } catch {
    return { started: false };   // 静默
  }

  // 渲染 ZorgeApp + 传入 bridge
  const { render } = ink;
  // ... 创建 bridge，渲染
  return { started: true };
}
```

---

## 6. 分阶段施工计划（U1–U6）

每阶段必须通过三道门禁：
- `npm run build`
- `verify-zorge-cleanup`
- `test-repl-smoke`（非 TTY）

**U1（基础 + 降级）**
- startInkUI.ts（动态导入 + 检查）
- bridge.ts 骨架
- ZorgeApp + TopBar + Feed + InputBar 空布局
- Repl 早期尝试
- OutputRenderer 加 setFeedSink

**U2（顶栏 + 底栏可用）**
- TopBar 真实数据
- InputBar 支持输入、提交、历史
- 命令与任务可从底栏执行

**U3（流式 Feed）**
- onStep 完整桥接
- Feed 渲染 step/critique/phase
- Ctrl+C 中断后立即恢复输入

**U4（卡片 + 确认）**
- ToolCard（图标 + 摘要 + 折叠）
- ThoughtBlock
- ConfirmBar + 高档位写操作集成

**U5（Markdown + 预算）**
- Markdown.tsx（#、```、**）
- TopBar 消耗条响应 softLimit

**U6（打磨回归）**
- resize、历史完善
- 16 命令双模式验证
- 最终门禁 + 文档

---

## 7. 风险与应对

- ink 安装失败 → optional + 静默降级（已要求强制）
- 更新风暴 → 16ms 批处理 + 只渲染尾部
- 布局错乱 → useStdout 监听 + 动态高度
- 确认与输入冲突 → ConfirmBar 独占 + 暂停普通输入
- smoke 回归 → smoke 永在非 TTY

---

## 8. 立即行动清单

1. `src/cli/repl/ui/` 目录已可创建。
2. types.ts UI 契约已添加（完成）。
3. 优先实现 `startInkUI.ts`（降级门神）。
4. 实现 bridge + 骨架组件。
5. 接入 Repl + OutputRenderer。
6. 每阶段跑门禁。

---

**一句话总结**：

我们用 optionalDependencies + 强制静默降级，安全引入 ink 获得 Claude Code 级底栏体验，同时把“任何环境都能用”的纪律完整保留；核心零耦合，U1 先立降级门神和空布局，后续逐层增强，每阶段保 smoke 全绿。

需要我现在开始实现 **U1**（startInkUI.ts + bridge + 骨架组件）吗？
