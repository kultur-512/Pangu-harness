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
- [ ] `ModelCommand /model list` 改为遍历全部 provider 拉模型（去 scnet 独占文案）
- [x] `openai-compatible.complete` 透传并返回 `message.tool_calls`（detectedFormat:'openai-json'，SSE delta.tool_calls 拼装；VerifyCritiqueLoop 消费通道零改动）（2026-09-04 df7a119）
- [ ] 模型措辞泛化为"工程纪律"（StructuredReasoner 铁律头 / 负向清单 / adapter 注释）
- [ ] 验收：配置 openpangu 后可 `/model list` 看到 openPangu-1B/7B/7B-VL 并运行一次真任务

## P2 — 记忆写入闭环 + 使用语义（最高价值、最快见效）
- [ ] 任务落定调用 `RefinedMemoryStore.refine({trajectory, taskStyle, applicableTiers, attemptCount, userFeedback})` → `save()`（REPL executeTask / runAgentTask / sseInteractive 回合落定）——**仍缺，唯一剩余缺口**
- [x] ~~`markUsed(cardIds)`~~ 已落地为二态 `markInjected`（记账）/ `markVerified`（保鲜，原位刷新）+ 衰减锚 max(lastSeen,lastUsedAt) + archived 过滤（2026-09-04 bf5f4a7）；markCited 推迟
- [ ] 验收：连续 3 个同风格任务后 `/memory list` 自动出现教训/成功卡；新增单测

## P3 — 事件记忆 + 任务状态机 + 语义检索 v0（长程能力成型）
- [ ] `memory/events.ts` 语义事件流（decision/constraint/requirement/verified/failure/progress，append-only jsonl）；`/memory events`
- [ ] `memory/taskState.ts` 任务状态机（原始需求锚/决策/未决/里程碑/已验证/风险），注入优先级高于普通卡
- [ ] `memory/embed.ts` 字符 2-gram 词袋余弦 v0（零依赖）；L1 融合 semanticScore；接口可换国产向量库/openPangu embedding
- [ ] 压缩滚动多级化（长期粗摘要 + 中期事件/卡 + 近期逐字）
- [ ] 验收：`/memory events` 可查；注入含事件/状态命中；单测覆盖

## P4 — openPangu 小模型适配 + maintenance 场景 profile
- [ ] `taskStyle=maintenance`（软件工程长期维护验证风格）
- [ ] 小模型适配：结构化记忆外置优先、工具协议自适应、critique 初始频率下调
- [ ] 验收：openPangu-7B 可跑通 maintenance 演示；1B 报告能力边界

## P5 — 国产软硬件亲和（资源/部署文档 + 演示）
- [ ] 昇腾 310P/910 与 vLLM-ascend / MindIE 接入步骤；麒麟/其他国产 OS 运行验证
- [ ] 资源预算表（1B/7B 显存、int8、上下文窗口、token 成本核算）

## P6 — 内部存储名/品牌全量收敛
- [ ] `.panshalach.json`→`.panshalach.json`、`.panshalach-memory.json`→`.panshalach-memory.json`、`~/.panshalach/`→`~/.panshalach/`、`PANSHA_*`→`PANG_*`（一次性迁移脚本 + 读旧写新 fallback）
- [ ] `PanshalachChaser.ts`→`Panshalach.ts`、bin/文案扫尾

## P7 — 真实 openPangu 评测 → EVALUATION.md 填数（命题提交物 2）
- [ ] 评测任务集脚本化（T1 约束保持 / T2 跨文件关联 / T3 长文档跨章节 / T4 中断续接 / T5 压缩后保持）
- [ ] A/B/C 三档真跑（无记忆 / 记忆卡 / 全能力=P2+P3 后），记录模型版本/端点/种子/成本
- [ ] 结果回填 docs/panshalach/EVALUATION.md 各表 + 分析叙事；提交物 1/2 定稿

> 依赖顺序：P1 → P2 → P3 → P4 → P5；P6 可与 P1 之后任意并行；P7 依赖 P2/P3（全能力档）。
