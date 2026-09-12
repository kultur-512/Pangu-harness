# Panshalach 命题交付 ROADMAP

> 现状：可见层已重命名 Panshalach、旧 Panshalach 文档已物理清理、命题文档集已就位（见 docs/panshalach/）。下列为让"命题叙事成立"的后续里程碑，按依赖排序。

## P0 ✅ 已完成（2026-09 本期）
- [x] REFACTOR-ASSESSMENT.md 重构评估报告
- [x] 物理删除 docs/ 全部旧品牌（Panshalach / 早期模型试点）/30-rounds 规划复盘文档与 docs/agents、.agents
- [x] docs/panshalach/ 命题文档集（README/ARCHITECTURE/MEMORY-DESIGN/EVALUATION/USER-GUIDE/ROADMAP）
- [x] 可见层改名 Panshalach（package/bin、欢迎/身份串、server 文案、memory 标题、tier 描述、/init 文档指针）；测试通过（当时 62 组，现 529 例）

## P1 — openPangu 泛化接入（代码）
- [x] `Glm53SweProChaser` 兼容层已删除
- [x] ModelProvider 去模型 magic shorthand / `_pickBestProviderModel` 泛化（按 provider 取第一个可用模型）；`/model` 文案去品牌特化
- [x] `.panshalach.json` example 加 openpangu provider（本机/昇腾 OpenAI 兼容端点）
- [x] ModelProvider：env 三件套泛化 `PANSHA_<PROV>_API_KEY/_BASE_URL/_MODEL`（SCNET_* 保留为 scnet 历史别名）；bare-name 路由泛化 + apiKeyCmd/headers（2026-09-04 df7a119）
- [x] `ModelCommand /model list` 改为遍历 provider 拉模型（去 scnet 独占文案；listProviderModelsWithContext 泛化 + 上下文探测缓存，未知持久化 null）
- [x] `openai-compatible.complete` 透传并返回 `message.tool_calls`（detectedFormat:'openai-json'，SSE delta.tool_calls 拼装；VerifyCritiqueLoop 消费通道零改动）（2026-09-04 df7a119）
- [x] 模型措辞泛化为"工程纪律"（StructuredReasoner 工程纪律头 / PromptBuilder 负向清单与验证铁律 / adapter 注释）
- [ ] 验收：配置 openpangu 后可 `/model list` 看到 openPangu-1B/7B/7B-VL 并运行一次真任务（待端点）

## P2 — 记忆写入闭环 + 使用语义（最高价值、最快见效）
- [x] 任务落定调用 `RefinedMemoryStore.refine({trajectory, taskStyle, applicableTiers, attemptCount, userFeedback})` → `save()`——**已落地（0.7.2）**：`finalizeTaskMemory` 单一落定点（runAgentTask result 前），覆盖 SSE/server/headless；Repl 直调三口留统一执行器收口
- [x] ~~`markUsed(cardIds)`~~ 已落地为二态 `markInjected`（记账）/ `markVerified`（保鲜，原位刷新）+ 衰减锚 max(lastSeen,lastUsedAt) + archived 过滤（2026-09-04 bf5f4a7）；markCited 推迟
- [ ] 验收：连续 3 个同风格任务后 `/memory list` 自动出现教训/成功卡；新增单测（单测/集成断言已落 `tests/integration/intentAndMemory.test.ts`；真机连续任务验收待端点）

## P3 — 事件记忆 + 任务状态机 + 语义检索 v0（长程能力成型）
- [x] `memory/events.ts` 语义事件流（decision/constraint/requirement/verified/failure/progress，append-only jsonl）；`/memory events`——**存储/查询层已落地（R4，0.6.5 王佐；AgentEvent 接线见 11dbea3）**；`/memory events` 查询子命令尚未挂载
- [x] `memory/taskState.ts` 任务状态机（原始需求锚/决策/未决/里程碑/已验证/风险），注入优先级高于普通卡——**已落地（R5，0.6.5 王佐；运行时注入接线 11dbea3）**
- [x] `memory/embed.ts` 字符 2-gram 词袋余弦 v0（零依赖）；L1 融合 semanticScore；接口可换国产向量库/openPangu embedding——**embed v0 已落地（赵天昂，含单测）；L1 注入融合尚未接线**
- [ ] 压缩滚动多级化（L1 中期结构化 envelope + L2 长期粗摘要；前置 Turn 结构化最小集，见 ROADMAP-NEXT R3/R8）
- [ ] 验收：`/memory events` 可查；注入含事件/状态命中；单测覆盖
- ⚠️ 本节细化为 ROADMAP-NEXT R4/R5（王佐/赵天昂），事件只允许显式写入点（禁止 NLP 抽取）

## P4 — openPangu 小模型适配（口径已收窄，2026-09-05）
- [x] 工具协议自适应：三路解析恒开（#7，8998efe）；原生 tool_calls 为主路径
- [x] 结构化记忆外置优先：锚点/风格头/FailureMemory 轨道已摘除，记忆注入是唯一上下文记忆面
- [x] ~~critique 初始频率下调~~ → critique 机制整体摘除（#2）
- [ ] 验收：openPangu-7B 跑通 maintenance 演示；1B 报告能力边界

## P5 — 国产软硬件亲和（资源/部署文档 + 演示）
- [ ] 昇腾 310P/910 与 vLLM-ascend / MindIE 接入步骤（DEPLOY-CN.md §5 已写，标准流程框架**待端点实测**）；麒麟/其他国产 OS 运行验证（DEPLOY-CN §6 框架已写，**待整机实测**）
- [ ] 资源预算表（1B/7B 显存、int8、上下文窗口、token 成本核算）→ ARCHITECTURE §5（待赵天昂 U7 真机回填）

## P6 — 内部存储名/品牌全量收敛（⚠️ 目标待 Leader 裁决）
- [ ] 迁移目标冲突：本条原定 `PANSHA_*`→`PANG_*`，但 0.6.0 已落地 `PANSHA_<PROV>_*` env 三件套（投资加深）——**收敛目标需重新裁决**，裁决前冻结
- [ ] `PanshalachChaser.ts`→`Panshalach.ts`、bin/文案扫尾（低优先级）

## P7 — 真实 openPangu 评测 → EVALUATION.md 填数（命题提交物 2）
- [x] 评测基建（T1-T5 + run-eval/smoke-eval/fill-evaluation + A/B/C(+C4) 消融）→ **提前到 U4**，见 ROADMAP-NEXT R6——基建已进 develop（fixture 实体化 + runner 骨架 + PANSHA_NO_MEMORY 消融开关）；真跑待端点
- [ ] A 档窗口必须真溢出（收窄窗口或长轮填充）；A/B prompt-diff 展品；T1×7B×A/B/C 最小 9 runs
- [ ] 结果回填 docs/panshalach/EVALUATION.md 各表 + 分析叙事；提交物 1/2 定稿

> 依赖顺序：P1（✅）→ P2 写闭环（✅ 0.7.2，剩真机验收）→ P3（R4/R5 ✅ 已落，剩 events CLI/多级压缩）→ P5；P7（R6）基建已就绪、真跑待端点。详细分工/验收见 ROADMAP-NEXT §3。
