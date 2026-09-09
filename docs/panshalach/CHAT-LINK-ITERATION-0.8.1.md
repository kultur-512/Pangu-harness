# 对话功能链路迭代方案（0.8.1 · 2026-09-08）

> 输入：红队对抗性走查报告（chat 端到端 + 全链路抽查，探针实测复现）。
> 结论：**chat 回答三端全不可见**（line/rich/headless 三个前端全部丢失正文，被 mock 漂移的绿测试掩盖）+ **空回答静默"已回复"**——两个 P0。迭代聚焦对话链路，6 项全做（~400 行改动）。

## 翻车点 → 迭代项映射

| 翻车点 | 级别 | 迭代项 |
|---|---|---|
| chat 回答三端不可见（RunResult 无 answerText，TurnController:374 读不存在的 bestTrajectory；RunCommand:115 读错 partialText） | P0 | R1 |
| EMPTY_RESPONSE 吞成空串 → answered + 空内容伪装成功 | P0 | R2 |
| chat 非流式整段后置（违背"任何输出都前端渲染"） | P1 | R3 |
| 概念提问误进 execution（"什么是bash"/"写首诗"→完整循环白烧步数） | P1 | R5 |
| chat prompt 自相矛盾（禁工具指令 vs tier_constraint 工具纪律同框，985 chars 净荷） | P1 | R4 |
| finish_reason=length 截断 chat 无防御 | P1 | R3（顺带） |
| max_tokens 不发送 | P1 | R3（顺带） |
| "run …会发生什么"被 meta 劫持成实际执行 | P2 | R5（顺带） |
| 答案不落盘（resume/history/最近上下文只见问不见答） | P2 | R6 |
| memStoreForInvalidate 死代码 | P2 | R7（顺带删） |

## 迭代项

### R1【S】chat 正文渲染修复（P0-1）
- `runAgentTask.ts` RunResult 加性 `answerText?: string`——chat 分支把直答正文带出（chat 路径的 result 事件同步携带）
- `TurnController.ts:372-385` 兜底打印改读 `r.answerText`（line 模式 markdown 呈现）；rich 模式 `mapSseToBridge` result 分支或 chaser 事件同步补 markdown feed
- `RunCommand.ts:114-119` 改读 `answerText`（headless 输出正文）
- 修正 `TurnBehavior.lock.test.ts:235-240` 的 mock——与真实 RunResult 形状一致（消除 mock/impl 漂移）

### R2【S】空回答不伪装成功（P0-2）
- `PanshalachChaser.ts` chat 分支：`complete` 返回空串/纯空白 → `syntheticFailureTrajectory({lastError:'EMPTY_RESPONSE: 模型返回空内容'})` → stopReason='error'，UI 显示"任务执行失败 · 模型返回空内容"
- 非 chat 路径已有的空串兜底语义不变

### R3【M】chat 直答接流式 + 截断防御 + 显式 maxTokens（P1-3/6/7）
- chaser chat 分支仿 `makeMessagesComplete` 优先 `streamChatMessages([{role:'system',content:chatDirective},{role:'user',content:issue}])`——复用 `consumeChunks`/`emitDelta` 免费获得 message.delta 流式（line/rich 渲染端已支持）
- 无 chat 能力 provider 回落现有 complete（保持 R1 的整段呈现）
- truncated 标记检测：截断时正文尾部追加 `\n\n[回答被 max_tokens 截断]`
- 显式 `maxTokens`（chat 用 4096，避免网关默认值摆布）

### R4【S】chat prompt 减负（P1-5）
- `buildVolatileSegment` 对 intent='chat' 额外跳过：tier_constraint XML、thinking_budget、锚点注记、TaskState（当前只跳 4 块，再加 4 个门）——保留记忆卡+最近上下文+身份行
- 效果：chat 净荷 985 chars → 约 500 chars，消除"禁工具指令 vs 工具纪律同框"的矛盾注入

### R5【M】意图词表收敛（P1-4 + P2-8 顺带）
- `taskIntent.ts`：EXECUTION_WORDS/VERBS 命中后加否定启发——输入含疑问标记（什么/怎么/为什么/区别/吗/？/是什么）→ 降级 search（含文件扩展名时）或 chat
- `isMeta` 的 `^run\s` 判定从 classifyTaskIntent 移除（保留在 line 模式本地命令派发——`run` 命令别名语义只在交互层有意义，不进意图分类）
- 单测：12 边界输入（红队探针 2 的词表）锁定

### R6【S】chat 答案落盘（P2-10）
- chat 直答的 turn 落盘带 `result.answerText`（TurnController/RunCommand 落盘点）
- `getRecentContext` 摘要带上答案（截断 200 字符）；resume 回放可见问答对

### R7【S】顺带清理
- 删 `memStoreForInvalidate` 死代码（PanshalachChaser.ts:108/535）

## 明确不做（本轮）
- chat 走完整 messages 双通道 + stable 进 system + 前缀缓存（L，与王佐 R4 跨任务会话设计合流后做）
- smart LLM 审批裁判、subagent、hooks（0.9+）

## 验收门
1. R1/R2/R5/R6 各有单测/集成测试锁定（红队探针场景反转为绿）
2. 全量 ≥872+新增 全绿 + tsc + 双契约脚本
3. TurnBehavior.lock 测试 mock 修正后全绿（消除假阴性）
4. 真机指引：端点恢复后"你好"→ 流式回答可见 + 空响应场景显示失败

## 执行切分
单子智能体串行（R1-R7 文件族：PanshalachChaser/runAgentTask/TurnController/RunCommand/taskIntent/PromptBuilder——有相互依赖，串行最稳）→ 统一 debug → 提交。
