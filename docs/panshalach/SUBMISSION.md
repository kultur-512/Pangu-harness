# SUBMISSION.md — 国创赛项目书（骨架 v0）

> 命题：华为《基于 openPangu 的记忆增强智能体架构设计与优化》· 国产操作系统软件组
> 产品：烛龙（Zhulong）· 内部代号 Panshalach
> 状态：**骨架**（≤1000 字概述占位 + 大纲；U8 定稿，数据回填以 `scripts/eval/results/*.json` 真实运行为准）

## 1. 项目概述（≤1000 字，U8 定稿）

（占位）基于 openPangu-1B/7B 的记忆增强长程上下文智能体，面向软件工程长期维护场景，
解决长交互/多轮任务/长文档/持续状态跟踪中的**中期遗忘**与**上下文断裂**。
技术主线：**记忆作为上下文管家**——事件化事实源 + 任务状态机 + 结构化记忆卡投影 +
统一上下文编译器；模型接入零硬编码（配置 + env 三件套驱动多模型源）。

五段式（目标 / 产品 / 技术愿景 / 创新点 / 差异化）：

- **目标**：（占位）让 7B 级国产模型在 30+ 轮维护任务中保持早期约束可召回、可遵循。
- **产品**：（占位）CLI + SSE 服务化，`panshalach run`，零运行时依赖。
- **技术愿景**：（占位）openPangu 长程上下文 + 记忆增强（不用 GLM/品牌叙事）。
- **创新点**：（U8 定稿前口径，接口契约 v3）①**事件账本 → TaskState 投影**管线：显式事件折叠、可 replay 重建、ContextSnapshot 逐任务落注入审计（promptHash+卡号+token）——对照 MemGPT/Letta 分层记忆与 LangGraph checkpoint：它们不逐任务落"模型看见了什么"的注入账本；②**注入与验证的机器可判定语义**：markInjected 仅记账不保鲜（修半衰期自激励）+ markVerified 文件交集确定性判定（无 LLM、可测试）+ [M1] 卡号引用观测通道；③ContextSnapshot 可审计注入；④双通道工具协议（原生 function calling + 文本协议自适应，弱格式遵循小模型可用）。
- **差异化**：（占位）对照无记忆基线 A / 记忆卡 B / 全能力 C 的真实 openPangu 消融评测；与知识图谱三元组的差异 = Assertion 强制 evidenceEventIds 证据链 + 事件流可 replay（1.x 立项，本项目内交付前两项）。

## 2. 完整解决方案（大纲，展开见 ARCHITECTURE.md）

- 架构分层：模型接入层（多 provider 配置驱动 + 双通道工具协议）→ 执行引擎（三路解析 + 真实工具 + 审批 + 验证信号）→
  记忆层（事件账本 → TaskState → 记忆卡投影）→ 上下文层（PromptBuilder 统一账本 + ContextSnapshot 注入审计）→ 交互层（CLI/REPL/SSE）。
- 关键流程：任务落定 → 事件落盘 → 断言抽取（候选→已验证）→ 记忆卡提炼/合并 → 下次任务注入。
- 多模型源：`.panshalach.json` providers + `PANSHA_<PROV>_*` env + `apiKeyCmd`（密钥不落盘）+
  `openpangu:openPangu-7B` 路由；原生 tool_calls 与文本协议双通道自适应。

## 3. 部署（见 DEPLOY-CN.md，U8 终版）

- 本机 / 昇腾（vLLM-ascend、MindIE）/ 麒麟 V10 SP3 / 鲲鹏 920 + openEuler。
- 依赖：Node 18+/22，零运行时依赖（UI 类 optionalDependencies 可降级）。

## 4. 效果评测（数据只从 `scripts/eval/run-eval.mjs` 真实 openPangu 运行回填）

- 档位：A 无记忆 / B 记忆卡 / C 全能力（+事件/状态/摘要/检索消融档）。
- 任务族：T1 约束保持 / T2 跨文件 / T3 长文档 / T4 中断续接 / T5 压缩后保持。
- 指标：约束召回/遵循率、跨文件关联命中、状态续接、错误记忆注入率、token 成本。
- 结果表：见 `EVALUATION.md` §4（当前为占位，未运行不填数）。

## 5. 总结与展望（U9 复盘后填）

（占位）真实收益数据、1B/7B 能力差异、局限与迭代方向。
