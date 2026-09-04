# Panshalach 命题交付 ROADMAP

> 现状：可见层已重命名 Panshalach、旧 Zorge 文档已物理清理、命题文档集已就位（见 docs/panshalach/）。下列为让"命题叙事成立"的后续里程碑，按依赖排序。

## P0 ✅ 已完成（2026-09 本期）
- [x] REFACTOR-ASSESSMENT.md 重构评估报告
- [x] 物理删除 docs/ 全部 Zorge/GLM/30-rounds 旧文档与 docs/agents、.agents
- [x] docs/panshalach/ 命题文档集（README/ARCHITECTURE/MEMORY-DESIGN/EVALUATION/USER-GUIDE/ROADMAP）
- [x] 可见层改名 Panshalach（package/bin、欢迎/身份串、server 文案、memory 标题、tier 描述、/init 文档指针）；62 组测试通过

## P1 — openPangu 泛化接入（代码）
- [ ] `.zorge.json` example 加 openpangu provider（本机/昇腾 OpenAI 兼容端点）
- [ ] ModelProvider：新增 `PANG_OPENPANGU_BASE_URL / PANG_OPENPANGU_API_KEY / PANG_MODEL` env；bare-name 不再默认走 scnet；GLM shorthand 保留为可选别名
- [ ] `ModelCommand /model list` 改为遍历全部 provider 拉模型（去 scnet 独占文案）
- [ ] `openai-compatible.complete` 透传并返回 `message.tool_calls`（ModelClientOutput）；VerifyCritiqueLoop 已支持
- [ ] GLM 措辞泛化为"工程纪律"（StructuredReasoner 铁律头 / 负向清单 / adapter 注释）
- [ ] 验收：配置 openpangu 后可 `/model list` 看到 openPangu-1B/7B/7B-VL 并运行一次真任务

## P2 — 记忆写入闭环 + markUsed（最高价值、最快见效）
- [ ] 任务落定调用 `RefinedMemoryStore.refine({trajectory, taskStyle, applicableTiers, attemptCount, userFeedback})` → `save()`（REPL executeTask / runAgentTask / sseInteractive 回合落定）
- [ ] `markUsed(cardIds)`：注入命中卡在任务边界批量刷新 lastUsedAt（修"读即用永不衰减"）
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
- [ ] `.zorge.json`→`.panshalach.json`、`.zorge-memory.json`→`.panshalach-memory.json`、`~/.zorge/`→`~/.panshalach/`、`ZORGE_*`→`PANG_*`（一次性迁移脚本 + 读旧写新 fallback）
- [ ] `ZorgeChaser.ts`→`Panshalach.ts`、bin/文案扫尾；`Glm53SweProChaser`/`zorge` bin 保留 deprecated alias

## P7 — 真实 openPangu 评测 → EVALUATION.md 填数（命题提交物 2）
- [ ] 评测任务集脚本化（T1 约束保持 / T2 跨文件关联 / T3 长文档跨章节 / T4 中断续接 / T5 压缩后保持）
- [ ] A/B/C 三档真跑（无记忆 / 记忆卡 / 全能力=P2+P3 后），记录模型版本/端点/种子/成本
- [ ] 结果回填 docs/panshalach/EVALUATION.md 各表 + 分析叙事；提交物 1/2 定稿

> 依赖顺序：P1 → P2 → P3 → P4 → P5；P6 可与 P1 之后任意并行；P7 依赖 P2/P3（全能力档）。
