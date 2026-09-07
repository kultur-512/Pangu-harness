# SUBMISSION.md — 国创赛项目书

> 命题：华为《基于 openPangu 的记忆增强智能体架构设计与优化》· 国产操作系统软件组
> 产品：烛龙（Zhulong）· 内部代号 Panshalach（盤沙拉克）
> 版本基线：v0.7.4（终止语义重构 + 意图前移 + 记忆落定主线版 + 主链确定性修复 + 中断语义修正——模型故障与用户中断严格分离）
> 配套文档：[ARCHITECTURE.md](ARCHITECTURE.md)（架构）· [MEMORY-DESIGN.md](MEMORY-DESIGN.md)（记忆子系统）· [DEPLOY-CN.md](DEPLOY-CN.md)（部署）· [EVALUATION.md](EVALUATION.md)（评测，数据位为诚实占位）
> 事实纪律：本文只声明已在代码中落地的能力；未完成项与待验证项显式标注，评测数据一律以真实 openPangu 运行回填（见 §6）。

## 1. 项目概述（≤1000 字）

**命题理解**：软件工程长期维护是典型的长程任务——早期定下的设计约束在第 N 轮新增需求时被悄悄破坏，跨文件/长文档关联随上下文窗口滚动丢失，进程中断后进度无法续接。这正是命题指出的"中期遗忘 / 上下文断裂"：问题不在模型窗口不够大，而在关键事实只以对话 token 形式存在、随滚动被挤出。本项目的回答是**记忆作为上下文管家**：把约束、教训、进度、决策显式外置为结构化记忆，经预算闸门注入每轮 prompt，让 1B/7B 级 openPangu 模型在 30+ 轮维护任务中保持早期约束可召回、可遵循。

**架构总览**：执行侧为"单循环 + 回合三态 + 意图分类"——入口先做轻量意图分类：`chat` 单次直答（不进循环、不灌工具 schema）、`search` 受限只读循环（≤3 步、禁写禁 bash、搜不到反问用户）、`task` 进完整验证循环（思维链 → 工具调用 → 验证信号）；回合以三态终止：`completed`（真实验证 PASS）/ `answered`（有面向用户正文）/ `no-verification`（空白空转，失败），另有 max-steps / 连错上限 / 中止；Ctrl+C 经 AbortSignal 贯穿至模型请求与工具执行。记忆侧为四层账本：①**事件账本**（rollout jsonl：回合/审批/压缩/逐任务注入事件，追加式、可 replay）；②**任务状态**（原始需求锚 + 决策/未决/进度，防需求漂移；类型契约已定稿，运行时接入进行中）；③**记忆卡投影**（教训/经验/偏好三类卡，分档衰减、同主题合并、参照文件过滤）；④**注入审计快照**（ContextSnapshot 逐任务记录 promptHash 与注入卡号——"模型看见了什么"可查证）。

**与 openPangu 的关系**：openPangu-1B/7B/7B-VL 是唯一推理底座，经 OpenAI 兼容端点接入（本机 LM Studio/vLLM，昇腾 vLLM-ascend/MindIE）。本项目不改基础模型、不做 SFT，以 test-time 记忆增强与上下文工程兑现"记忆增强智能体"路线；模型层零硬编码（providers 配置 + 环境变量三件套），openPangu 可替换而记忆与循环不动。

## 2. 完整解决方案

分层架构与推理流程全文见 [ARCHITECTURE.md](ARCHITECTURE.md)，要点：

- **五层结构**：模型接入层（多 provider 配置驱动 + 原生 function calling/文本协议双通道）→ 执行循环层（单 loop、三路解析、Read-Before-Write / Verify-Before-Claim 铁律、四档审批）→ 记忆增强层（事件账本 → 任务状态 → 记忆卡投影）→ 提示工程层（L0 硬约束 + L1 记忆卡注入：档位可见性/参照文件交集/关键词相关性/token 预算）→ 交互层（CLI/REPL/SSE 服务化）。
- **关键流程**：意图分类 → buildForTask 唯一记忆注入口 → 单次 loop.run → 回合落定（提炼写盘 + 注入审计 + rollout 追加）→ 需要时后台压缩（血统账本保护）→ 下一回合 L1 注入读到上一轮沉淀。
- **多模型源**：`.panshalach.json` providers + `PANSHA_<PROV>_*` 环境变量三件套 + `apiKeyCmd`（密钥不落盘）+ `openpangu:openPangu-7B` 前缀路由。

## 3. 核心创新点（逐条对应已落地代码事实）

1. **记忆卡二态使用语义**（`src/memory/RefinedMemoryStore.ts`，已落地）：`markInjected` 仅记账（不刷新衰减/count，防"注入即保鲜"的自激励）；`markVerified` 是唯一保鲜通道（刷新 lastUsedAt/count 并直写持久化），判定来源为任务内真实触碰文件与卡参照文件的交集——机器可判定、无 LLM 参与、可测试。衰减锚取 `max(lastSeen, lastUsedAt)`。
2. **逐任务注入审计**（`ContextSnapshot`，已落地）：每次任务把 promptHash（sha1 前 12 位）与注入卡号（[M1] 连续编号，跨 L1/溢出块单一序列）落 rollout `context` 事件——区别于同类方案，逐任务留下"模型实际看见了哪些记忆"的可查证账本。
3. **压缩血统账本**（`compactService`，已落地）：`CompactResult` 携带 `generation(turnCount,lastTurnId)` / `coveredTurnIds` / `syntheticTurn`，apply 按覆盖账本安全合并（修复压缩期间新增轮静默丢失）；rewind 导致血统断开时拒绝 apply；压缩被移除轮次中的验证成功信号确定性补提为 success 卡（hash 去重）——压缩成为记忆沉淀入口而非信息黑洞。
4. **回合三态终止语义**（0.7 重构，已落地）：`completed`（真实验证 PASS，喂记忆成功卡）/ `answered`（end_turn 有正文，计成功并呈现正文但不进记忆成功卡——UI 成功 ≠ 记忆成功）/ `no-verification`（空白空转，失败）；外置判官与 TestTimeOrchestrator 已摘除，回合上界压回单次 `maxSteps`（弱模型伪工具调用下续跑×N 不收敛的实测教训）。
5. **意图分类前置**（`src/cli/taskIntent.ts`，已落地）：入口原文分类 chat/search/task/meta——问答不再被灌格式教学与工具 schema 空转，找文件类输入只读搜索、搜不到反问用户而非乱建文件；`PANSHA_INTENT_GATE=0` 逃生门。
6. **AbortSignal 贯穿**（0.7，已落地）：`runAgentTask → solveIssue → loop → 模型请求（fetch/streamChat）→ 工具执行`，Ctrl+C 真正中止任务（回合记 `aborted`），UI 等待底层 settle；0.7.3 起 one-shot/classic/simulate 三入口透传审批与中断信号，aborted 回合现场落盘（保留已流出正文）。0.7.4 中断语义修正：模型/网络/解析异常落独立 `error` 终态（UI"任务执行失败" + 端点检查提示），与用户中断严格分离；streamChat 非流式回退具备与 complete 一致的 withRetry/空响应保护。已知边界如实声明：fetch 已发出后 abort 中断读取/连接，网关侧生成可能仍在后台算完；bash 子进程强杀已落地（0.7.1 tree-kill）。
7. **记忆写入闭环（任务自动产卡）**：主线已接线（0.7.2 `finalizeTaskMemory` 单一落定点）——completed 任务自动 `refine`（信号收紧为 `stopReason==='completed'` 或用户正向反馈）→ `save` → 投影失效重建，注入卡被真实写集触碰时自动 `markVerified`；0.7.3 真实成功信号入册后 completed 真机可达。覆盖 SSE/server/headless 路径（Repl 直调三口待统一执行器）；**尚未完成端到端真机验证，不以"已全面验证"口径声明**。压缩补漏提炼与用户显式 `/memory remember` 两条写入源已实现。
8. **双通道工具协议 + 零依赖国产亲和**：原生 function calling 请求侧透传（tools + tool_choice:auto 随每次请求下发，抓包实证）与文本协议三路自适应解析（OpenAI JSON/文本/`<>` XML）——弱格式遵循小模型可用；`dependencies: {}` 零运行时依赖，Node ≥18 即可部署（详见 [DEPLOY-CN.md](DEPLOY-CN.md)）。

## 4. 差异化对比

| 对照 | 通用做法 | 本方案差异 |
|---|---|---|
| **vs 通用 RAG 记忆** | 向量库存"文档片段"，检索靠语义相似度，注入即忘、无使用反馈 | 记忆卡是**任务中提炼的教训/经验/偏好**（不是静态语料）；注入→使用有二态语义与逐任务审计账本；衰减/合并/容量是确定性规则，离线可测试可复现，不烧推理 token；证据链落在事件账本（context 事件 + compact 账本），可 replay 重建 |
| **vs 长上下文堆窗口** | 窗口加大/截断搬运，成本随长度线性上涨，"中期遗忘"只是被推迟 | 关键事实**显式外置**进固定预算的注入槽位，不依赖模型把 N 轮前 token 记住；压缩时以血统账本防信息丢失、以补漏提炼把"被挤出窗口"的信号转为结构化卡；token 成本近似常数而非随会话长度增长 |
| **vs 朴素 agent loop** | 单一执行循环对待一切输入：问答被灌工具 schema 空转、终止靠步数耗尽或外部判官续跑 | 意图分类前置分流（chat 直答 / search 只读受限 / task 完整验证）；回合三态给出**语义化结局**（真实验证通过 / 有正文答复 / 空白空转），记忆信号按三态收紧；AbortSignal 全链真中止 |

## 5. 部署

本地（Windows/Linux/macOS）、远端 OpenAI 兼容网关、昇腾 310P/910（vLLM-ascend / MindIE）、麒麟等国产 OS 的从零到一路径、两级配置全集、`PANSHA_*` 环境变量表与常见问题，见 **[DEPLOY-CN.md](DEPLOY-CN.md)**。依赖基线：Node ≥18（实测 22）、零运行时依赖（富 UI 为 optionalDependencies，非 TTY 自动降级）。

## 6. 效果评测（数据位保留占位）

评测方法、基线档位（A 无记忆 / B 记忆卡 / C 全能力 + C4 语义检索消融）、任务族（T1 约束保持 / T2 跨文件 / T3 长文档 / T4 中断续接 / T5 压缩后保持）与指标定义见 **[EVALUATION.md](EVALUATION.md)**。

> **数据状态声明**：§4 结果表当前全部为占位，仅真实 openPangu 运行（`scripts/eval/run-eval.mjs`，评测基建接入中）后回填；任何合成/演示数据不虚报为真模型结果。本文不预填任何数字。

## 7. 总结与展望

已完成：0.6.0–0.7.x 七个迭代把多模型接入、记忆 v3（二态/衰减锚/账本）、终止语义重构（判官摘除 + 三态 + 意图分类 + AbortSignal）落到主线，全套自动化测试以 `npm test` 实际输出为准。进行中：记忆写入闭环收口接线、评测基建（R6）接入、真机 openPangu 端到端验证与资源实测。后续：事件/任务状态运行时全量接线、语义检索 C4 消融、多级滚动摘要、[M1] 卡号引用实验（7B）、昇腾/麒麟真机部署验证——路线与验收门见 [ROADMAP-NEXT.md](ROADMAP-NEXT.md)。
