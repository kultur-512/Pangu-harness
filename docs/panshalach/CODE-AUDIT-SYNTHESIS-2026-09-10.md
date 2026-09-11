# 烛龙代码审计综合报告（2026-09-10 · 以真实代码为准）

> 方法：三路只读审计子智能体（记忆/上下文/执行链）逐行读码 + 探针实测，产出 117 项机制真值表（存在?/已接线?/默认启用?/证据行号）。**本报告不采信任何 md 描述**——凡文档与代码不符处，以代码为准并在文中标注。

## 一、项目开发进度（真实状态）

**版本演进**（全部有提交对应）：0.6.4 终止语义与三先决 → 0.6.5 部署落地 → 0.7.0 判官摘除+意图分类+AbortSignal → 0.7.1 UI 手感+技术债 → 0.7.2 意图前移+记忆落定 → 0.7.3 真实成功信号入册 → 0.7.4 dist/中断语义 → **0.8 M1 四模块搬家+messages 双通道+M2 执行层七项 + 0.8.1 mock 门摘除+对话链路迭代**（当前 HEAD=9dfe7ea 之后的 d91999f 线）。

**规模与质量**：src 122 文件 / 23,392 行；tests 100 文件 / **886 例全绿**（748+1skip 起步经六轮迭代增至）；双契约脚本（cleanup/protected-files）PASS。

**集成状态**：四分支（主线+王浩宇+王佐+赵天昂）已全部合入 develop（b4093f1）；王浩宇/赵天昂 9/10 仍有新提交未合（eval 域跑分准备与 fixture）。

**审计揭示的真实成色**（与文档叙事的差异）：
- 36+44+37=117 项机制真值中，约 **92 项"存在且已接线"**，约 **17 项"存在但未接线/死代码/纸面类型"**，约 8 项部分接线。
- 典型脱节：`stableSegment→system` 前缀缓存设计未接线（runAgentTask 不传 segment，chaser 门恒 false）；`onContextOverflow→会话级强制 compact` 未接线（已铺管未通水）；`MemoryEventStore`/`embed.ts`/`readContextSnapshots` 零消费；`markInjected` 账本实例即弃；`memory_cited` 等六个事件类型是纸面声明；预算软限/降级是死旗标。

## 二、项目开发逻辑（真实运转的链路）

```
用户输入 → TurnController.handleLine
  ├─ 斜杠命令 → CommandRouter（26 命令，未知命令永不进引擎）
  ├─ 意图分类（原始输入，taskIntent.ts）：
  │    chat → 单次直答（stream→chat→complete 三级回落，无工具无审批）
  │    search → 只读循环 ≤3 步（强制 readonly）
  │    execution → 完整循环
  ▼ PromptBuilder（intent 分支组装；chat 跳过 8 个重工程块）
  ▼ PanshalachChaser.solveIssue → VerifyCritiqueLoop（单循环）
       每步：意图化 prompt 注入 → 模型 → 三路解析（FC/文本/XML）
         → guardrails 硬闸 → 审批门（readonly白名单/default审批/full放行
           +敏感路径先于审批+pathGuard+RBW）→ 并行分段执行（读并发≤3+写barrier）
         → 结果按原始序回灌（native tool role / 文本降级）
  ▼ 终止判定（七态）：PASS 尾标锚定→completed；空转防呆→no-verification；
     end_turn→answered；截断禁判；连败/硬闸→consecutive-failures；
     abort→aborted(现场保全)；异常→error
  ▼ 任务落定：completed → finalizeTaskMemory（refine→save 产卡
     + 注入卡∩写集→markVerified 保鲜）→ rollout JSONL 落盘（可 resume/branch/undo）
```

## 三、底层架构设计（真实形态）

1. **入口/交互层**：cli.ts（headless/approval/兼容别名）→ sseInteractive（358 行会话壳：TTY 判定/降级/SIGINT）→ turn/ 四模块（TurnContext 231/TurnController 460/TurnRenderer 656/CommandRouter 624）。
2. **模型层**：openai-compatible 单文件承载全部网关语义——双通道（complete 旧包装 + chat/streamChatMessages 新引擎共享 doComplete）、withRetry(5)、finish_reason 防御、usage 解析、errorClassify 八类、敏感文案指引。
3. **记忆层**：RefinedMemoryStore（二态/衰减四段阶梯/引用交集/tier 可见性/投影 LRU）+ rolloutStore（7 种事件 JSONL + auditStatus）+ compactService（血统账本 + 后台预压缩 + 补漏提炼）+ taskState（已接线：建账/折叠/注入）。
4. **安全层**：审批三档光谱 + 'a' 项目级持久化 + 敏感路径全档位拒（含 undo）+ pathGuard 双围栏 + RBW + readonly 白名单（链/重定向整体拒）+ 写锁 + 420s 批超时。
5. **质量设施**：886 例测试 + cleanup/protected-files 双契约脚本。

## 四、记忆与上下文管理的创新性判定（以代码为准）

### 真实创新（CC/hermes/pi/dsh 均无直接等价物）

| # | 机制 | 代码证据 | 创新性说明 |
|---|---|---|---|
| 1 | **记忆卡二态语义**（markInjected 纯记账 / markVerified 行为保鲜） | RefinedMemoryStore.ts:429-467；判定=注入卡∩轨迹写集 | "被看见≠被使用"的形式化：注入不改变生命周期，只有工具写入与卡引用文件的交集才触发保鲜。CC 无记忆提炼模型；hermes/pi 的 memory tool 是模型主动读写，无使用判定 |
| 2 | **compact 血统账本**（generation{turnCount,lastTurnId}+coveredTurnIds+marker 先写盘+拒绝 apply） | compactService.ts:53-61,156-173,377-427 | 防 resume 双源分歧的 fail-safe 设计强于 CC 的 microcompact 与 hermes 的 archive（后者无代际拒绝语义） |
| 3 | **回合七态终止语义 + completed 升级门** | types.ts:281-289；VerifyCritiqueLoop.ts:861-912 | "完成"必须由真实验证信号升级，模型自述无效；截断禁判 answered；空转防呆 nudge——外部 harness 均依赖模型自述或用户中断 |
| 4 | **确定性验证信号入册**（尾标 PASS/APPLIED/NEUTRAL + classifySignal 分段尾锚定） | engineAdapter.ts:413-423；VerifyCritiqueLoop.ts:892-912 | 把成败判定从模型自述剥离为引擎确定性输出（弱模型场景关键创新）；CC/hermes 无此机制 |
| 5 | **意图三路前置分类 + 逃生门** | taskIntent.ts:53-88；runAgentTask 前移接线 | chat 直答/search 只读限 3 步/execution 全循环——对弱模型的防空转设计；外部均无显式意图路由 |
| 6 | **审批持久化 'a' + n:指导语回灌** | approval.ts+ConfigManager.ts:120-144 | 拒绝即指导（用户一句话进模型反馈）是独有交互设计 |

### 追平对齐（0.8 补齐，外部早有）

messages 数组通道（0.8 新落地，但 stable→system 未接线——见下）、并行分段调度、卡死硬闸、结果落盘回读、真实 usage 计量、错误分类器、敏感路径保护、审批持久化、plan mode、TurnController 结构。

### 仍落后（S 级，登记 0.9+）

跨任务连续会话（现仍摘要接力）、Subagent/Task、Hooks 总线、skills 渐进披露、MCP SSE 传输、@path 内容引用、prompt 前缀缓存（stable→system 未接线，见下）。

### ⚠️ 审计揭示的"伪创新"风险（文档宣称 vs 代码现实）

1. **"stable 段进 system、前缀缓存可命中"= 未接线设计**：runAgentTask 不传 stableSegment/volatileSegment → chaser 门恒 false → 生产请求体**没有 system 消息**，stable 段仍拼在首条 user。
2. **"overflow 触发会话级压缩"未接线**：onContextOverflow 无调用方。
3. **"注入审计可查"半真**：ContextSnapshot 写入真实、读取零消费。
4. **"二态使用语义"半真**：markVerified 真实；markInjected 账本实例即弃+零读取（"注入记账"是事件审计层面的真，账本查询层面是死的）。
5. **"预算软限降级"不存在**：triggeredSoftLimit/Degradation 是死旗标，只有计量无行为。

## 五、已知未修缺陷清单（审计新发现，按危害排序）

1. **approval.request 事件在 line 模式无限递归**（TurnRenderer default 分支重派发，RangeError→任务 error 终态）——静态推断未运行，需修复 renderSseEvent 的 default 分支排除该 type。
2. **messages 通道 overflow 自愈失效**：messages 栈不裁剪，overflow 重试原样重发必二次超限（文本路径才有裁剪）——P2 遗留成为默认路径缺陷。
3. **stopReason 残留**：FAIL 步置 consecutive-failures 未 done，maxSteps 退出冒充连败。
4. **success 与 stopReason 脱钩**：max-steps/consecutive-failures 终态也可 success=true（与"完成需验证"语义冲突）。
5. **markInjected 账本实例即弃**（只写不读）；**currentTaskId 跨任务粘滞**（TaskState originalRequirement 恒为首任务）。
6. **MCP allowlist 旁路 readonly**；bash 内写敏感路径不可拦；/approvals clear 不清持久化。
7. **计量口径分裂**：窗口预算 chars/4 vs estTokens CJK×1.5 vs usage 实测，三者互不校正；usage 实测未反哺窗口管理。
8. **PASS 启发式残留**：正文含 "pass"+"5" 即计真实验证（加法示例残留）。

## 六、9/24 前建议

1. 修 #1（approval.request 递归，~10 行）与 #2（messages 栈 overflow 裁剪，~40 行）——两者都是默认路径缺陷。
2. #6 的 schema 7 态同步（Leader 窗口）与 #4（success 语义收紧）随合入窗口处理。
3. 评测真机数据（R6 已就绪，等端点）仍是最高优先交付缺口。
