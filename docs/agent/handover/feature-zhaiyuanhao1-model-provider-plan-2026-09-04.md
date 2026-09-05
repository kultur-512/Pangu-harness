# 模型接入层调查与配置驱动迭代方案（feature-zhaiyuanhao1 → 全分支）

- **日期**：2026-09-04
- **发起分支**：feature-zhaiyuanhao1（翟苑皓）
- **性质**：调查报告 + 方案定稿（未动代码，等开工指令）
- **影响范围**：`src/model/`、`src/cli/repl/ModelProvider.ts`、`.panshalach.json` schema

---

## 1. 调查结论：谁在真正打通模型请求

**全仓唯一真实网络路径：`src/model/openai-compatible.ts` 的 `createOpenAICompatClient`**

| 层 | 文件 | 职责 |
|---|---|---|
| 网络层（唯一） | `openai-compatible.ts` | `POST {baseUrl}/chat/completions`、`GET /models`、SSE 流式、AbortController 超时；Node 全局 fetch，零依赖 |
| 配置发现 | `ModelProvider.ts` | 扫 `.panshalach.json` 候选根目录读 `providers.*`；env 注入（现仅 `SCNET_API_KEY`）；`provider:model` 路由；共享单例 `resolveSharedClient` 兜底链 |
| 消费方 | `VerifyCritiqueLoop.ts:285,485`（每步 + critique）、`PanshalachChaser.ts:339-392`（流式包装）、`compactService.ts:116,187`、`runAgentTask.ts:12` | 全部经 `modelClient.complete()` |

### 死代码清单（0 调用方 / 冗余壳）

| 文件 | 状态 |
|---|---|
| `src/model/UniversalMaoyulinClient.ts`（263 行） | 死代码：自带手写 http/https 请求与解析，全仓 0 import |
| `src/model/maoyulin-client.cjs`（~110 行） | 死代码：全仓 0 import |
| `src/model/ScnetClient.ts`（38 行） | 冗余薄壳：只给 `createOpenAICompatClient` 塞 scnet 默认 baseUrl；仅 `verify-scnet.mjs` 实际引用 |
| `scripts/probe-scnet-real.mjs` | 死脚本 + **第 3 行硬编码真实 scnet 密钥**（已进 git 历史，文件删除 ≠ 密钥作废，需在服务侧轮换） |
| `scripts/probe-maoyulin-models.cjs` | 调试探针，无引用 |

### 活代码里的 scnet 特化（要收敛）

- `ModelProvider._createScnetClient`（3 个调用点，内部本就委托 `pr.createClientSync('scnet', ...)`）
- `_extractScnetKeyFromFile` 只扫 `providers.scnet.apiKey`
- env 只认 `SCNET_API_KEY`/`SCNET_KEY` 且硬编码 baseUrl fallback
- `getModelContextLength` 只查 scnet 的 `modelContexts`——**openPangu-1B 的 4096 上下文配置实际不生效**（一直 fallback 256k）

### 现有请求体的两个限制（接 openPangu 时注意）

1. `messages` 恒为单条 `{role:'user', content: prompt}`，无 system 角色分离
2. 不传 OpenAI `tools` 参数——工具协议靠 prompt 内文本约定（XML/loose），function calling 通道未透传

---

## 2. 参考项目思路提炼

**Claude Code 2.1.88**（cli.js 逆向）：
- **env 覆盖链**：`settings.json env 块 → 进程 env（ANTHROPIC_BASE_URL / ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL）→ 内置默认`；启动时 settings 的 env 合并进 `process.env`，运行期代码只读 `process.env`（单一事实源）
- **apiKeyHelper**：配置可指定"输出密钥的脚本"，密钥不落配置文件
- **provider 选择器**：布尔 env（USE_BEDROCK/VERTEX/FOUNDRY）切换客户端工厂
- 配置分层：global → project → local → CLI 参数，逐层覆盖

**dsh（@deepseek-ai/dsh）**：
- `preset.yml` + `agent.cordis.yml` 声明式组合：预设只声明能力选择，**模型路由留宿主层**
- 宿主面/代理面分离：注册表、沙箱、审批、模型路由是宿主面；预设只选"呈现"

**取舍**：抄 claude-code 的 env 覆盖链 + apiKeyHelper + 分层配置；dsh 的声明式组合对单进程 CLI 过重，只取"配置是唯一事实源、代码零硬编码端点"原则。

---

## 3. 迭代方案（三步，已定稿待开工）

### 迭代 1（U1-U2）：清理 + 配置收敛，行为不变
- 删除全部死代码（上表 5 个文件）；`ProviderRegistry` 删 `createScnetClient` import；测试 'maoyulin' 字面量改中性
- `ModelProvider` 泛化：`PANSHA_<PROV>_API_KEY` / `_BASE_URL` / `_MODEL` env 三件套（`SCNET_API_KEY` 仅在已配 `providers.scnet` 时兼容注入）；`_extractProviderKeyFromFile` 扫全部 provider；`getModelContextLength` 跨 provider 遍历
- **新增 `providers.<name>.apiKeyCmd`**（借 claude-code apiKeyHelper）：执行命令取 stdout 首行作密钥，密钥可不进 git
- `.panshalach.json.example` 补 scnet 完整示例与 apiKeyCmd 用法
- 验收：`grep -rn 'scnet' src/` 仅剩中性注释；tsc EXIT=0；505 全绿；`verify-scnet.mjs` 改读配置任意 provider

### 迭代 2（U2）：tool_calls 透传（P1.1）
- `openai-compatible.ts` `complete()` 返回 `string | ModelClientOutput`：`message.tool_calls` 非空时抽 `{content, raw, toolCalls, detectedFormat:'openai-json'}`
- SSE 路径识别 `delta.tool_calls` 增量拼接；`ProviderRegistry.createClientSync` wrapper 透传对象
- `VerifyCritiqueLoop.ts:292-300` 的 `preParsedToolCalls` 消费通道已存在，**无需改动**
- 完成后 openPangu 原生 function calling 与文本协议双通道并存（ToolCallFormatDetector 仲裁）

### 迭代 3（U3-U4）：env 块 + /model list 通用化
- `.panshalach.json` 增可选顶层 `"env": {...}`，启动时合并进 `process.env`（ConfigManager 分层：项目 > 用户 > 内置）
- `/model list` 完全走 `ProviderRegistry.listModelsWithContext`（遍历所有 provider），删 ModelCommand 的 scnet 直读分支（约 100 行）
- 验收：`PANSHA_MODEL=openpangu:openPangu-7B` + 一份配置 = 端到端可跑，代码无 provider 名硬编码

---

## 4. 各分支依赖关系

- **迭代 1+2 必须先落**：王浩宇（wanghaoyu1）的 `ModelClientOutput` 接口契约（U1）依赖迭代 2 的返回类型定义；落定后在本 handover 追加声明，他基于此写 ContextCompiler
- 迭代 1-3 全部在翟苑皓（zhaiyuanhao1）P1 任务线内，与 U1-U9 矩阵 U1-U4 对应
- `solveIssue` 返回值签名不变（AGENT-CONTRIBUTION §3.1 禁区）

## 5. 遗留风险

1. **密钥轮换**：`probe-scnet-real.mjs` 硬编码的 scnet 密钥已进 git 历史，需服务侧轮换（kultur/控制人处理，不在 git 流程内）
2. `UniversalMaoyulinClient.ts` 头注释"客户端不做限流（按用户要求）"约定——确认删除后该约定不适用于唯一客户端路径 `openai-compatible.ts`（其现状本就无限流，语义一致）
3. 迭代 2 后 `complete()` 返回类型拓宽，外部若有按 `string` 强断言的调用方需同步（当前仓内消费方均已兼容双形态）

---

## 追加声明（2026-09-04 晚，迭代 1+2 已落，等评审）

- **迭代 1 完成**：死代码 5 文件已删（含 probe-scnet-real.mjs，**密钥轮换提醒不变**）；`PANSHA_<PROV>_API_KEY/_BASE_URL/_MODEL` 三件套生效（env-only provider 可用；SCNET_* 保留为 scnet 历史别名，行为不变）；`providers.<name>.apiKeyCmd` 落地（execFileSync+shell，stdout 首行，成功缓存，显式 apiKey 优先）；`getModelContextLength` 跨 provider 遍历；`verify-scnet.mjs` 改配置驱动任意 provider（`node scripts/verify-scnet.mjs [providerName]`）。
- **迭代 2 完成**：`openai-compatible.complete` 返回 `string | OpenAICompatOutput`（detectedFormat:'openai-json'，tool_calls 元素为内部 ToolCall 形状：toolName/params/rawBlock）；SSE `delta.tool_calls` 按 index 增量拼接（修复 [DONE] 早退跳过拼装的 bug）；chaser 流式 wrapper 聚合 toolCalls 后返回结构化对象；`VerifyCritiqueLoop` 消费通道零改动（已验证 preParsedToolCalls 路径兼容）。
- **契约提示（给王浩宇）**：`ModelClientOutput`（types.ts）结构不变；toolCalls 元素为 `{ toolName, params: {name,value}[], rawBlock, format }`——ContextCompiler/接口契约 v2 可直接依赖。
- **新增契约字段**：`ProviderConfig.apiKeyCmd`、`ProviderConfig.headers`；`ModelStreamChunk` 增 `{type:'toolCalls', toolCalls}` 变体（旧消费者按"无 text 字段即跳过"兼容）。
- 验证：tsc EXIT=0；tests/model/* + ModelProvider* + ModelCommandKeyLeak 44/44 绿。迭代 3（env 块 + /model list 通用化）仍排 U3-U4。

> 二次追加（同日深夜）：上下文/记忆 v3 已随本分支落地（AgentEvent/Assertion/TaskState 契约、markInjected/markVerified、compact generation/coveredTurnIds、rollout compact/context 事件、[M1] 卡号）。与模型接入无冲突；评测防线清单见 tasks/context-memory-proposals-2026-09-04.md 终稿章节。
