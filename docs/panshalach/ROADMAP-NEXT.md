# Panshalach / 烛龙 Zhulong —— 路线与未完成项（2026-09-12 收口版）

> 内部代号 盤沙拉克 Panshalach / 外部产品 烛龙 Zhulong。命题：华为《基于 openPangu 的记忆增强智能体架构设计与优化》。交付：**9/24**。
> 本文档只维护两件事：**项目当前成果状态**与**未完成项**。已销项历史不再列表——分版本成果见 [CHANGELOG.md](../../CHANGELOG.md)，设计过程文档见 `archive/`（2026-09-05-* 摘除装置与过程方案、2026-09-12-process-docs/ 迭代方案与归档说明）。

## 当前成果状态（2026-09-12 合并收口）

- **版本 v0.8.0-rc**，四分支已全部合入 develop（`5105ebf`）：主线 0.8.0-rc（turn 四模块会话壳 + messages 双通道协议 + stable/volatile 三段 prompt + 执行层七件套 + CC 级交互四件套 + 记忆链三缺陷治理 + 身份画像通用化）+ 王佐 R4/R5 挂载（/memory events、TaskState.record*）+ 王浩宇 U5（Repl 三口接线 + TurnStopReason 同步）+ 赵天昂 R5 task CLI 三子命令 + R6 follow-up。
- **质量基线**：`npx tsc --noEmit` 干净；`npm test` **1008 例全绿**（1007 pass + 1 skip）；`verify-m2-e2e` + `check-protected-files` 双契约 PASS；`scripts/eval/smoke-eval.mjs` A/B/C/C4 四档冒烟全过（评测管线就绪，待真机端点）。
- 旧分支（zhaiyuanhao1/wangzuo1/wanghaoyu1/zhaotianang1）**已冻结**，新工作自 develop 拉 `<pinyin>2`。
- **0.8.2 上下文压缩对抗审查修复（2026-09-13，zhaiyuanhao1）**：P1 计量地基（tokenEstimate 收口 / 实测 usage 锚点 lastPromptTokens / CJK-aware 估算 / REPL windowTokens 接线 / 裁剪后复查 + 单步封顶 / messages 模式溢出重试真实截断）+ P2 摘要质量（提炼统一到 apply 写盘后 / turnFullBrief 逐字保留落地 / fallback 嵌套封顶 / 压缩摘要注入 prompt / kept 字节感知收缩）+ 文案诚实化（溢出应急=确定性截断，与摘要压缩严格区分）。测试 1039 绿。

- **0.8.3 对抗性审查修缮（2026-09-13，zhaiyuanhao1）**：四路子系统深审（记忆/循环压缩/工具安全/适配器模型层）确认 3 P0 + 12 P1 + 全部 P2 并全量修复——审批工具别名绕过（readonly/plan 档 `write`/`edit` 直写）、readonly bash 白名单换行/命令替换逃逸、messages 二级收缩纯中文巨结果死循环（默认路径 P0）、记忆 OTHER 桶 10 张挤爆（80/200 声明不可达）与原子写/quarantine/审计账本、适配器容错砍尾、模型层 body 超时/Retry-After/流式 name 幂等。新增对抗性回归测试 118 例（旧代码验红）+ CI test 门（ci.yml）+ 90 题 LME 基建与修复前基线（strict 9/90）。测试 **1162 例绿**（concurrency=4）。B2 记忆审计清单中：注入审计视图（/memory stats）、classic recordChatFact 接线、容量治理、chat-fact 去重本轮已完成；messages 分段补 Repl/Simulate、2-gram 相关性、prevEnvSnapshot 仍遗留。

- **0.8.4/0.8.5 记忆架构优化与全适用性迭代（2026-09-14，zhaiyuanhao1）**：三路探查（写路径 84.5% 丢弃率实证 / 检索召回实验 / 时间性失败归因）→ 实现 → 子代理 review 全处置。0.8.4：时间锚定（sessionDate 贯通 + 卡带 factDateText + "今天是 X"注入，根除评测回放假日期污染）、宽进严排（对卡为主单元 + confidence 分类器 + 80 帽硬拒绝删除 + 配对牵连修复）、混合检索（embed 语义接入 loadFiltered，降级完备）、窗口感知注入（比例预算 + 实测 token 门）。0.8.5：中文检索双通道打通（CJK 关键词 2-gram 词粒度 + 语义闸 CJK 放宽 + 查询稀释修复——中文场景此前排序退化纯新近度）、chat 最近对话原文贯通、load() 跨实例静默抹卡防御、auto-pull 意图门禁、遗留核销 6 项。90 题轨迹 strict 9→13→15→16（英文回归守护无回退），六格交叉对比见 [COMPARE-90](../../scripts/eval/longmemeval-90/COMPARE-90.md)。测试 **1253 例绿**。

## 未完成项

### A. 9/24 交付关键路径（有截止时间，按序）

| # | 项 | Owner | 说明 |
|---|---|---|---|
| A1 | **R6 真机评测数据** | 赵天昂+王浩宇 | 端点就绪后 `scripts/eval/run-eval.mjs` 跑 A/B/C/C4（A 档必须真溢出；B 档零注入=防线失败不计有效样本）→ `fill-evaluation.mjs` 回填 [EVALUATION.md](EVALUATION.md) §4。**当前唯一无备用方案的关键项**——最迟 9/17 开跑。基准选型与扩展（LongMemEval 锚点/窗口探测）见 [EVAL-FEASIBILITY.md](EVAL-FEASIBILITY.md)；**前置：T3 fixture 按 32K 窗口校准溢出规模（§1.5），否则 A 档整档无效** |
| A2 | **提交物定稿（R9）** | Leader+全员 | SUBMISSION 终稿（评测段按 A1 数据回填）、DEPLOY-CN 昇腾/麒麟实测口径、ARCHITECTURE §5 资源实测表（U7 待测数据） |
| A3 | **master 发布** | kultur | develop 冻结 + A1 回填后，走 CI gate（agent-branch-guard）合入并打 tag；国创赛后台提报 |

### B. 工程遗留（已登记，按带宽排期）

| # | 项 | 位置 | 说明 |
|---|---|---|---|
| B1 | 全量测试 concurrency=4 并行跑进程静默死亡（串行全绿） | `tests/` | 疑某测试与多路 stdout 捕获冲突；**CI 强制前必须定位** |
| B2 | 记忆审计 #4-#13 剩余项 | `src/memory/*`、`Repl.ts` | messages 分段接线补 Repl/Simulate 两调用方；CJK 2-gram 相关性增强；--classic 路径接 finalizeTaskMemory；prevEnvSnapshot 挂 Session 让 env 增量真正增量；档位契约对齐；磁盘压实 |
| B3 | classic 路径 windowTokens 漏传 | `Repl.ts`（对照 `runAgentTask.ts:173`） | 窗口预算在 classic/`--headless` 单条命令路径不生效（~40 行，hermes 对齐唯一采纳项） |
| B4 | classic 路径 messages 分段未接 | `Repl.ts` | classic 直调 solveIssue 走旧文本协议（逃生门语义，非缺陷；对齐后 classic 与主线一致） |
| B5 | MCP 工具结果验证尾标策略 | `engineAdapter.ts` | MCP 调用成功不计 PASS（防自述伪装真实验证）——分类策略待定，宁缺毋滥 |
| B6 | 栈溢出守卫长会话自然复现验证 | 渲染层 | renderSseEvent 自递归守卫已修，待真机长会话自然复现确认 |
| B7 | rewind 事件 replay 消费 / 双 synthetic 幂等 / listBranches O(N²) | `rolloutStore.ts` | 随评测工程处理 |
| B11 | classic REPL 与 complete-only 回退的记忆覆盖缺口 | `Repl.ts:434`、`PanshalachChaser.ts:406` | classic chat 直答不传 chatMemoryBlock/chatRecentTurns；complete-only 客户端 chat 零记忆零上下文——两通道均已在源码注释申报（2026-09-14 迭代），补齐属独立工作项 |

### C. 0.9+ 候选（已裁决推迟，恢复指针）

| 项 | 触发条件 / 说明 |
|---|---|
| 0.8 M3 时间盒项：Plan mode ExitPlanMode 确认卡 / MCP SSE 传输 / skills 渐进披露 / hooks 总线 / @path 内容注入 | 评测后按演示需求取舍 |
| 跨任务连续 messages 会话（CC 式同一数组跨任务 append） | 需与王佐 R4 事件层联合设计（rollout 对齐） |
| R7 语义检索 L1 注入融合 | embed v0 已落（C4 消融档就绪），注入融合待接；可插拔国产向量库/openPangu embedding |
| R8 多级滚动摘要 + 不对称压缩 | Turn.role 字段已就位；compactService 分区改造本体 |
| [M1] 卡号引用实验（markCited） | 注入已带 [M1] 编号，7B 引用实验 9/24 后 |
| P6 存储名迁移（PANSHA_*→PANG_*） | **待 Leader 裁决**（与已落地 PANSHA_<PROV>_* 命名方向冲突） |
| Assertion 抽取器 / ContextCompiler 独立模块 / token 估算器统一 | 契约保留 types.ts，9/24 后 |
| subagent 委派 / 工具 schema 按 intent 过滤（`PANSHA_TOOLS_MODE`） | 评测后按消融需求立项 |

## 9/24 完成条件（验收门）

- `npx tsc --noEmit` EXIT=0；`npm test` 全绿（以实际输出为准）；双契约脚本 PASS；
- `run-eval.mjs` 真实 openPangu 出 A/B/C(+C4) 结果 → EVALUATION.md §4 回填（mock 不入结果表）；
- SUBMISSION / DEPLOY-CN / ARCHITECTURE 定稿，无任何指向未落地代码的 claim。

## 真实 openPangu 运行步骤（A1 执行手册）

```bash
# 0) 端点就绪（昇腾 MindIE / vLLM-ascend / 本机 vLLM）— OpenAI 兼容 /v1，
#    POST /chat/completions 支持原生 tool_calls（也容错文本协议）
# 1) 配置（env 三件套或 .panshalach.json providers.openpangu + apiKeyCmd）
export PANSHA_OPENPANGU_API_KEY=EMPTY
export PANSHA_OPENPANGU_BASE_URL=http://127.0.0.1:8000/v1
export PANSHA_MODEL=openpangu:openPangu-7B
# 2) 验证
panshalach run "ping"
# 3) 真实评测
node scripts/eval/run-eval.mjs --openpangu http://127.0.0.1:8000/v1 --tasks T1,T2,T3,T4,T5 --modes A,B,C
# 4) 回填 + 定稿
node scripts/eval/fill-evaluation.mjs
```

## 关键文件路径

| 模块 | 路径 |
|---|---|
| 入口/主类 | `src/PanshalachChaser.ts`、`src/cli.ts`、`src/cli/repl.ts` |
| 会话壳（0.8） | `src/cli/repl/turn/{TurnContext,TurnController,TurnRenderer,CommandRouter,SlashMenu}.ts` |
| 模型接入 | `src/model/{openai-compatible,ProviderRegistry,errorClassify}.ts`、`src/cli/repl/ModelProvider.ts` |
| 执行循环 | `src/loop/{VerifyCritiqueLoop,guardrails}.ts`、`src/reasoning/StructuredReasoner.ts`、`src/cli/taskIntent.ts` |
| 提示注入 | `src/cli/repl/PromptBuilder.ts`（stable/volatile 三段） |
| 记忆 | `src/memory/{RefinedMemoryStore,RefinedMemoryCard,trajectoryFiles,events,taskState,embed}.ts` |
| 压缩/会话 | `src/cli/repl/{compactService,compactStrategies,Session,SessionStore,rolloutStore}.ts` |
| 工具引擎 | `src/tools/*`（审批/RBW/敏感路径/落盘回读） |
| 评测 | `scripts/eval/{run-eval,smoke-eval,fill-evaluation}.mjs`、`tasks/T1-T5/` |
| 归档 | `archive/2026-09-05-*/`（摘除装置）、`archive/2026-09-12-process-docs/`（迭代方案 + 归档索引） |
