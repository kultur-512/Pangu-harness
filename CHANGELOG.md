# Changelog

## 0.6.0 (全面改名：烛龙 Zhulong / 盤沙拉克 Panshalach)

### 模型接入：tool_calls 透传 + 多模型源（2026-09-04 df7a119）
- `openai-compatible.complete` 返回 `string | {content, raw, toolCalls, detectedFormat:'openai-json'}`；SSE `delta.tool_calls` 按 index 增量拼装（修复 `[DONE]` 早退跳过拼装）；支持 `providers.<name>.headers`
- chaser 流式 wrapper 聚合 toolCalls chunk 后返回结构化对象；`VerifyCritiqueLoop` 的 `preParsedToolCalls` 消费通道零改动
- env 三件套泛化 `PANSHA_<PROV>_API_KEY/_BASE_URL/_MODEL`（`SCNET_API_KEY/SCNET_KEY` 保留为 scnet 历史别名，行为不变）；`getModelContextLength` 跨 provider；裸名路由泛化
- 新增 `providers.<name>.apiKeyCmd`（借鉴 claude-code apiKeyHelper：stdout 首行作密钥，成功缓存，显式 apiKey 优先）
- 删除死代码：`ScnetClient.ts`/`UniversalMaoyulinClient.ts`/`maoyulin-client.cjs`/`probe-scnet-real.mjs`（内含硬编码密钥，git 历史仍在，**需服务侧轮换**）/`probe-maoyulin-models.cjs`；`verify-scnet.mjs` 改配置驱动任意 provider
- 接口契约 v2 类型：`AgentEvent`/`Assertion`/`TaskState`/`SourceRef`（`src/cli/repl/types.ts`）；rolloutStore 增 `agent` 事件 schema

### 记忆与上下文 v3（2026-09-04 bf5f4a7，两轮对抗批判收敛）
- 修复衰减锚：`calculateEffectiveWeight` 取 `max(lastSeen, lastUsedAt)`（旧 `??` 短路使复发卡的 lastSeen 刷新对衰减不可见）
- `markUsed` 二态化：`markInjected`（注入纯记账，不影响衰减/count）/ `markVerified`（原位刷新 lastUsedAt+count+1，直写持久化）；markCited 推迟（[M1] 卡号引用协议已就位）
- `loadFiltered` 过滤 `archived` 卡（merge 软删真正退出注入）
- PromptBuilder：记忆卡注入带 `[M1]` 连续编号（顺序==lastInjectedCardIds，跨 L1/溢出块单一序列）；修复 `getRecentContext` "score=score=NN" 双前缀
- compact：`CompactResult` 增 `generation(turnCount,lastTurnId)`/`coveredTurnIds`/`summarySource`/`syntheticTurn`；apply 按覆盖账本安全合并（修复快照→apply 间新增轮静默丢失）；血统断开（rewind）拒绝 apply；摘要来源显式化
- rolloutStore：新增 `compact`（自足标记，replayInto 消费后 resume 无模型重建压缩态）与 `context`（逐任务注入审计：promptHash/injectedCardIds）事件；`readAgentEvents`/`readContextSnapshots` 有界读取；`listRecent` 单文件扫描上限
- `runAgentTask`：逐任务 ContextSnapshot + `memory_injected` 事件 + markInjected 双账本对齐（best-effort）
- 新增测试：`tests/memory/MemoryMark.test.ts`、`tests/repl/ContextMemoryV3.test.ts`、`tests/repl/ModelProviderEnv.test.ts`（全套 529 例）

### 文档（2026-09-04 6b7cb5e）
- `docs/panshalach/SUBMISSION.md` 国创赛项目书骨架（≤1000 字概述占位 + 大纲 + 创新点按"claim 指向已落地工件"表述）
- `docs/panshalach/EVALUATION.md`：C 档口径对齐（语义检索单列 C4 消融档）；记忆卡利用率口径二选一写死；测试数以 `npm test` 实际值为准
- `tasks/context-memory-proposals-2026-09-04.md`：两方案 + 两轮 3 视角对抗批判 + 终稿裁决 + 已知遗留 + 评测防线留档

### 模型层去模型品牌特化（openPangu 泛化）
- `src/cli/repl/ModelProvider.ts`：删除 bare `glm`/`glm5` magic shorthand、`_pickBestGLMModel` 及 `listModels` 里 `glm` 伪入口；泛化为 `_pickBestProviderModel(providerName)`（取指定 provider 模型列表第一个可用）；`getEffectiveModel` 对 `provider:model` / `provider:` / 裸 provider 名做通用解析
- `src/cli/repl/commands/ModelCommand.ts`：description/usage/提示文案去旧品牌特化（保留 `/model list` 与 scnet 密钥引导，scnet 作为合法 OpenAI 兼容 provider）
- 测试与脚本：`tests/repl/*` 示例模型名改中性（`openPangu-7B` 等）；旧 brand 专属验证脚本删除；`scripts/sandbox-test-runner.ts` 等脚本旧品牌注释清理

### 命名体系（用户指示）
- **外部产品名**（用户/市场看到）：**烛龙**（Zhulong）—— CLI 启动、欢迎语、模型身份串、对外文档标题
- **内部项目代号**（代码/存储/包名/env）：**盤沙拉克**（Panshalach）—— package name、类名、存储目录、`.env` 前缀
- **最高档位**：原 `zorge` 档位 id 改名为 `pangu`（呼应 openPangu），旧值 `zorge` 保留为 alias（TIER_ALIASES 兼容既有会话/配置）

### 全面改名落地
- 类/文件：`src/ZorgeChaser.ts` → `src/PanshalachChaser.ts`；UI 组件 `ZorgeApp.tsx` → `PanshaApp.tsx`；`src/Glm53SweProChaser.ts` 兼容别名 stub（早期模型试点时期的遗留）同步指向 `PanshalachChaser`
- bin：`{ zhulong, panshalach, zorge }` 三个别名指向 `dist/cli.js`；外部默认走 `zhulong`，旧别名保留
- 存储：`.zorge.json`→`.panshalach.json`；`.zorge-memory.json`→`.panshalach-memory.json`；`~/.zorge/`→`~/.panshalach/`（含 sessions/rollouts/file-history/skills）
- env：`ZORGE_*`→`PANSHA_*`（含 `PANSHA_HEADLESS/PANSHA_MODEL/PANSHA_SERVE_TOKEN/PANSHA_CTX_WINDOW/PANSHA_EXEC/PANSHA_SMOKE/PANSHA_SKILLS_USER/PANSHA_USE_LEGACY_PARSER`）
- 题面渲染：welcome `Zhulong Interactive Shell（烛龙）` + 提示符 `Zhulong [tier]` + 身份串"你是烛龙（Zhulong）…" + SSE log `[zhulong]` + MemoryManager 标题

### 文档同步
- 根 README、CHANGELOG、REFACTOR-ASSESSMENT 重写为双名体系
- docs/panshalach/* 六份命题交付文档（README/ARCHITECTURE/MEMORY-DESIGN/EVALUATION/USER-GUIDE/ROADMAP）标题与品牌段对齐"烛龙（Zhulong）· 内部代号 Panshalach"
- 配置示例 `.panshalach.json.example` 命名/路径同步

### 迁移
- 写出 `scripts/migrate-panshalach.mjs`（一次性）：读旧 `.zorge.json`/`.zorge-memory.json`/`~/.zorge/{sessions,rollouts,file-history,skills}` → 写入新 `~/.panshalach/...`（仅当目标不存在，避免覆盖）
- 用户首次升级运行：`node scripts/migrate-panshalach.mjs`

### 说明
- 类名 `PanshalachChaser` / bin `panshalach` / `ZORGE_*`→`PANSHA_*` / `Zorge`→`Panshalach` 全部由批量脚本一次完成（见 scripts/rename-panshalach-bulk.mjs 留档，可作后续一致性核验脚本）
- 兼容别名：`zorge` bin 与 TIER_ALIASES `zorge→pangu` 保留；`Glm53SweProChaser` 兼容 stub 与 `scripts/test-glm-shorthand.mjs` 已删除。
- 命题提交物 1/2 见 docs/panshalach/ARCHITECTURE.md 与 EVALUATION.md。

## 0.5.0 (Panshalach 命题化重构)

### 品牌与命题定位
- 上一阶段：项目对外品牌 Panshalach（package name/bin `panshalach`；保留 `zorge` bin 与内部存储名作为兼容别名）
- 定位改为：基于 openPangu 的记忆增强长程上下文智能体（软件工程长期维护场景），贴华为 openPangu 命题
- 可见层文案更名：欢迎语/提示符/模型身份串（你是 Panshalach…）/SSE server 文案/memory 管理器标题/pangu 档位描述/`/init` 文档指针

### 文档重建
- 新增 [REFACTOR-ASSESSMENT.md](REFACTOR-ASSESSMENT.md)：现有代码逐模块对照 openPangu 命题的重构评估与 P1–P6 改造路径
- 新增 docs/panshalach/ 命题文档集：README / ARCHITECTURE（提交物 1 雏形）/ MEMORY-DESIGN / EVALUATION（提交物 2 骨架，待真实 openPangu 数据）/ USER-GUIDE / ROADMAP
- **物理清理**旧 Panshalach/早期模型试点/30-rounds 文档（docs/ 下全部规划/复盘/归档）与过时流程元数据（docs/agents、.agents）
- `.panshalach.json.example` 改为 openPangu provider 示例

### 说明
- 内部存储名 `.panshalach.json` / `.panshalach-memory.json` / `~/.panshalach/` / `PANSHA_*` / `PanshalachChaser` 本轮保留（会话资产兼容），收敛计划见 docs/panshalach/ROADMAP.md P6
- openPangu 记忆写闭环 / 事件记忆 / 任务状态机 / 语义检索 / 真机评测 为 P1–P7 后续里程碑（见 ROADMAP）

## 0.4.0 (dogfooding 战役)

### 新增
- --headless 逃生口（PANSHA_HEADLESS=1 / pangu --headless：非 TTY 真实执行，SMOKE 仍最高优先）
- maxHunks 参数（diff 工具：ctx 不计 + 全替换豁免）

### 修复
- computeLineDiff contextLines=0 泄漏折叠标记
- looksBinary off-by-one 边界（31 vs 32）
- stringWidth ZWSP/ZWNJ/word-joiner 宽度（1 → 0）

### 测试
- 二进制边界测试（0x1F/0x20、0x08/0x09）+ 回归守卫
- --headless 4 用例；基线 303 → 309

### 工程
- dogfooding 实战检验（T1-T7，8 条短板；报告已随旧文档清理归档，历史见 git）
- 杂项清理（.sandbox-test/、根目录 test-*.mjs、probe-*.cjs 移出追踪；probe 保留于 scripts/ 且密钥剥离）

### 修复（短木板 #9）
- 负向工具清单注入（`<negative_tool_list>`：iron_law_check/thinking/plan/critique 声明非工具）
- UNKNOWN_TOOL 运行时护栏（TOOL_FORMAT_ERROR 记账 + 意图引导 + 连续 3 次硬停）
