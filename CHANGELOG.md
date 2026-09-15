# Changelog

> **当前状态（2026-09-15）**：v0.8.8 · tsc 干净 + `npm test` **1405 例全绿（1404 通过 + 1 跳过）**（concurrency=4，CI 已挂 test 门）+ eval 冒烟 A/B/C/C4 全过 · **90 题 LongMemEval 交付口径**：ZL×M3 strict 47/90（新纪录，超 CC×M3 41/90）为旗舰基准，ZL×7B 31/90 本地最优，ZL×1B 23/90 为 1B 基线（详见 `scripts/eval/longmemeval-90/COMPARE-90.md`） · 未完成项见 [docs/panshalach/ROADMAP-NEXT.md](docs/panshalach/ROADMAP-NEXT.md)。
> 注：0.7.x 及更早历史段落中引用的 `docs/panshalach/` 方案文档（PLAN-*/GAP-MATRIX/HERMES-ALIGN/UI-UX-REVAMP/REFLECTION/USABLE-PLAN/ALIGNMENT-REVIEW/FIX-0.7-*/PROJECT-BRIEF/ROADMAP 等）已于 2026-09-12 归档至 `archive/2026-09-12-process-docs/`——历史正文按当时路径原文保留，不回改。

## 0.8.7 token 口径收口（2026-09-15 · zhaiyuanhao1）

token 估算器口径审查（对照目标模型中文原生 tokenizer 实测 token/字 比）→ 两包并行实现 + 子代理 review（9 项全 pass、无阻塞缺陷）→ 全量 1383 例绿（1382 通过 + 1 跳过）。

- **文本路径裁剪口径收口**：`VerifyCritiqueLoop` 的 `pushToolMessages` / `buildHistoryPrompt` / `capStepPart` 从旧 `windowTokens*4` 字符预算统一到 `estTokens` + `sliceToTokenBudget`——messages 通道本就 CJK 感知，文本通道此前对中文按 4 字符/token 低估 ~6 倍；纯 ASCII 行为 ≤1 token 内等价
- **CJK 系数 1.5→1.0 可配**：`estTokens` 的 CJK 系数抽成 `CJK_TOKENS_PER_CHAR`（默认 1.0，`PANSHA_CJK_TOKENS` 进程启动读一次覆盖，`setCjkTokensPerCharForTest` 测试 seam）。1.5 是按 LLaMA 系定的，对目标模型（openpangu/Pangu·MiniMax-M3·Qwen3·DeepSeek-R1，中文实测 ≈0.6~1.0 token/字）高估 ~1.5~2.5 倍 → 压缩/裁剪提前触发、浪费上下文容量；1.0 是真实区间上界，仍安全（70% 预算线 + 溢出应急档兜底）
- 测试更新：`tokenEstimate`/`compactService` 断言随系数更新；`CjkBudget` 两条「每条 ≤ 单条封顶」断言放松为「总账 ≤ 70% 窗口 + 至少一条被二级截断」（对齐 `enforceMessagesBudget` 真实契约，review 核验非掩盖 bug）
- **90 题复验（归因隔离）**：ZL×1B 19/90（vs it3-1b 20/90，噪声内无回归）· ZL×M3 **47/90**（vs gapfix-m3 41/90，+6）· 单变量隔离 `PANSHA_CJK_TOKENS=1.5` vs 1.0 → 46 vs 47 → **token fix 系数贡献 +1，其余 +5 为中间记忆/检索迭代**（factDate 重排/C4 数字句前置/R2 预算/B9 relTime/MMR 默认关闭，此前未单独在 M3 验证）。结论：token fix 是正确性收口（文本路径中文不再低估 6 倍、系数不再高估 1.5-2.5 倍），非 benchmark 提分杠杆；M3 47/90 新纪录主要来自记忆/检索迭代

## 0.8.5 全适用性迭代（2026-09-14 · zhaiyuanhao1）

三路探查（中文适用性 / 非评测场景 / 遗留核销）→ 两包串行实现 → 子代理 review（16 项：1 必须返工 + 7 建议，全部处置）→ 全量 1253 例绿 → 英文回归守护轮 strict 16/90 无回退（`55526d7`）。

- **中文检索双通道打通**（探查实证：中文无空格 → 关键词恒整句 → 词面永不命中 + 语义闸 `kws≥2` 恒闭 → 排序退化纯新近度，而 embed 底座中文区分度实测优秀）：关键词抽取 CJK 分支（标点切短句 + 2-gram 词粒度 + 单位词白名单 + ASCII 段保留）· 语义闸对含 CJK 查询放宽 · `MAX_PHRASE_CHARS` 20→8（干扰卡用例实证：粒度不足时双方 rel=0，新近度顶掉 gold）· 查询稀释修复（issue 双拼主导 + 最近 2 轮各截 60 字——77 字无关前缀曾把 gold cos 0.119 砸到 0.030）
- **chat 最近对话原文**：`【最近对话】`段（≤600 字符）贯通 chaser chat user——修多轮指代（"那第二个呢"）零上下文硬答；`RECENT_TURN_WINDOW` 常量与查询构造同源
- **数据防御**：`load()` statSync size+mtime 基线（跨实例静默抹卡洞，CrossInstanceCache 5 例锁定）；cardVectorCache FIFO 帽 1024
- **出口一致性**：auto-pull 按意图门禁（chat 不再白耗嵌入计算并虚报注入账本——实测 ids 17 vs 可见 12）；L1 ghost 去 `
` 使 chat 块含"另有 N 张"提示（L2 有意保留并注释防误统一）
- **遗留核销**：对卡 confidence 0.7A+0.3Q 加权（双侧 max 使软惩罚几乎永不生效）；老格式互去重 / B2 判别力测试补强；旧评测 harness 冻结弃用注释（假日期污染在旧脚本存活，已声明仅用于复现历史成绩）
- 排序公平性修正申报（review 纠正算式）：对卡 effBase 出局门修复的真实载体是 dialogue-pair 基线 0.85（`decayWeight ?? weight` 优先级证伪 weight 路径，三处注释已按正确算式重写）
- 新测试：ChineseRetrieval 25 + ChatUserAssembly 9 + CrossInstanceCache 5 + LegacyFormatDedup 4 + ChatFactPairConfidence 3 等

## 0.8.4 记忆架构优化（2026-09-14 · zhaiyuanhao1）

三路架构探索（写路径实证 84.5% 句子丢弃率 / 检索召回实验 / 时间性失败归因 9/15 假日期污染）→ 两包实现 → 子代理 review（16 项：1 必须返工 + 4 建议，全部处置，含一处实现注释算式纠正与一处自引入回归回退）→ 全量 1162 例绿 → 90 题度量 strict 13→15（`7e1acd7`）。

- **时间锚定**：sessionDate 参数贯通播种链（评测回放不再把记录时间冒充事实时间）；卡带 `factDate/factDateText`；stable 段与 chat directive 注入"今天是 X"；悬空 `[S日期]` 规则替换为事实时间差值规则——temporal-reasoning 产品管线首次得分（0→1）
- **宽进严排**：对卡（Q/A 对）为主落卡单元无条件落卡；`isFactSentence` 从硬门改 confidence 分类器（句级补充卡 ≥0.7 才发）；80 帽硬拒绝删除（新进旧出交存储层 kind 分桶淘汰）；配对牵连修复（user 噪音不再连坐 assistant）；分句器缩写保护（Dr./e.g. 不再切碎）
- **混合检索**：embed.ts 4096 维 n-gram 语义接入 loadFiltered（两步归一防量纲压制；keywords<2/异常自动回纯词面；投影 key 含查询防串槽；进程级向量缓存）——`PANSHA_SEMANTIC_SEARCH=0` 显式关闭
- **窗口感知注入**：固定卡数帽改窗口比例预算（8K≈10% / 大窗 15%、1600 token 帽）+ 渲染后实测 token 贪心门（对卡实际 122-470 token/张，纯张数帽超发 3-11 倍——review FAIL 实测后返工）；A 行渲染与写侧 smartSlice(400) 同源；`PANSHA_MEMORY_LIMIT` 显式时行为不变

## 90 题 LongMemEval 交叉对比（2026-09-13/14 · zhaiyuanhao1）

题集 = oracle 500 题确定性抽样 15/型×6（48 题集超集）；同 runner 同播种归因纪律；判分 strict（主口径：多候选拆分+复述豁免+词边界）/lenient（数字回退）双口径；六格 harness 矩阵（CC×M3 / Pi×1B / 烛龙 product·direct·pipeline·compact）+ 修复 A/B 轨迹（`3b61ea3`、`c16a2dd`、`55526d7`）：

| 轮 | strict | 说明 |
|---|---|---|
| baseline | 9/90 | 修复前代码 |
| repaired | 13/90 | 0.8.3 修缮批次 |
| optimized | 15/90 | 0.8.4 记忆架构优化 |
| **optimized2** | **16/90** | 0.8.5 全适用性迭代（回归守护轮） |

六格同题对比：CC×M3 31/90 · ZL-compact（1B，无门控播种+检索）26/90 · ZL-direct = Pi（1B）20/90 · ZL-pipeline 14/90。关键发现：烛龙系 1B 最强配置是"宽进播种+检索注入"；preference 题型全格 ≤1 属判分盲区（自由文本偏好 vs 子串匹配）；M3 与 1B 绝对分不可直接归因 harness。全量报告见 `scripts/eval/longmemeval-90/COMPARE-90.md`。

## 0.8.6 工具调用配合度 + 压缩检索迭代（2026-09-14/15 · zhaiyuanhao1）

**工具调用配合度**（三路探查实证：模型=示例复制器，schema 措辞/工具数量零效应，few-shot 示例工具族唯一杠杆；文本协议下参数名不可见→参数幻觉 100%）：格式教学重构（read_file 示例恒有+按意图追加+参数名从 schema 取+中性占位+V1 实证措辞+每工具速览行）· 参数名别名归一（executor 中心化+engineAdapter gate 前应用，堵敏感写检查旁路）· 解析器四修补（全角归一/属性式参数/首标签错配救援限闭合后兄弟块/双调用拆分）+ rootless 兜底（已知工具标签开头丢壳三重门控救回）· 失败恢复三级阶梯（教学全文→具体实例短命令→终局）+ INVALID_PARAMS 回灌正确参数名 + guardrails 停滞闸按归一名计数 · 意图门补检索/枚举动词（英文  词边界）+ execution 零工具 answered 不计 success + 假验证收紧。**1B 实测：首步出块+正确工具 5/5（修复前 3/5 且 edit 参数幻觉 100%）、零 UNKNOWN_TOOL；解析/执行口径调用成功率 100%**（20 畸形形态全接住）。

**压缩与检索迭代**（67 失败题四类归因驱动）：R1 打包 break→continue · C1a 注入块 factDate 升序重排 + C1b 规则行补冲突事实取最新（修 KU 新旧值反向误导，KU 3→6）· L1 规则行答案语言镜像 · R2 8K 档预算 10%→15%（819→1229；归因实证 819 只装 3.8 张对卡）· C2 对卡 A 行渲染 smartSlice（it2 实证 400 裁剪对 assistant/user 题型净损失，迭代回退至与写侧同源 800）· C4 smartSlice 数字句前置 + gold 丢失边界回退。90 题三轮严格对照 23→22→20（方差 ±3）：**管道优化进入 1B 方差噪声区的诚实记录**，temporal 0→2→3→4 单调上升为真实管道增益；模型升级验证轮 ZL×7B 31/90 超越 ZL×M3 29/90（本地 7B 为性价比最优交付配置）。

## 修缮批次（2026-09-13 · 对抗性审查修复 zhaiyuanhao1）

对抗性审查（四路子系统深审 + 双路独立复核 + 新测试旧代码验红）确认 3 P0 + 12 P1 + 全部 P2，本轮全量修复（约 50 文件，新增对抗性回归测试 118 例——每项修复先在旧代码上断言级验红再转绿）：

- **fix(tools) 审批与沙箱**：工具名统一 normalizeToolName 归一（堵 `write`/`edit` 别名绕过 readonly/plan 档审批与 checkpoint/写锁）· readonly 白名单补 `
`/反引号/`$`（堵换行连击与命令替换逃逸；`%` 不收防误伤 `--format=%h`）· 'a' 决策对 bash 改会话内放行且 dangerous 仍强制审批、不再把整个 bash 持久化落盘 · checkpoint realpath 校验（堵工作区内 symlink 把工作区外文件外拷进历史目录）· 敏感清单补 `.panshalach.json`/`.git` · DANGER_PATTERNS 补漏（push -f 独立 flag / rm 分离旗标 / Remove-Item）· grep 5MB 读取上限 · rewindToTurn 逐文件容错 + 半回滚汇总 · redact 扩 Bearer 全值/AKIA/ghp_/私钥块并接入 grep 输出 · UserConfirmation 非 TTY 守卫 · mcpClient 树杀 + 审批 timer 局部化
- **fix(loop+model) 循环与计量**：messages 二级收缩改 estTokens 反推 + 64 次迭代上限 + 进展检查（堵纯中文巨工具结果的收缩定点死循环——P0，生产常量复现 18 万次迭代不终止）· estTokens CJK 范围扩至中文标点/全角/Ext-A/假名/谚文 · classifySignal 残余全文 includes 全部尾锚定（堵 ALL_TESTS_PASSED 正文误判假成功）· readonly 拒绝改段尾结构化标记 `[TOOL_DENIED_READONLY <tool>]`（堵正文含字面量误计数的假硬闸）· recordResult 仅写工具成功才清零跨工具拒绝计数（堵读写交替饿死阈值 2）· errorClassify 无 status 正文判 overflow + /billing/ 收窄（429 限流文案不再被误杀不重试）· 多调用分段不整段复制 · B4 kept 收缩落 coveredTurnIds 账本（resume 不再复活已收缩轮）· 模型摘要路径嵌套封顶 · compact cancel 竞态复查 · safeSlice 码点安全截断全截断点换用
- **fix(memory) 记忆系统**：容量分桶按 kind 治理（failure 40/类内每 category 10 · success 10 · preference 80——chat-fact 卡以该桶承载；pinned 免淘汰）——旧实现所有正向卡挤 category:'OTHER' 一个 10 张桶，"80 张对话记忆/总 200" 声明不可达、第 11 张起静默截断 · recordFactLines 返回真实落盘数（不再谎报截断前候选数）· load() 形状校验 + 损坏文件 quarantine（`.corrupt-<时间戳>`，不再静默清库/毒化）· 7 处写盘换 atomicFile（tmp+rename，复用 taskState commitAtomic 抽共享模块）· taskState env 绝对路径直采（对齐 1d75f73 修复的同类 bug 在此残留）· isFactSentence 词界（旧正则实为字面退格符死代码）+ chat-fact 去重键剥离时间戳前缀（堵跨分钟重复落卡）· `/memory stats` 注入审计视图（按 kind 卡数/注入账本/最近注入事件）· markInjected 进程级账本持久可查（不再一次性实例记账即弃）· 事件流尾部读取（超 5000 条最新事件可见）· /memory import 形状+大小校验 · mergeSimilarCards NaN 防护 + 停用词修正 · classic REPL 接 recordChatFact（chat 直答事实沉淀此前在此路径静默缺失）· PromptBuilder 卡 id 注入契约修正
- **fix(adapter+model) 适配器与模型层**：容错切分不再砍尾（漏写 `</>` 的块此前被无条件切掉末 3 字符——弱模型深层残缺形态最后一个参数静默丢失）+ 残缺闭合标签 best-effort 提取 · 流式 tool name delta 幂等合并（方言网关整名重发不再拼成 `write_filewrite_file`）· 非流式 body 读取纳入超时 + SSE 整体 deadline（`streamDeadlineMs` 可注入）· Retry-After ≤30s 按服务端、>30s 最多补试 1 次（不再钳 30s 连锤 6 发）· 空回复改占位标记（不再把原始响应 JSON 灌进上下文）· SSE 尾行无换行 flush（usage/[DONE] 不再丢、不再误触发非流式重发双请求）· ProviderRegistry 前缀剥离单点化且仅剥已配置 provider 名（防误剥 Ollama/LM Studio 含冒号目录名）· 死代码归档（RateLimiter/universal-tool-parser.cjs/XmlStructuredToolParser/demo×2 → `archive/2026-09-13-adapter-model/`）
- **chore(ci)**：新增 `.github/workflows/ci.yml`（install + tsc + `node --test --test-concurrency=4`，失败自动重跑一次规避已知进程级假象）——此前仓库 CI 只有分支保护检查，npm test 从不被 CI 执行
- **feat(eval)**：90 题 LME 基建 `scripts/eval/longmemeval-90/`（确定性抽样 15/型×6 + 产品管线 runner——recordChatFact 同源播种 + headless QA，弃用评测复制品直写存储路线 + 统一判分器 strict/lenient 双口径/复述豁免/数字回退）；90 题修复前基线 **strict 9/90**（平均落卡 8.3 张——旧 OTHER 桶 10 张帽的实证）

**质量门**：`npx tsc --noEmit` 干净；`node --test --test-concurrency=4` **1162 例 1161 pass + 1 skip + 0 fail**；`smoke-eval.mjs` 20/20；三组安全 payload（别名写/换行命令/命令替换）在旧代码实证绕过存在、修复后全部拒绝。

## 0.8.8（事件层 B7 销项 + B11 通道记忆覆盖 · wangzuo1）

**B7——`rolloutStore.ts` 三项工程遗留**（ROADMAP-NEXT §B7，评测工程底座）：

- **rewind 事件 replay 消费**：`replayInto` 新增回退边界处理（number=回合 timestamp / string=回合 id / 'last'）。此前 rewind 只写审计、resume 时跳过——回退后恢复会话会**复活已回退的轮次**（会话比真实历史长）。现按事件流顺序消费，回退后新写轮次、再压缩均与在线状态一致；目标不存在时不修改会话（审计事件保留）
- **compact 标记幂等**：同一压缩标记重复回放（resume 重入 / 在线 apply 后再 replay）不再产生重复合成轮——按 `syntheticTurn.id` 先剔除历史副本再插入；重叠覆盖区间的多枚标记整批重放结果稳定
- **分支解析降复杂度**：新增 `buildBranchIndex()` 单次扫描（每个 jsonl 只读一遍抽 meta.branchOf），`listBranches`/`directBranches`/`listSessionTree` 复用该索引——原实现对每个文件调 `isBranch` 且逐级向上读祖先文件，为 O(文件数 × 链深) 次整文件读；现为 O(文件数)。结果语义与旧实现一致（top-most origin 聚合 / 直接子节点 / 树结构 / 损坏行容错均不变）
- 回归：新增 `tests/repl/rolloutB7.test.ts`（9 例：回退边界 4 / 幂等 3 / 分支索引 2）

**B11——classic REPL 与 complete-only 回退通道的 chat 记忆覆盖**（ROADMAP-NEXT §B11，源码 2026-09-14 已申报的两处缺口）：

- **complete-only 回退通道**（`PanshalachChaser`）：仅有 `complete()`、无 `chat`/`streamChatMessages` 的客户端在 chat 意图下此前**零记忆零上下文**直答。现 chat 分支的 `basePrompt` 内联「记忆块 + 【最近对话】段 + 用户原话」——与 messages 通道的 user 组装同序同内容，两通道行为对齐（messages 通道不受影响，仍走独立 system/user 分离）
- **classic REPL**（`Repl.ts`）：此前把整段 `enriched` 当 `issueDescription` 传给 chaser，chat 的 system/user 分离、记忆块、【最近对话】段全部缺失。现与 `runAgentTask` 同款：chat 意图传**原始输入** + `chatMemoryBlock` + `chatRecentTurns`
- 回归：新增 `tests/repl/ChatClassicCoverage.test.ts`（3 例：段齐全 / 顺序固定 / 无段时不注空块头）

**B5——MCP 工具结果验证尾标策略**（ROADMAP-NEXT §B5）：

- **MCP 结果不追加任何验证尾标**（`engineAdapter.describeResult`）：MCP 工具走独立分支（`MCP_OK:` 前缀）并显式跳过 VERIFICATION 尾标——MCP 服务自述的输出（"已完成/成功"）没有外部退出码佐证，追加 `VERIFICATION: PASS` 就是让第三方工具凭自述伪装真实验证（`classifySignal` 的 PASS 是 `completed` 唯一来源，闭合会直接污染任务成功率）。规则落在尾部注释：将来 MCP 协议能带出结构化 exitCode 时再按类型追加（此处是唯一决策点）
- **连带修一个真误判**：MCP 名是命名空间形态 `mcp_<server>_<tool>`，`mcp_srv_read` 此前会命中 `name.includes('read')` 而被贴 `VERIFICATION: NEUTRAL`（=PARTIAL：清零连败计数、看着像部分验证）。现 MCP 分支前置于所有内置工具子串判定
- 回归：新增 `tests/tools/mcpVerificationTail.test.ts`（5 例：无尾标 / read 子串回归 / glob·grep 子串回归 / 内置工具尾标不变 / 同批互不串扰）

**B2-4——env-delta 增量跨任务真正生效**（ROADMAP-NEXT §B2 记忆审计剩余项）：

- **缺陷**：`prevEnvSnapshot` 此前是 `PromptBuilder` 的**实例私有字段**，而该实例在每次任务入口都被重建（`runAgentTask` 每调用 `new` 一个、`Repl.getPromptBuilder()` 每次执行任务 `new` 一个）→ 基线恒为 `null` → `buildEnvDelta` 永远走"首次快照"分支**只报 cwd**，"只注入变更字段"的增量语义从未生效（每任务白注入一个 cwd 行）
- **修复**：基线改挂 **`Session`**（`session.prevEnvSnapshot`，跨任务存活）；**有意不落盘**（`SessionFile` 无该字段——git status 是易变现场，跨进程回放陈旧基线会造假 delta），注释已写明
- 回归：新增 `tests/repl/EnvDeltaAcrossTasks.test.ts`（4 例：环境未变零增量 / 真变化只注入变更字段 / 基线写回 session 的本体断言 / 不落盘）

**质量门**：`npx tsc --noEmit` EXIT=0；全量 **1405 例（1404 pass + 1 skip + 0 fail）**；`verify-panshalach-cleanup` + `check-protected-files` + `verify-m2-e2e` 三契约 PASS。

## 合并记录（2026-09-12 · 四分支收口 develop）

合并窗口（操作：翟苑皓；顺序=主线先落、增量按冲突从机械到实质消化，每步全量验证门）：

1. `zhaiyuanhao1` → develop：fast-forward（25 提交，0.8.0-rc 全量 + 文档对齐）——968 例绿
2. `wangzuo1` 合入（b4ba061）：/memory events 查询子命令 + TaskState.record* 原语——并集 package.json 取 0.8.0-rc、CHANGELOG 0.7.5 段归位——977 例绿
3. `wanghaoyu1` 合入（5b15fb6）：U5 Repl 三口接线 + TurnStopReason 同步 + smoke-eval CI gate——runAgentTask 冲突并集：写集提取器取 trajectoryFiles 共享模块版（旧内联实现语义已全覆盖）、finalizeTaskMemory export 吸收——977 例绿
4. `zhaotianang1` 合入（403e6e8）：R5 task CLI 三子命令 + R6 follow-up + 集成——零冲突（wanghaoyu1 先合后 merge-base 前移）——**1008 例绿** + smoke-eval A/B/C/C4 冒烟全过

合并窗口后旧分支冻结，新工作自 develop 拉 <pinyin>2。master 发布由 kultur 在 R6 数据回填后执行。

## 0.8.0-rc 追加（对话链路治理 + CC 交互对齐 + 记忆链审计修复 · 2026-09-10 ~ 09-12）

M1/M2 落地后的真机驱动迭代（每项均有真机故障→根因→修复实证链）：

- **对话链路迭代**：chat 正文三端渲染修复 + 流式直答（streamChatMessages 增量透传）+ 意图收敛 + 答案落盘（b010b09）；chat 直答三级回落（streamChatMessages→chat→complete）
- **smoke mock 门摘除**：mock 仅 PANSHA_SMOKE=1 显式 opt-in，非交互默认真实执行（d91999f）
- **网关适配**：registry 透传 chat/streamChatMessages（M1 缺口）+ 网关 <think>/<thinking> 推理剥离（流式状态机跨 chunk 缓冲，chat 与 consumeChunks 双路）
- **意图分类修复**：显式写/续接请求优先于疑问与扩展名启发（"继续完成 memo.txt 任务"不再误判 search 只读）；isMeta 移除 run 前缀（"run npm install 会发生什么"不再被劫持执行）
- **栈溢出根因修复**：renderSseEvent default 分支自递归守卫（真机 Maximum call stack size exceeded 堆栈定位）+ drain 深度护栏 8 层
- **记忆链三缺陷治理**（0.8.1 对抗性审计）：产卡携带任务信息（通用卡零信息）/ markVerified 断链接通（injectedCardIds ∩ 真实写集）/ count 封顶 min(count,3) 防永生卡（b8b65b4）
- **UI/UX 三改进**：U1 spinner 帧动画 / U2 流式正文行缓冲 / U4 空闲状态行（模型·档位·模式·ctx%）
- **headless 多轮**：RunCommand turn 落盘 + one-shot --resume 支持（含 --resume last token 消费修复）
- **审批鲁棒性**：非 TTY（管道/CI）审批桥自动拒绝——不再挂 60s 等不可达 stdin
- **CC 级交互四件套**（真机对标 Claude Code 2.x）：①输入 / 即时斜杠菜单（过滤/↑↓ 导航/分组/滚动视口，07a3662）②档位环每档专属色徽标（plan 蓝/auto-accept 青/full 品红，回执/启动徽标/空闲状态行三处接线，1e8a77b）③/model 菜单化（编号直达/当前项绿色/列对齐）④/tier 思考强度水平滑杆（更快←→更强刻度 + ▲ 光标 + ←→ 调节 Enter 确认 Esc 取消 + ex/pangu 品红扩展区，5ea4a00）
- **身份画像通用化**：通用全能智能体（工程/对话/知识/创作皆为所长）——chat 直答指令不再以工程助手自居设限（真机实证：1B 模型把工程人设执行成拒绝历史话题）；档位语义限定为工程执行参数防复读；补"不编造事实数据年代"约束

Tests: tsc 干净；全量 968（967 pass + 1 skip + 0 fail）；verify-m2-e2e + check-protected-files 双契约 PASS

## 0.8.0-rc（M1 地基 + M2 执行层七项全量落地）

依据 GAP-MATRIX-0.8 交叉对比与 PLAN-0.8-FOUNDATION（换地基、保语义）：

- **M1-TurnController 四模块搬家**：sseInteractive.ts 2200→358 行（会话壳），新增 `src/cli/repl/turn/{TurnContext,TurnRenderer,CommandRouter,TurnController}`（共 1967 行）——零行为变更（455 行行为锁定测试全程绿）
- **M1-PROTOCOL messages 双通道**：`ChatMessage` + `ModelClient.chat/streamChatMessages` 加性接口；openai-compatible `toWireMessages` 单点映射（system 原样/assistant tool_calls 透传/tool role 按网关能力配对或文本降级）；loop 维护 messages 栈（system 一次 + assistant/tool 交替），双通道门（chat 能力 + `PANSHA_MESSAGES_MODE=off` 逃生门）；PromptBuilder 拆 stable/volatile 三段（stable→system 首条，任务间字节级相同→网关前缀缓存可命中）；`PANSHA_MESSAGES_MODE=off` 与 0.7.4 逐字节等价（deepEqual 锁定）
- **M2-1 工具并行分段调度**：只读段并发≤3 + 写/bash/MCP barrier 串行；结果/事件按原始序装配；批次 420s 超时
- **M2-2 卡死硬闸**（guardrails.ts）：同参数连败 5 阻断/同工具败 8 终局/幂等同结果 5 阻断——905s 空转家族最后栅栏
- **M2-3 工具结果落盘回读**：超 20k 输出写 scratch 目录 + persisted-output 预览；read_file 永不落盘
- **M2-4 真实 usage 计量**：网关 usage 字段解析 + onUsage 回调；len/4 降级 fallback
- **M2-5 错误分类器**：八类分类，auth/billing 快速失败；overflow→强制 compact→重试（≤1 次）
- **M2-6 敏感路径写保护**：.ssh/.aws/.kube/.git-credentials/.netrc/id_rsa*/.env* 全档位拒写 + undo 拒还原
- **M2-7 Turn.role 字段**：user/assistant 标注 + 旧格式迁移 + 摘要 prompt 用户原文逐字保留约束

Tests: tsc 干净；全量 847（846+1skip+0 fail，+98 例）；双契约脚本 PASS


## 0.7.5 (R4/R5 挂载收口：`/memory events` 查询子命令 + TaskState.record* 原语)

王佐 U3 收口（R4/R5 存储层自 0.6.5 落地后，此处补齐对齐清单里的"剩余项"）：

**R4 挂载：`/memory events` 查询子命令**（`src/cli/MemoryCommand.ts`）
- MemoryEventStore 此前"已落地但无入口"（ROADMAP/MEMORY-DESIGN/ARCHITECTURE 三处均记"`/memory events` 查询子命令未挂载"）——本轮补上。
- 用法：`memory events [--session <id>] [--kind <k>] [--task <id>] [--topic <t>] [--limit N] [--stats]`；缺省 session 回退最近 rollout 会话；`--stats` 给按 topic / 按任务的聚合视图。
- 纪律：只读（复用 R4 `MemoryEventStore.query/topicStats/taskSummaries`），不自行读 JSONL；空会话返回指引而非抛错。

**R5 接口对齐：`TaskState.record*` 显式记录原语**（`src/memory/taskState.ts`）
- 9/14 评审清单第 4 项 `TaskState.record* / getOrCreate`——`getOrCreate` 已于 11dbea3 落地，本轮补 `record*` 家族：`recordDecision / recordRisk / recordOpenQuestion / recordMilestone / recordVerified / setNextStep / setCurrentGoal`。
- 全部走 `update()`：沿用同一乐观锁（version 冲突抛错）与 `originalRequirement` 锚定纪律；`setNextStep('')` 清空而非留过期值（防误导）。
- 定位：语义原语（真实业务节点 / CLI 用户声明显式调用），不猜自然语言轨迹（与"禁止 NLP 抽取"同一纪律）。
- **R4 别名**：`MemoryEventStore.listTopics()`（= `topicStats().map(topic)`），对齐 9/14 清单签名 `MemoryEvent/listTopics`。

**Tests**: `npx tsc --noEmit` EXIT=0；`npm test` **758 例：757 pass + 1 skip + 0 fail**（新增 `tests/commands/MemoryEvents.test.ts` 6 例 + `tests/repl/TaskState.test.ts` record* 3 例）；`verify-panshalach-cleanup.mjs` PASS。
**Risks**: 无（加性：新增子命令 + 新增方法，未改既有路径语义）；`/task` CLI 仍属赵天昂 R5 另半，本批不涉。


## 0.7.4 (部署陈旧 dist 修复 + 中断语义修正 + `?` 透传 + hermes 二次对齐调研)

方案：`docs/panshalach/PLAN-0.7.4-FOR-CLAUDECODE.md`（控制人实测驱动）。用户跑的 zhulong 是 **09-06 00:03 的旧 dist**（0.7.1 批次 B 中途构建），0.7.2/0.7.3 全部修复只在 src——"莫名中断""explore/rollout 英文相位线""旧 `?` 输出"三个观测全是旧代码。"提交任务后莫名中断（235ms）"因果链：LM Studio 对 diffusion 模型（openpangu-7b-diffusion-base-i1）chat/completions 报 `Unexpected endpoint or method. Returning 200 anyway` → 200-garbage → `EMPTY_RESPONSE` → streamChat 回退裸 doComplete（无 withRetry/无 emptyResponse 捕获）穿透 → chaser catch 兜底硬编码 `stopReason='aborted'` → UI 渲染"已中断·现场已保留"。**模型错误被伪装成用户中断。**

**任务 A：部署修复**
- `npm run build` 重建 dist（0.7.1-0.7.3 全部 src 改动生效）。
- `src/cli.ts` 入口 `warnIfDistStale()`：任一 `src/**/*.ts` mtime 晚于 `dist/cli.js` 且交互模式（stdout TTY + 非 `PANSHA_HEADLESS`）时打一行黄字提醒"⚠ dist 落后于 src，请执行 npm run build"；headless/one-shot/生产无 src 场景静默；检查异常绝不阻塞启动。

**任务 B：中断语义修正（契约加性变更，REFACTOR-ASSESSMENT §4 申报 ⑦）**
- `src/cli/repl/types.ts`：`TurnStopReason`/`TurnOutcome` **加性新增 `'error'`**（模型/网络/解析异常），旧值语义不变。
- `src/loop/trajectory.ts`：`syntheticFailureTrajectory` 新增 `isAbortLikeError` 判定——`TASK_ABORTED`/`AbortError`/`aborted before dispatch` → `'aborted'`（真中断语义不变）；其余一切异常 → `'error'`（`lastError` 保留原始错误首行）。
- `src/model/openai-compatible.ts`：streamChat 三处裸 `doComplete` 回退（传输失败/非 200/流式无 delta）收敛为 `completeLikeFallback`——withRetry 包裹 + `emptyResponse` 重试耗尽转空串，与 `complete()` 同语义，消灭"三连发穿透"；`EMPTY_RESPONSE` 文案追加指引：`若使用 diffusion/embedding 类模型，LM Studio 对其 chat/completions 返回空体——请加载标准自回归对话模型`。
- UI 四态文案（`sseInteractive.ts` nextStepHint/mapSseToBridge/renderSseEvent、`Repl.ts`、`RunCommand.ts`）：`error` → "✗ 任务执行失败 · <lastError 首行截 120 字> · 下一步: 检查模型端点是否为对话模型（diffusion/embedding 不受支持）· 或重试"；`aborted` 保持"已中断·现场已保留"。
- `sseInteractive.ts` B6 死代码清理：`abortReject`/`abortPromise`/`Promise.race` aborted 分支整体移除（abortReject 从未被调用 → 分支永不可达）；真中断由 SIGINT → `currentAbort.abort()` → loop signal 检查 → `stopReason='aborted'` 链路承担；aborted turn 落盘并入统一路径，**顺带修复活路径不落 `partialText` 的缺口**。
- **队友注意**：`TurnStopReason` 枚举加性新增 `'error'`，rebase 后请同步本地认知；R6 schema（`scripts/eval/results/schema.mjs` `TURN_STOP_REASONS`）仍为 v0.6.5 方言（含 verification-failed-continue、缺 answered/error），评测 verdict 消费前需对齐（归 R6 域，本轮未动）。

**任务 C：`?` 行为（控制人裁决："输入问号也是给模型的信息，/help 再显示帮助"）**
- `sseInteractive.ts` 删除 line 主路径 `trimmed === '?'` 快捷帮助截获——`?` 作为普通任务文本透传给模型（taskIntent 分类为 chat → 单次直答）；`/help` 行为不变；`buildQuickHelpLines` 保留（/help 复用）；横幅第三行同步去掉 `? 快捷帮助` 字样。

**任务 D：hermes 二次对齐调研（纯调研不实施，`docs/panshalach/HERMES-ALIGN-0.7.4.md`）**
- 上轮未采纳项五项判定：telemetry 单行埋点 **推迟**（rollout jsonl 账本已承载，缺的只是观测粒度）；不对称压缩 **推迟**（须先给 Turn 加角色字段，与 R8 envelope 强耦合）；TurnController 抽取 **推迟**（sseInteractive 2152 行 L 级拆分须测试先行）；会话 append-only 化 **拒绝**（rollout jsonl 已提供崩溃安全，SessionStore 是非权威快照；hermes 自己已反向演进 JSONL→SQLite）；**模型切换计量重置 → 建议采纳最小面**（classic/Repl 路径 `solveIssue` 漏传 `windowTokens`，0.7.3 窗口预算在该路径不生效——遗留为独立小项）。

**问题 2 结论（登记不实施，ROADMAP-NEXT §3.2）**
- 6 工具 schema ≈2K token/请求（8K 窗口占 25%），对不支持 native FC 的模型（diffusion/1B 实测）纯开销且有行为牵引。低优先三项：toolSchemas 按 intent 过滤（search 只读三件，chat 已零工具）/ `PANSHA_TOOLS_MODE=text|native|off` 开关（兼评测消融维度）/ schema description 一行化。

**验证记录（Windows / Node 22，2026-09-06）**
- `npx tsc --noEmit` EXIT=0。
- 全量 `node --test --import tsx --test-concurrency=4 "tests/**/*.test.ts"`：**716 例：715 pass + 1 skip + 0 fail**（0.7.3 基线 664 例 + 新增 ErrorSemantics 7 例 / QuestionMarkPassthrough 3 例 / streamChat 回退重试 2 例；高并发偶发进程级崩溃假象复跑消失，最终一次全绿）。
- `node verify-panshalach-cleanup.mjs`：静态检查 PASS；0.7 段仅 `continueCount zero refs` FAIL——由 R6 域 `scripts/eval/{results/schema.mjs,smoke-eval.mjs}` 残留引用导致（判官语义字段进评测 schema 是 R6 合入 f9219ee 引入，**本轮 start 前已存在**，归 R6/赵天昂域销项，禁越界）。
- `node scripts/check-protected-files.mjs` PASS（TurnStopReason 六旧值全在 + 加性值不违约）。
- `npm run build` EXIT=0；dist 特征 grep：`VERIFICATION: APPLIED`/`buildBanner`/`completeLikeFallback`/`isAbortLikeError`/`warnIfDistStale` 均在，`trimmed === '?'` 为 0。

**真机复测指引（待控制人）**
- LM Studio 当前加载的 `openpangu-7b-diffusion-base-i1` **不支持 chat/completions**（返回 200-garbage）——请加载标准自回归对话模型后重试。
- dist 重建后启动横幅应显示 v0.7.3+ 三行（模型/档位/模式）；若 src 有未构建改动会出现"⚠ dist 落后于 src"黄字提醒。
- 四路径复测：`1` / `你好，回答我你是谁`（单次出正文）；Ctrl+C（网关停 POST）；`hello.txt`（先搜索搜不到询问）。

**Risks**
- fetch 发出后 abort 只中断读取/连接，网关侧生成可能仍算完（0.7 已知边界，如实声明）。
- sseInteractive 活路径 aborted turn 现依赖 runPromise settle 后的 `stopReason==='aborted'` 分支落 partialText——若 abort 发生在 runAgentTask 之外的更早窗口（如审批挂起），落盘路径仍走 catch 分支（无 partialText，可接受）。
- `?` 透传后，弱模型对 `?` 输入的回答质量取决于模型本身（1B 可能返回空泛答复）——语义上"给模型的信息"由模型消化，不再有本地兜底文案。

**补记（0.7.4 之后的小修与前置，未单列版本号）**
- rich 桥 `setRunning(false)` 双重下发去重：`TurnContext.runningBadgeOn` 徽标守卫（commit 92acc25）——同一回合同一状态只下发一次，结束横幅不再闪烁两次。
- `.panshalach-task-state.json`（TaskState 运行时产物）移出版本库并入 `.gitignore`（commit 9dfe7ea）。
- 0.8 前置 M1 第 1 步：行为锁定测试 `tests/repl/turn/TurnBehavior.lock.test.ts`（455 行）落地（commit df6e39f"步进调整"，sseInteractive 步进重排、零行为变更）；当前全量基线 **749 例（748 pass + 1 skip + 0 fail）**。0.8 立项见 `docs/panshalach/PLAN-0.8-FOUNDATION.md`。

## 0.7.3 (主链确定性：真实成功信号入册 + 三入口审批/中断透传 + 窗口预算挂真值 + 中断现场落盘)

方案：`docs/panshalach/USABLE-PLAN-0.7.3.md`（5 份子智能体审查报告收敛——CC / dsh / hermes / oh-my-pi / 红队对抗自审）。红队用可复现探针实测出**两个被 629 例绿灯密封的 P0**：真实工具成功被误判为失败（唯一 PASS 产出方是 smoke mock，真实引擎的 `EXIT_CODE:0`/`WRITE_SUCCESS:` 被判 FAIL，勤奋模型被连败掐死、只说话的模型反而 `answered` 计成功）、completed 真机不可达导致记忆闭环死码；外加文档主验证命令的审批断链（A3）与 classic 假中止（A4）。本轮 13 项三梯队全部落地，回答一个问题：**砍掉什么、修什么，才能让评委/新用户明天拿真实模型跑通一天**。

**真实成功信号入册（T1#1，A1+A2 同修）**
- `src/tools/engineAdapter.ts` `describeResult` 按 `res.ok` + 工具类别**确定性追加**规范尾标（不做正文字符串扫描）：bash/write_file/edit_file → `VERIFICATION: PASS`（bash 的 `EXIT_CODE:0` 尾行已有）；read_file/glob/grep → `VERIFICATION: NEUTRAL`（只读，无验证效力）；失败分支不追加任何 VERIFICATION 行——失败永远不该长得像成功
- `src/loop/VerifyCritiqueLoop.ts` `classifySignal`：`VERIFICATION: NEUTRAL`/`PARTIAL` → PARTIAL（清零连败但不计 PASS、不触发 completed/产卡），子句置于 FAIL/ERROR 检查**之前**（只读输出正文可能偶然含 "error" 字样）；裸 `EXIT_CODE:0` 用尾部锚定 `/\nEXIT_CODE:0\s*$/` 判 PASS（排在 FAIL 之后，防正文内嵌字面量误判）；`didRealVerification` 的 `verification:` 松匹配收紧为 `verification: pass`（防 NEUTRAL 尾标误计真实验证）
- 效果：真实成功 → PASS → **completed 真机可达** → 记忆闭环（0.7.2 finalizeTaskMemory）激活

**三入口审批/中断透传（T1#2，A3+A4）**
- `RunCommand` / `Repl.executeTask` / `SimulateCommand` 向 solveIssue 透传 `approvalMode / sessionAllowlist / approvalBridge / signal`（照 runAgentTask 已有形态的**最小透传面**，每处 ≤10 行）；`types.ts` `CommandContext` 增可选 `approvalBridge?/signal?`，Repl.buildContext 与 sseInteractive resume 注册点注入现成审批桥
- 效果：`--approval full` 在 one-shot/headless **真实生效**（此前 flag 只改 session 字段、引擎收不到，写文件必被拒）；classic 路径独立 AbortController 贯穿 solveIssue → loop → 模型 fetch/工具执行，Ctrl+C 不再假中止；SimulateCommand 仅透传 approvalMode（dryRun 在 adapter 构造前返回，桥/信号无消费方，声明不做）

**集成测试去 mock 回环（T1#3）**：新增 `tests/integration/realEngineLoop.test.ts` / `tests/loop/RealSignal.test.ts`——用**真实引擎输出形状**（`EXIT_CODE:0` / `WRITE_SUCCESS:` 文本协议，mock 关闭）驱动 completed 判定与 finalizeTaskMemory 断言，锁定尾标行为

**中断现场落盘（T2#4）**
- `loop.run` 返回 `partialText`（aborted 时本步已流出的模型正文）；`Trajectory`/`Turn`/`RunResult` 增可选 `partialText`；sseInteractive 与 Repl classic 两路径的 aborted 回合都写 turn（session + rollout jsonl，`Repl.recordAbortedTurn`）——**"现场已保留"文案从此有数据支撑**（0.7 时该文案与现实相反）
- 中止检查从"complete 返回后立即 break"移到本地解析之后：解析是纯本地操作，先做它才能保全"已流出正文 + 已解析 toolCalls"的现场；已解析 toolCalls 补 `aborted before dispatch` 合成失败结果（call/result 成对进历史）

**answered 空转防呆（T2#5）**：execution 意图且从未做过真实验证时，"有正文却只说话不动手"的**第一次不终局**——注入一次格式提醒重试一步（消费型旗标，不引入新状态机）；第二次仍无动作按 `no-verification` 终局（不计 success）

**窗口预算挂真值（T2#6）**
- `ModelProvider.getModelContextLength` 未知回落 256000 → **32768 保守值**（把未知窗口当 256K 用会让 8K 模型长任务必爆；保守值只多压缩不误判）；预算侧（`runAgentTask.resolveWindowTokens` / `sseInteractive.resolveCtxWindowTokens`）把 `≤0` 与 `===256000` 哨兵一律视为 unknown → 32768（消化历史配置已写入的哨兵）
- `PANSHA_CTX_WINDOW||128000` const 常量废弃：上下文窗口每任务边界调 `getModelContextLength` 重取（去 const 化），`/model` 切换清零 ctxUsedChars 并立即重取；`PANSHA_CTX_WINDOW` 保留为显式覆盖
- loop 增 `windowTokens`：history 组装后超窗口 70%（chars/4 估算）裁中段——保前 2 步 + 后 2 步 + 显式裁剪标记（未提供时保持旧行为）
- `ModelCommand /model list` 未知上下文**持久化 null**（不再写 256000 假值）、列表显示"未知"（不再冒充 256K）

**finish_reason=length 防御（T2#7）**：`openai-compatible.ts` complete/streamChat 捕获 `finish_reason==='length'` → `truncated` 标记三层透传（非流式返回对象 / 流式尾 chunk `finishReason` / chaser 流式 wrapper 聚合）；loop 对截断响应**禁判 answered**，注入"上一条响应被 max_tokens 截断，请精简后继续"重试一步——残缺 tool_calls / 半句答复不再静默假完成

**首跑报错质量（T2#8）**：`resolveSharedClient` 报错改三选一中文指引（① 项目 `.panshalach.json` ② 用户级 `~/.panshalach/config.json` ③ `/model list`）；REPL 启动横幅预检无可用 provider 时打一行灰字配置指引（不阻塞、可热加载）

**结果截断改超阈值才剪（T2#9）**：`buildHistoryPrompt` 结果上限 200-300 字符 → **4000 阈值**：≤4000 原样保留；超限保留头 2500 + 尾 800 + 显式 `[...已修剪 N 字符...]` 标记与重读提示——read_file 输出不再被静默剪成"文件不完整"

**withRetry 对齐（T2#10）**：重试 3 → **5 次**（远程网关抖动窗口常超 3 次退避）；`isRetryableErr` 补传输类错误（`TypeError` / "fetch failed"）

**写集提取修正则（T3#11）**：新增 `extractShellWriteTargets`——重定向目标支持引号内空格（`> "my file.txt"`）与 Windows 盘符整体捕获（不再截成 `C:` 碎片）、tee/tee -a 按管道段解析、fd 前缀（`2>`）处理；`extractWrittenFilePaths` 导出供测试

**'a' 决策持久化（T3#12）**：审批"总是允许"best-effort 写入项目配置 `.panshalach.json` 的 `approvalAllowlist`（`ConfigManager.appendProjectApprovalAllowlist`，主 gate 与 MCP gate 同语义）；Session 构造器启动时并集加载回 sessionApprovalAllowlist——跨会话不再重复确认

**文档清漂（T3#13）**：DEPLOY-CN §2.4 验证命令按真实引擎行为重验重写（completed 预期 + 省略 `--approval` 的 readonly 拒写为门禁正确行为）、§3.1 `modelContexts` 表述改准（预算挂真值 + null 持久化）；`/agents` "并行 rollout" 文案删除（0.7 起恒单 rollout 串行）；`package.json` 版本 0.7.0 → **0.7.3**

**明确不进本轮（L 级，登记 ROADMAP-NEXT §3.2）**：消息数组协议重构（complete/streamChat 的 messages 入口）、sseInteractive 巨函数拆分、会话树指针化、subagent 委派、hooks 总线、后台 bash——均与"明天跑通一天"无直接因果且为跨文件大手术

**Tests**: `npx tsc --noEmit` EXIT=0；`node --test --import tsx --test-concurrency=4 "tests/**/*.test.ts"` **663 例：662 pass + 1 skip + 0 fail**（2026-09-06，Windows/Node 22）。新增 5 个测试文件：`tests/integration/realEngineLoop.test.ts`、`tests/loop/RealSignal.test.ts`、`tests/loop/Resilience073.test.ts`、`tests/model/openai-compatible.073.test.ts`、`tests/server/Resilience073.test.ts`；`tests/loop/CritiqueContext.test.ts`（T2#9 新契约：>4000 才剪 + 头尾保留断言）与 `tests/repl/ModelProviderEnv.test.ts`（未知回落 32768）随契约更新
**Risks**: 真机四用例待端点（LM Studio 恢复后按 F6 纪律执行，禁止预填 PASS）；记忆闭环本版仅 runAgentTask 路径（SSE/server/headless）生效，Repl 直调 PanshalachChaser 三口 finalize 待统一执行器收口；MCP 工具结果无验证尾标（尾标只覆盖内置工具，MCP 调用不参与 PASS 判定）；fetch 发出后 abort 网关侧生成可能仍算完（0.7 既有边界）

## 0.7.2 (反思迭代：意图分类前移接线 + 记忆落定主线版 + 集成测试锁死 + 提交物定稿)

反思审查（`docs/panshalach/REFLECTION-0.7.2.md`，8 维度）核心结论：**主线空心化**——0.7/0.7.1 在集成线上完成了终止语义与 UI 工程，但意图分类在富化文本上分类致 chat/search 恒不可达（0.7 宣称的修复运行时未生效）、记忆闭环 4 环只真 1 环（refine/markVerified 生产调用点为零）；625 例全绿里没有一条入口级意图路由或记忆落定的集成断言。本轮消灭前两个（commit ff6dce9）。

**意图前移（4/4 入口接线）**：`runAgentTask` / `Repl` / `RunCommand` / `SimulateCommand` 在 `buildForTask` 之前对**原始输入**分类，intent 同时传富化与 solveIssue——chat 直答 / search 只读 ≤3 步 / task 循环在运行时首次真正可达；`PANSHA_INTENT_GATE` 语义保持

**记忆落定（R1/R2 主线版）**：`finalizeTaskMemory` 单一落定点（runAgentTask result 前）——completed 时 refine→save（R1）+ `injectedCardIds ∩ 轨迹写集` → markVerified（R2），发 `memory.finalized` 事件；失败不影响任务返回。覆盖 sseInteractive/server/headless 路径（Repl 直调 PanshalachChaser 的三口未接，留统一执行器收口）

**集成测试 4 例**（`tests/integration/intentAndMemory.test.ts`，先红后绿实证：接线前 1/4 红、接线后 4/4 绿）：greeting→answered 无格式教学、.ts 整理→search readonly ≤3 步、completed→自动产卡 + markVerified、非 completed 守卫

**提交物定稿**：`SUBMISSION.md`（概述 922 字，创新点与代码事实逐条对齐，评测零数字）+ `DEPLOY-CN.md` 新建（已验证本机路径 + PANSHA_* 全集 13 项 + 昇腾/麒麟标注待实测）

**Tests**: `npx tsc --noEmit` 干净；全量 **629 例（628 pass + 1 skip + 0 fail）**；cleanup/protected-files PASS
**Risks**: 三队友分支合入（B1-B3 评审）与 R6 评测合入为本轮明确不做的最高优先移交项；Repl 直调三口 finalize 待统一执行器；真机手测待端点

## 0.7.1 (UI 手感两批次：信任级/反馈级 + 引导级/质感级 + backlog C/F/D 组)

对标 CC 2.1.88 源码解剖的 REPL 手感改造（方案：`docs/panshalach/UI-UX-REVAMP-0.7.1.md`），两批次全部落在 line 模式主路径（`sseInteractive.ts`）。

**批次 A——P0 信任级 + P1 反馈级（commit e88048a）**
- **P0-1 Ctrl+C 全链路**：SIGINT 兜底 / 空闲二次确认退出 / 幽灵窗口消除 / 审批即拒
- **P0-2 gerund 清行纪律**：renderer Proxy 单点，治"研磨中…⏱[Step 1]"输出拼接污染
- **P0-3 审批三连伤**：暂停 gerund 重绘 / Ctrl+C 即拒 / 每秒倒计时 / 拒绝附指导语 `n:<语>`
- **P1-1 真流式**：thinking 单行滚动∴ + 折叠统计、message.delta 逐字、`/verbose` 开关
- **P1-2 工具实时卡片**：`▸` 头行 + `⎿` 动词句结果行（pre/post 事件接线）
- **P1-3 结束总结块**：三态·步数·耗时·tokens·按 stopReason 分支的下一步建议
- 新增 25 例 UI 单测（`tests/repl/sseInteractiveUi.test.ts`）；评审后修复 'a' 决策回归 / 审批 stdin 泄漏 / 超时钩子残留 / denied 事件缺口等 7 项

**批次 B——引导级 + 质感级（commit 72bdf21）**：横幅 v2（模型/档位/模式/cwd 分层）、Tab 补全 + `?` 快捷面板 + 未知命令模糊建议、`/help` 三处统一（26 命令分组）、模式徽标 + shift+tab 切换 + `/mode` 回执、CJK 宽度治理（stringWidth 接入 table/截断/横幅）、文案纯中文化、情境 tip（≤2 条/会话）；顺带修复 `/mode plan` 落错档的既有 bug

**backlog C 组技术债 8 项**：C1 记忆文件 200KiB 上限执行、C2 compact 先写盘后改内存、C3 FeatureTracker 写失败告警、C4 walkFiles symlink 防御、C5 appendEvent auditStatus、C6 Reviewer 探测/执行两态（消假 passed:true）、C7/C8 bash abort 击杀树 + 跨平台 killTree 归一（Windows `taskkill /T /F`，POSIX `kill(-pid)`）

**F 组收尾 / D 组工程**：F2 abort 传播 4 例、F3 单次调用 + chat answered 断言、F4 answered 不产 success 卡 2 例、F7 PromptBuilder intent 参数化（不传 intent 逐字节等价）；D1 cleanup 脚本增强（8 项 0.7 检查）+ D3 `scripts/check-protected-files.mjs` 新建

**评审修复**：未知命令建议自指死循环（/exit 无限建议）、建议确认先过本地命令注册、后台 apply 失败 warn 级、`/rewind line` 提示真实路径（不再静默 no-op/误发任务）、rich 路径 phase 本地化

**文档**：`UI-UX-REVAMP-0.7.1.md` 新增；backlog 文档 8 项（CHANGELOG 复验补强、ROADMAP 销项 + 遗留、ARCHITECTURE §1/§3 重画 + §5 模板、README/USER-GUIDE 对齐 0.6.5+0.7、REFACTOR-ASSESSMENT 申报累计）

**Tests**: `npx tsc --noEmit` 干净；批次 A 后全量 **570 例（569 pass + 1 skip + 0 fail）**、批次 B 后 **625 例（624 pass + 1 skip + 0 fail）**（`--test-concurrency=4`）；cleanup PASS、protected-files PASS
**Risks**: chat 意图在富化文本上分类致 REPL 路径 chat 不可达（0.7 既有错位，0.7.2 消灭）；真机 TTY 手测待 LM Studio 端点恢复

## 0.7.0 (终止语义重构：判官摘除 + 意图分类 + AbortSignal 贯穿)

产品主实测复现的系统性问题修复：简单输入（"1"/"你好，回答我你是谁"）被重复执行十几次、单任务跑 905s 不收敛；运行中 Ctrl+C 停不下来（网关侧仍持续 POST）；纯问答显示"任务未通过验证"且看不到模型答复。方案文档：`docs/panshalach/FIX-0.7-TERMINATION.md`。

**判官摘除（0.6.4 双层终止收缩为单层）**
- `continuationJudge.ts` 归档至 `archive/2026-09-05-removals/`（判官是唯一外层续跑源——`maxRollouts` 已全档为 1）；回合上界从 ~20 步×3 轮压回单次 `maxSteps`
- `TurnStopReason` 移除 `verification-failed-continue`；`Trajectory` 移除 `continueCount`
- **TestTimeOrchestrator 一并移除**（runMultiple 恒单次后 count/sort/预算裁剪全为死路径）：`Trajectory` 类型迁至 `src/loop/trajectory.ts`，chaser 单次直调 `loop.run()`，空批保护（合成失败轨迹 + lastError）并入 chaser

**回合三态（CC 式自然停即成功）**
- `answered`（新增）：end_turn 无工具调用且**有面向用户正文**（剥结构块后非空）→ `success=true`，UI 显示"已回复"并把模型正文呈现给用户（此前纯问答被标失败且答复被吞）
- `no-verification`：end_turn 但无正文无工具（空白/空转）→ 仍失败
- `completed`：轨迹含真实验证 PASS（保留）
- **记忆信号收紧**：`refine`/compact 补漏的 success 卡信号从 `trajectory.success` 改为 `stopReason==='completed'`——纯问答/闲聊不再产生 success 卡（UI 成功 ≠ 记忆成功）

**意图分类（`src/cli/taskIntent.ts`，纯函数）**
- 四类：`execution`（工程动词/工具/命令/@path）/ `search`（文件后缀无动词——**先只读搜索，搜不到询问用户具体用意**，≤3 步、强制 readonly、禁写禁 bash）/ `chat`（问候/自我询问——单次 complete 直接回答，不进 agent 循环、不灌格式教学与工具 schema）/ `meta`
- `PANSHA_INTENT_GATE=0` 逃生门（全量按 execution 兜底）
- Prompt 组装按意图分支：`StructuredReasoner.buildChatDirective`/`buildSearchDirective` 与执行路径的格式教学彻底分离——消除"对话不调工具"与"每步必须输出工具块"的指令冲突（弱模型伪工具调用空转的直接诱因）

**AbortSignal 贯穿（真正的 Ctrl+C）**
- `solveIssue → VerifyCritiqueLoop → modelClient.complete(opts.signal) → openai-compatible fetchWithTimeout（外部 signal 合并进内部 controller）/ streamChat 读循环（abort 即抛 TASK_ABORTED）→ engineAdapter/executor`
- `runAgentTask` 把 `ctx.signal` 透传给 solveIssue（此前只用于丢事件——signal 到 runAgentTask 边界就断了）；UI 层 abort 后**等待底层 settle**，不再"UI 返回但网关继续刷 POST"
- loop 每步开头 + 模型调用返回后检查 signal → `stopReason='aborted'`
- 已知边界：fetch 发出后 abort 中断的是读取/连接，网关侧生成可能仍在后台算完（无 stream 关闭语义时）；bash 子进程强杀待后续版本

**预算累计修复**
- `estimatedUsedTokens` 按每次模型调用累加（prompt+响应长度估算；此前声明后从未累加 → `[最终预算 0%]` 恒 0 误导）

**文档/测试**
- 新增 `docs/panshalach/FIX-0.7-TERMINATION.md`（方案）；`tests/loop/Termination.test.ts`（6 例：answered/no-verification/completed/max-steps/consecutive-failures/aborted）、`tests/cli/taskIntent.test.ts`（7 例）、`tests/tools/withWriteLock.test.ts`（写互斥从 orchestrator 测试迁出保留）
- 删除 `ContinuationJudge.test.ts`/`TwoLayerTermination.test.ts`/orchestration 两测试；记忆测试正向卡用例随信号源更新（`stopReason='completed'`）
- 验证（2026-09-05，Windows/Node 22）：`npx tsc --noEmit` 干净（EXIT=0）；`node --test --import tsx --test-concurrency=4`（显式 glob 全目录）**545 例：544 pass + 1 skip + 0 fail**；`node verify-panshalach-cleanup.mjs` **OVERALL CLEANUP STATUS (static checks): PASS**（收尾复验 2026-09-05：三项命令原样重跑，结果与上述一致）
- 待实测（用户侧，需真实端点；负责人：翟苑皓 F6）：REPL 输入 `1`/`你好，回答我你是谁` → 单次出正文；运行中 Ctrl+C → 任务真停、网关停 POST；`hello.txt` → 先只读搜索、搜不到询问具体用意

## 0.6.5 (R4+R5：事件查询层 + TaskState 持久化，王佐 U1-U2)

> 与下方"0.6.5 部署落地"为同版号两次录入（本批更晚），按时间序排列于此。

王佐 U1-U2 落地（存储层；/task CLI 为赵天昂 R5 另半，依赖本层）：
- **R4 MemoryEventStore**：新增 `src/memory/events.ts`——在 rolloutStore 底座（`appendAgentEvent`/`readAgentEvents`，df7a119）之上提供 kind/topic/session/taskId/时间窗的有界查询 + `latest`/`countByKind`/`activeTaskIds`/`topicStats`/`taskSummaries`；只读、损坏行/缺会话容错、不绕过底座自行读 JSONL（测试 5 例）
- **R5 TaskState 持久化**：新增 `src/memory/taskState.ts`——`TaskStateStore`（create/get/update/applyEvents）+ `rebuildFromEvents`/`foldEvent`；履约 R5 落地合同：`originalRequirement` 不可漂移、version 乐观锁（冲突抛错）、原子写盘（tmp→rename 无残留）、事件折叠幂等（foldedEventIds 记账去重）
- `types.ts`：`TaskState` 增可选 `foldedEventIds`（幂等记账，向后兼容）
- 测试：R5 10 例；全套 557（556 pass + 1 skip + 0 fail）

## 0.6.5 (部署落地：全局唤起 + 原生 function calling 请求侧 + 写工具全档位 + CC 风格提示词)

产品主"部署后无法唤起"排查引出的全链路修复（本地 LM Studio openPangu-Embedded 实测驱动）：

**部署与配置**
- **全局部署**：`npm link` 生成 zhulong/panshalach bin（此前从未安装；旧名 `zorge` 孤儿 junction 指向无关项目，已清理）
- **配置播种缺口**：`session.model` 此前只认 `PANSHA_MODEL` env，配置文件的 `model` 字段从未生效（不带 env 必报"未配置可用的模型客户端"）。新增 `modelSeed.ts`：`applyConfigModel` 在 env 缺席时从配置兜底播种，接入 runOneShot / startRepl / sseInteractive / classicRepl 全部入口
- **ConfigManager 加载顺序修正**：原实现用户级 `~/.panshalach/config.json` 覆盖项目级 `.panshalach.json`（与注释意图相反）→ 改为项目级覆盖用户级；用户级目录支持 `PANSHA_USER_CONFIG_DIR` 重定向（测试隔离）
- **审批通道**：`--approval <readonly|default|full>` flag 与 `PANSHA_APPROVAL` env——headless/一次性执行此前锁死 readonly，写文件必然被拒

**原生 function calling（P1.1 请求侧闭环）**
- `CompleteOptions.tools`（OpenAI function schema）→ openai-compatible 客户端 `stream:false/true` 两条请求路径透传 `tools + tool_choice:auto`；抓包代理实证 6 schema 随每次请求下发
- `EngineAdapter.toolSchemas()`：内置 6 工具 + MCP 的 schema 导出（参数键与各实现严格一致）；VerifyCritiqueLoop 真实引擎自动携带，mock/旧引擎不受影响
- 响应侧 `tool_calls` 透传此前已就绪（0.6.x），至此请求-响应闭环

**工具与提示词**
- **写工具全档位注册**（产品主裁决）：write_file/edit_file 不再限于 high+，quick/standard 同样注册；安全性由审批门禁 + RBW 兜底，不靠隐藏工具（实测：隐藏工具 + 教学示例含 write_file → UNKNOWN_TOOL 空转烧满步数）
- **格式教学具体化**：`buildToolCallFormatEnforcementPrompt(toolNames?)` 按实际可用工具动态生成 few-shot 示例（抽象 `paramName1` 模板对小模型无效，实测改进后模型产出标准 `<> <write_file>` 调用）；任何档位首轮必注入
- **身份提示 CC 化**（参考 claude-code-2.1.88 / harness-engineering 调研）：双职责定义（对话 vs 执行）+ 意图门槛（模糊输入先澄清不调工具）+ 歧义不往高风险方向解读 + 简洁回答风格；效果待 7B+ 模型验证（1B 分不清示例与指令）

**验证边界（如实记录）**：openpangu-embedded-1b-i1 的 chat template 不支持 tool use（`tool_choice:required` 亦无法诱导 tool_calls）；文本协议 + few-shot 下可完成简单写文件任务（hello.txt 实测落盘、RBW/UNKNOWN_TOOL 反馈回路工作），但成功率与示例遵循度受 1B 能力限制。端到端验收建议使用支持 tool use / 指令遵循更强的模型（openPangu 7B+）。

全套 545 例通过（另：node --test 全量高并发在 Windows 下有进程级崩溃假象，单文件或 `--test-concurrency=4` 均绿）。

## 0.6.4 (R0：双层终止语义 + 三先决修复)

产品主批准的 R0 落地（对抗清单 #1/#6/T-22 + 终止语义双层化）：
- **契约 v3.1**：`TurnStopReason`（completed / verification-failed-continue / max-steps / consecutive-failures / aborted / no-verification）；`Trajectory` 增 `stopReason/continueCount/lastError`
- **双层终止**：loop 层 end_turn（无工具调用）即自然停——PASS 字符串降级为 evidence（计入 trajectory.success 但不再直接终止）；`consecutive-failures`/`max-steps` 保留对应 stopReason。闲聊类任务 1 步即停（实测 nihao 40s→3s）
- **外置判官**：新增 `src/loop/continuationJudge.ts`（CC Stop-Hook 等价）——turn 结束时若未验证完成且轨迹出现过工具调用，注入"验证未通过：原因，继续"有界续跑（≤2 次）；纯文本回合不判官
- **#1 修复**：`withRetry`（429/5xx/网络错误，Retry-After 头优先，±25% jitter，≤3 次）+ `EMPTY_RESPONSE` 可重试（耗尽返回空）+ reasoning_content 兜底（openPangu-Embedded 实测偶发 200 空 content）+ orchestrator 空批合成失败轨迹（不再返回 undefined 导致 TypeError）
- **#6 修复**：count 翻倍——createOrUpdateCard/addRemember 改脱离缓存克隆（count 预解析）、createPositiveCard 同 id 预解析、mergeAndCap 同 id 整卡替换（R1 写闭环前置）
- **T-22 修复**：`ProviderRegistry.createClientSync` 透传 streamChat（生产不再恒非流式）
- **registry 模型名前缀剥离**：`createClientSync` 兜底取 `config.model` 时原样发送 `openpangu:xxx` 路由串 → 网关 400（本地 LM Studio 实测发现并修复）
- **reasoning_content 兜底**：非流式响应 content 空但 reasoning_content 非空时采用之（openPangu-Embedded 实测偶发 200 空 content）
- 新增测试 14 例（judge/双层终止/retry/空批/count 回归），全套 542 例

## 0.6.3 (score 字段整体移除：成败唯一由验证信号判定)

承接 0.6.1/0.6.2 的打分器归档，`score` 概念彻底退出：
- `Trajectory.score` → `Trajectory.success?`（验证信号标注）；orchestrator 排序/早停/预算裁剪改按 success；`setScore`→`setSuccess`
- `solveIssue` 返回值移除 `score`（REFACTOR-ASSESSMENT §4 禁区二次申报）；`RunResult`/result 事件/SSE `done` 事件/CLI 与 SSE 显示全部去 score
- `Turn.result.summary` 从 `score=NN` 改为验证结果短文本（"已通过验证"/"未通过验证"）
- 记忆正向信号：`refine()` 由 `score≥85` 改为 **trajectory.success（验证通过）或正向反馈**；`POSITIVE_SCORE_THRESHOLD` 删除
- compact 补漏：信号源从"summary 正则抽 score≥85"改为 **result.success**；success 卡 evidence 改为该轮任务摘要（修复零信息量卡 + 高分 hash 撞卡问题）
- 前端 demo 得分显示改验证状态；测试随语义更新（525 例全绿）

## 0.6.2 (性能叙事装置摘除：单 rollout、去 critique/静态分析/锚点/风格头/FailureMemory 轨道)

产品主裁决（2026-09-05，探测报告 7 项）落地，全部归档至 `archive/2026-09-05-removals/`：
- **#1 全单次**：`maxRollouts` 六档收敛为 1（max 3→1、ex 4→1、pangu 5→1），`parallelRollouts` 显示口径同步 1；chaser 移除显式并行
- **#2 critique 摘除**：VerifyCritiqueLoop 不再发起自我批判模型调用（打分器归档后其打分激励已消失）；`LoopStep.critique` 恒 undefined；`decideShouldCritique` 移除；`buildCritiquePrompt`/上下文装配保留为休眠代码；critique 事件不再发射；TierConfig 删除 `critiqueFrequency`
- **#3 任务前仓库扫描+锚点注入摘除**：RepoExplorer.explore / AnchorMemory / ContextManager 从 chaser 移除并归档（`RepoExplorer.archived.ts`/`ContextManager.archived.ts`）——"仓库我知道什么"由记忆注入承担
- **#4 静态分析预跑摘除**：chaser 不再起跑即执行 tsc/eslint（`/review` 命令与 Reviewer 本体保留）
- **#5 任务风格头摘除**：`getPromptHeader`/`getVerificationHint` 删除，`scoringHints` 死配置删除（BenchmarkProfiles 保留 get/verifyFirstBias 供档位判断）；StructuredReasoner/PromptBuilder 档位契约去 Critique 行
- **#6 FailureMemory 轨道摘除**：chaser/loop/engineAdapter 全链不再注入/记录；FailureMemory.ts 保留（UserConfirmation/MemoryCommand 兼容）；失败信号唯一归口 = RefinedMemoryStore.refine 任务落定提炼
- **#7 解析恒走三路**：`useUniversal` 恒真，OpenAI JSON/文本/`<>` XML 容错探测统一；strictStructured 仅影响 XML 探测深度；`StrictStructuredToolAdapter` 独占路径退场（类与测试保留）
- 测试：删除 2 个 critique 装配用例（随机制归档）、改写 UNKNOWN_TOOL 用例（引导保留、不记录）；527 例全绿

## 0.6.1 (打分器摘除归档：记忆主线去性能叙事残留)

- **归档** `TrajectoryScorer` 七因子过程纪律打分器 + Chaser 内联启发式评分（88/35+2N/格式/早过加分）→ `archive/2026-09-05-scoring/`（含恢复说明）
- `score` 语义收敛为验证锚定两值：成功=100 / 未成功=0；下游不变式全部保持：success 闸门（≥80）、记忆 success 卡阈值（≥85）、compact 补漏（正则 score 抽取）行为不变
- 顺带修复：旧failure 分 `max(30, 35+步数×2)` 使 ≥23 步失败轨迹也能过 80 闸门的潜在 bug
- orchestrator 早停（≥92）现于首个成功 rollout 即停（token 节省）；缺分兜底 0（不猜）
- 文档：ARCHITECTURE 执行链路描述、REFACTOR-ASSESSMENT §4 禁区注记同步

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
- 新增 REFACTOR-ASSESSMENT.md（已归档至 archive/2026-09-12-process-docs/）：现有代码逐模块对照 openPangu 命题的重构评估与 P1–P6 改造路径
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
