# ZIS 细节 · 架构（从 docs/ZIS.md 迁移，A-T10）

> 原 ZIS 章节按需阅读（L04：give the map, not the manual）。

## 快速开始

```bash
# 进入交互式 REPL（无参数）
npx zorge
# 或全局安装后
zorge

# 交互中执行任务
  ▸ run "修复 add 函数计算错误"
  ▸ r "重构登录模块并加白名单测试"
  ▸ /tier max
  ▸ /status
  ▸ /exit

# 单次命令模式（旧脚本兼容）
zorge simulate --issue "修复支付超时" --workspace . --tier high
zorge run "执行关键命令并验证"
zorge memory list
zorge review --diff "src/foo.ts,src/bar.ts"
zorge help
```

启动后首屏会显示 ZORGE 风格渐变 Banner + 当前档位/工作区提示。

---

## 启动行为（兼容层）

| 命令形式             | 行为                              |
|----------------------|-----------------------------------|
| `zorge`（无参数）    | 启动完整交互式（默认 SSE 传输 + 可能富 UI） |
| `zorge <cmd> ...`    | 以 REPL 单条命令执行后退出（oneShot） |
| `zorge --classic`    | 强制经典行模式 REPL（无 SSE）     |
| `zorge run "..."`    | 直接执行任务（等价 REPL 内 run）  |
| `zorge simulate ...` | 模拟执行（dryRun 模式）           |
| `zorge memory ...`   | 记忆子命令                        |
| `zorge review ...`   | 审查子命令                        |

`src/cli.ts` 仅做委派，实际逻辑在 `src/cli/repl.ts` + `src/cli/repl/Repl.ts` + `src/cli/repl/sseInteractive.ts`。

---

## 实时执行反馈（onStep）

REPL 通过 `ZorgeChaser.solveIssue(..., { onStep })` 接收实时事件：

- `phase`: explore / rollout / judge / done
- `step`: 每步的 thinking / plan / toolCalls / result
- `critique`: 验证批评内容
- `softLimit`: 预算使用比例触发
- `degradation`: 行为降级触发

在 REPL 中会逐行打印关键步骤与 critique，体验类似 Claude Code 的思考过程可视化。

---

## 六档强度体系

| 档位      | 典型场景             | 确认要求     |
|-----------|----------------------|--------------|
| quick     | 热修复、最快         | 无           |
| standard  | 日常标准             | 无           |
| high      | 推荐默认，高强度     | 无           |
| max       | 最大验证量           | 需确认       |
| ex        | 极难任务             | 需确认       |
| zorge     | 极致追求 + 高预算    | 需确认+预算  |

在 REPL 内随时 `/tier <name>` 切换，立即生效于后续任务。

---

## 与旧 CLI 的关系

- 旧 `simulate/run/memory/review/debug-adapter` 仍然可用
- 它们现在走 REPL 的 `runOneShot` 路径
- `ZorgeChaser` 仍是核心执行引擎
- `package.json`:
  - `"main": "dist/ZorgeChaser.js"`
  - `"bin": { "zorge": "dist/cli.js" }`

---

## 构建与开发

```bash
npm run build          # tsc 编译到 dist/
npm run dev            # tsx watch src/cli.ts
node dist/cli.js       # 直接运行编译产物
```

**可选依赖**（推荐安装以获得更好体验）：
```bash
npm install chalk ora prompts
```
未安装时自动降级，功能不受影响。

---

## 当前实现范围（蓝图 v1.1 对照）

已落地：
- 完整 16 命令骨架 + 分类
- REPL 主循环 + prompt + 自然语言路由
- ZorgeChaser onStep 实时回调（phase/step/critique/softLimit/degradation）
- Session + SessionStore（延迟 mkdir，自动持久化）
- OutputRenderer（chalk + ansi fallback）
- CommandRegistry + 基础 Completer / KeyHandler / MultilineBuffer 模块
- 单次命令兼容层
- 构建干净 + verify-zorge-cleanup PASS

部分简化/待增强：
- 完整多行输入（Esc+Enter）与 KeyHandler 在主循环的深度集成
- prompts 库的富交互（目前仅用基础 readline）
- ora 高级 spinner（目前用简化实现）
- PromptBuilder 高级上下文压缩 + 提炼记忆注入（基础版本已就位）
- 自动补全文件路径的真实扫描

这些可在后续迭代按需加强，不影响当前可用性。

---

## 图工程基础（P2-T19，learn-harness L14）

AgentTree 已扩展为图数据模型（节点 + 边 + 路由），**本批只建模，不实现并行执行**（串行引擎现状保留，AgentTree 头注释如实标注）：

- **节点**：rollout/agent（status/stepCount/durationMs/lastPhase）
- **边**：`{ from, to, kind: 'dep' | 'rollback' | 'approval' }`（addEdge 去重、端点校验）
- **路由**：`route(id, kind)` 按边类型传递收集可达节点（条件回滚/审批节点预留）
- 渲染：`/agents` 节点 + `--[kind]-->` 边标注

### 三结构性失败的设计规避（本批只记录）

| 失败模式 | 规避设计 |
|---|---|
| **Goodhart**（指标当目标） | 节点状态只由执行结果驱动（upsert 不可回归），边不参与评分；完成判定仍以验证命令输出（EXIT_CODE:0/PASS）为准，不以 stepCount 高为优 |
| **盲视**（只看自己） | 边显式建模依赖/回滚关系（dep/rollback），路由在切换前必须呈现可达节点；审批边（approval）强制人工确认点，防自动滚过 |
| **冲突**（多头写同一目标） | 图模型预留共享状态标注（queue/checkpoint 在 rollout 文件体系内）；本批无并行写，未来并行执行时以边依赖序 + checkpoint 先写后读约束 |

---

**维护提示**：新增命令请在 `Repl.ts` 里 `register` + 新建 `commands/XXXCommand.ts`，并同步更新本文档表格。


---

## 并行 rollout 引擎（D-parallel，learn-harness L14 落地）

- **runMultiple 并行化**：high+ 档（high/max/ex/zorge）rollout 并发执行（Promise.allSettled），quick/standard 保持串行（成本敏感）。
- **写互斥（硬底线）**：engineAdapter 模块级 withWriteLock — write/edit_file 经单条 Promise 链串行化（共享 workspace 安全），read/bash 并行；失败不污染链。
- **预算聚合**：Σ estimatedUsedTokens 超 maxTokens → 丢弃最差评分超额 rollout（保最优）；softLimit/degradation 沿用全局语义。
- **单失败不拖垮**：allSettled + run() 捕获 → null 过滤。
- **AgentTree 渲染**：多 running 节点并存的真实并行树（原"非并行"标注移除）。
- **三结构性失败并行规避补充**：
  - Goodhart：并行不改变评分驱动（调用方 score 优先，orchestrator 回退），不因并行提高 stepCount 权重；
  - 盲视：写互斥保证共享 workspace 无交错写（checkpointBeforeMutation 在锁内），read 并发安全；
  - 冲突：预算聚合按 score 降序裁剪，避免"全都要"导致的预算透支；串行档不受影响。
