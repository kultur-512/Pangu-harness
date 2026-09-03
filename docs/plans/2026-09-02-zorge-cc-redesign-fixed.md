# Zorge × CC 重设计 — 修正实施方案

> **For agentic workers:** 用 workflow-subagents（推荐）或本技能内联执行本计划。
> 步骤用 `- [ ]` 复选框跟踪。

**Goal:** 把 Zorge 从"硬编码字符串协议的 while 循环"升级为"带韧性 + 结构化工具调用 + 单一状态源的分层 harness"，同时**保留 VerifyCritiqueLoop 容器**、守住零运行时依赖、不重写为"更小的 Claude Code"。

**Architecture:** 增量改造，不分支重写。保留 `VerifyCritiqueLoop`（698 行，承载 RBW/六档/benchmark 差异化逻辑），只向它注入三样新能力：`withRetry` 韧性包装（解 T-26）、`transition` 枚举 + `end_turn` 验证守卫（把"Verify-Before-Claim"从字符串启发式升级为结构守卫）、T-21 原生 tool calling（结构化参数/结果，消灭字符串协议 bug 之根）。另立独立小模块：`jsonSchema.ts` 校验器（替代 Zod，零依赖）、`createStore.ts` 状态收敛（解 T-25 双真相）、`circuitBreaker.ts`。**权限保持集中**（`approval.ts` 的 `classify` 是纯函数，只修输入不实装 `checkPermissions`）。

**Tech Stack:** Node ≥18（global fetch）+ TypeScript 5.6 + Node 内置 test runner（`node --test --import tsx`）。运行时零新增依赖。

**Spec:** 依据 `docs/ZORGE-REDESIGN-CC.md`（520d33c）的诊断 + 对原规格的批判评审（`REVIEW-ZORGE-REDESIGN-CC.md`，见会话记录）。本方案是原规格的**重排序与剂量修正版**：T-21 提前、QueryEngine 容器重写降级为增量、Zod 决策改为手写 JSON Schema、权限保持集中。

---

## 与 520d33c 原规格的关键差异（必须先读，否则会做错方向）

| 原规格做法 | 本方案修正 | 理由 |
|---|---|---|
| Phase 1 重写 VerifyCritiqueLoop → AsyncGenerator 状态机 | **不换容器**；只加 transition 枚举 + `end_turn` 守卫 + withRetry（增量） | 容器承载差异化逻辑与 benchmark 得分来源，重写 = 高风险零用户收益 |
| T-21（原生 tool calling）排 Phase 2 | **提前到 Phase 1 地基**（T3） | 它是字符串协议 bug 之根，解锁 schema 校验与结构化判定 |
| 引入 Zod 作为唯一新增依赖 | **手写 ~100 行 JSON Schema 子集校验器**（T6） | 守住零依赖；T-21 后 wire format 就是 JSON Schema，无需两套表示同步 |
| §4.3.1 权限决策迁入工具（checkPermissions） | **保持 classify 集中**；只修输入解析 + 预留类型位 | Zorge 仅 7 工具，集中纯函数更可审计；T-27/T-28 病根在输入不在集中化 |
| 验收 M-D = "回合后 .zorge-memory.json 必出新卡" | **M-D = spy 断言 refine() 被调用 + 提取质量阈值** | fire-and-forget 的 LLM 提取非确定，断言"必有新卡"会 flaky 且激励记忆垃圾化 |
| Phase 1 含 T-27/T-28 修复 | **Phase 0 对账并提交工作区在途修复**（已有人实现，未提交） | 避免重复劳动与规格-代码漂移 |

**已确认事实（执行者开工前自验）：**
- 测试命令：`npm test` = `node --test --import tsx "tests/**/*.test.ts"`；单文件过滤用 `npm test -- tests/<file>.test.ts`。
- T-27/T-28 修复**已在工作区未提交**：`src/tools/engineAdapter.ts:218-220`（T-27）、`src/tools/readonlyAllowlist.ts:26-39`（T-28），配套测试在 `tests/tools/*.test.ts`。
- `VerifyCritiqueLoop.ts` 主模型调用在 **L293**（`await this.modelClient.complete(prompt)`）与 **L495**（critique 调用），均裸调用无 try/catch。
- `src/model/openai-compatible.ts` 的 `complete()`（L79-160）返回 `Promise<string>`，**不发 `tools` 字段、不解析 `message.tool_calls`**。
- `src/tools/types.ts` L39：`ToolImpl = (params: Record<string,string>, ctx) => Promise<ToolResult>`，纯文本参数无 schema。

---

## Global Constraints

- **零运行时依赖**：`package.json` 的 `dependencies` 保持空。JSON Schema 校验器手写，不引入 Zod。
- **ESM**（`"type":"module"`）；源码 import 带 `.js` 后缀（TS 编译产物映射）。
- **测试框架**：Node 内置 test runner + tsx；新测试放 `tests/` 镜像源码路径；失败/通过均读 `npm test` 实际输出。
- **中文错误文案**（`READONLY_DENY_MESSAGE` 等）保留，不因重设计改文案。
- **容器保留**：禁止"一次性替换 VerifyCritiqueLoop 为 AsyncGenerator"的大改。
- **权限集中**：`classify()` 纯函数保留为唯一裁决点；工具不得各自内联权限判断。
- **提交纪律**：每任务一提交，message 以任务号前缀（如 `redesign-p1: withRetry`）；不在 `master` 直接开工，先开分支 `chore/zorge-cc-redesign`（Phase 0 提交在途修复后可并行）。

---

## 文件结构总览（先画图，任务按此拆分）

```
src/
  utils/withRetry.ts        [新增] 通用重试/退避/看门狗包装（解 T-26）
  loop/transitions.ts       [新增] QueryTransition 枚举 + end_turn 守卫（不换容器）
  loop/watchdog.ts          [新增] 流式空闲看门狗（45s 警告/90s abort）
  model/openai-compatible.ts[修改] complete 支持 tools 透传 + tool_calls 解析（T-21）
  model/jsonSchema.ts       [新增] 零依赖 JSON Schema 子集校验器（替代 Zod）
  tools/types.ts            [修改] Tool 最小接口 + 三态位 + 结果富回传（增量）
  tools/executor.ts         [修改] partitionToolCalls 读并发（isConcurrencySafe && isReadOnly）
  store/createStore.ts      [新增] 35 行 getState/setState/subscribe（零依赖）
  cli/repl/Session.ts       [修改] 核心字段收敛入 store（T-25 会话部分）
  cli/repl/compactService.ts[修改] 补 auto/reactive 策略 + 熔断器
  utils/circuitBreaker.ts   [新增] 熔断器（maxFailures=3）
  memory/RefinedMemoryStore.ts [修改] 引擎写入闭环（补 refine 调用点）
  cli/repl/CommandRegistry.ts [修改] 命令类型统一（type: action）
  cli/repl/sseInteractive.ts [修改] 内置分发改调 registry（T-25 命令部分）
  server/sse.ts             [修改] serve 命令走 registry + 模式白名单
```

---

## Phase 0 — 在途工作对账与提交（0.5 天，先做）

**背景**：工作区有 7 个未提交文件（`typeahead.ts`、`InputBar.tsx`、`engineAdapter.ts`、`readonlyAllowlist.ts` + 3 个测试），其中含 T-27/T-28 安全修复。这些不是本会话产生，但若不先提交，后续任务会与它们漂移。本 Phase 先确权、验证、提交，作为安全基线。

### Task 0: 验证并提交在途修复

**Files:**
- Commit 区（不新增/修改源码）：`src/tools/engineAdapter.ts`、`src/tools/readonlyAllowlist.ts`、`src/cli/repl/typeahead.ts`、`src/cli/repl/ui/InputBar.tsx`、`tests/repl/typeahead.test.ts`、`tests/tools/bash.test.ts`、`tests/tools/executor.test.ts`
- Create: `docs/ZORGE-REDESIGN-CC.md` 追加一节「在途工作对账」（更新 T-27/T-28 状态为"已修复待提交"）

**Interfaces:**
- Consumes: 无
- Produces: 干净的 `git status`；T-27/T-28 从"开放缺陷"转为"已修复"

- [ ] **Step 1: 开工作分支**（master 上不直接提交）
  ```
  git checkout -b chore/zorge-cc-redesign
  ```
- [ ] **Step 2: 跑全量测试确认在途修复绿**
  ```
  npm test
  ```
  **期望**：全部 PASS；若 FAIL，停下报告（说明在途修复不完整，先修它或回退它，再继续）。
- [ ] **Step 3: 人工审查在途 diff 归属**（确认不是恶意/无关改动；重点 `engineAdapter.ts:218-220` T-27、`readonlyAllowlist.ts:26-39` T-28）
  ```
  git diff src/tools/engineAdapter.ts src/tools/readonlyAllowlist.ts
  ```
- [ ] **Step 4: 追加对账到规格文档**（把这两条从"待办"改为"已修复待提交"）
  ```
  git add docs/ZORGE-REDESIGN-CC.md
  ```
- [ ] **Step 5: 提交在途修复**
  ```
  git add src/ tests/
  git commit -m "redesign-p0: 提交在途 T-27/T-28 安全修复 + typeahead/InputBar（对账工作区）"
  ```
  提交后 `git status` 应为 clean（或只剩本计划之后的改动）。

**验收（M-A 前置）**：`npm test` 全绿；`git status` clean；`readonlyAllowlist` 含 `CHAIN_OR_REDIRECT_RE`；`engineAdapter` 含 T-27 注释。

---

## Phase 1 — 韧性 + 结构化工具调用（核心，约 1-2 周）

**顺序动机**：T-21（T3）打地基，withRetry（T1/T2）解 T-26 不碰容器，T4 给容器加结构守卫，T5 收敛状态。全部为增量，互不阻塞，可并行分派。

### Task 1: withRetry 韧性包装（解 T-26）

**Files:**
- Create: `src/utils/withRetry.ts`
- Test: `tests/utils/withRetry.test.ts`
- Modify: `src/loop/VerifyCritiqueLoop.ts:293`（包主调用）、`:495`（包 critique 调用）

**Interfaces:**
- Produces:
  ```ts
  // src/utils/withRetry.ts
  export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
  export const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED']);
  export interface RetryOptions { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; jitter?: number; onRetry?: (err: unknown, attempt: number) => void; }
  export function isRetryable(err: unknown): boolean;            // status ∈ RETRYABLE_STATUS 或 code ∈ RETRYABLE_CODES 或 err?.status===429
  export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>;  // 指数退避 baseDelay 500ms→maxDelay 32s，±25% 抖动，maxAttempts 默认 5
  ```

- [ ] **Step 1: 写失败测试**（`tests/utils/withRetry.test.ts`）
  ```ts
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { withRetry, isRetryable } from '../../src/utils/withRetry.js';

  test('retries on 429 then succeeds', async () => {
    let calls = 0;
    const fn = async () => { calls++; if (calls < 3) { const e: any = new Error('rate'); e.status = 429; throw e; } return 'ok'; };
    assert.equal(await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 5 }), 'ok');
    assert.equal(calls, 3);
  });
  test('gives up after maxAttempts and rethrows', async () => {
    const e: any = new Error('429'); e.status = 429;
    await assert.rejects(withRetry(async () => { throw e; }, { maxAttempts: 2, baseDelayMs: 1 }), /429/);
  });
  test('does not retry non-retryable errors', async () => {
    let calls = 0;
    const fn = async () => { calls++; throw new Error('boom'); };
    await assert.rejects(withRetry(fn, { maxAttempts: 5, baseDelayMs: 1 }), /boom/);
    assert.equal(calls, 1);
  });
  test('isRetryable recognizes status and code', () => {
    const a: any = new Error('a'); a.status = 429; assert.ok(isRetryable(a));
    const b: any = new Error('b'); b.code = 'ECONNRESET'; assert.ok(isRetryable(b));
    assert.ok(!isRetryable(new Error('plain')));
  });
  ```
- [ ] **Step 2: 运行确认失败**：`npm test -- tests/utils/withRetry.test.ts` → 期望 FAIL（模块不存在）。
- [ ] **Step 3: 最小实现**（`src/utils/withRetry.ts`）
  ```ts
  const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
  const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED']);
  export function isRetryable(err: unknown): boolean {
    const e = err as any;
    if (e && typeof e.status === 'number') return RETRYABLE_STATUS.has(e.status);
    if (e && typeof e.code === 'string') return RETRYABLE_CODES.has(e.code);
    return false;
  }
  export async function withRetry<T>(fn: () => Promise<T>, opts: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; jitter?: number } = {}) {
    const maxAttempts = opts.maxAttempts ?? 5;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    const maxDelayMs = opts.maxDelayMs ?? 32_000;
    const jitter = opts.jitter ?? 0.25;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        if (attempt >= maxAttempts || !isRetryable(err)) throw err;
        const exp = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        const j = 1 + (Math.random() * 2 - 1) * jitter;
        await new Promise(r => setTimeout(r, Math.max(1, Math.round(exp * j))));
      }
    }
    throw lastErr;
  }
  ```
- [ ] **Step 4: 运行确认通过**：`npm test -- tests/utils/withRetry.test.ts` → 期望 PASS（4/4）。
- [ ] **Step 5: 接入 VerifyCritiqueLoop**：把 L293 `const rawOrObj = await this.modelClient.complete(prompt);` 改为 `const rawOrObj = await withRetry(() => this.modelClient.complete(prompt));`；L495 critique 调用同理。跑 `npm test -- tests/loop/CritiqueContext.test.ts` 确认不回归。
- [ ] **Step 6: 提交**
  ```
  git add src/utils/withRetry.ts tests/utils/withRetry.test.ts src/loop/VerifyCritiqueLoop.ts
  git commit -m "redesign-p1: withRetry 指数退避包装模型调用（解 T-26）"
  ```

**验收**：T-26 回归测试（模拟 429→重试成功）绿；`CritiqueContext.test.ts` 不回归。

---

### Task 2: 流式空闲看门狗

**Files:**
- Create: `src/loop/watchdog.ts`
- Test: `tests/loop/watchdog.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WatchdogHandlers { onWarn: () => void; onAbort: () => void; }
  export class IdleWatchdog {
    constructor(warnMs: number, abortMs: number, h: WatchdogHandlers);
    kick(): void;            // 有事件时调用，重置计时
    dispose(): void;         // 结束
  }
  ```

- [ ] **Step 1: 写失败测试**：mock 定时器断言 `kick` 重置、`abortMs` 到点触发 `onAbort` 且 `onWarn` 先于 `onAbort` 触发一次。（用 `node:test` + 真实短毫秒：warn=20, abort=40, 实测 setTimeout 行为。）
- [ ] **Step 2: 运行确认失败** → 模块不存在 FAIL。
- [ ] **Step 3: 最小实现**：`setTimeout` 链，warn 到点回调一次并 `clearTimeout`，abort 到点 `onAbort`；`kick()` 重置两个 timer；`dispose()` 清 timer。含 45s/90s 默认常量 `WATCHDOG_WARN_MS=45_000`、`WATCHDOG_ABORT_MS=90_000`。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 接入**：在 `VerifyCritiqueLoop.run()` 主调用外层起 watchdog，`kick()` 在每个 tool 结果返回后调用，`onAbort` 抛 `ERR_ABORTED`（由上层捕）。测试：`tests/loop/CritiqueContext.test.ts` 不回归。
- [ ] **Step 6: 提交**：`redesign-p1: 流式空闲看门狗（45s 警告/90s abort）`。

**验收**：abort 在任意等待点可触发（模拟挂起模型调用 100ms+ → 被 abort）。

---

### Task 3: T-21 原生 tool calling（地基，最高优先）

**Files:**
- Modify: `src/model/openai-compatible.ts`（`complete` 扩展）
- Create: `tests/model/openai-compatible.toolcalls.test.ts`
- Modify: `src/tools/types.ts`（结果承载 `tool_calls` 结构）

**Interfaces:**
- Produces（扩展 `CompleteOptions` 与返回契约，**向后兼容**）：
  ```ts
  // CompleteOptions 新增
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters: unknown /* JSON Schema */ } }>;
  // 返回类型由 Promise<string> 扩为 Promise<string | ToolCallMessage>
  export interface ToolCallMsg { role: 'assistant'; content: string | null; tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; }
  export function hasToolCalls(r: string | ToolCallMsg): r is ToolCallMsg;
  ```

- [ ] **Step 1: 写失败测试**：用 fake `fetch` 拦截，断言：① 传 `tools` 时请求体含 `tools` 且 `messages` 里追加了带 `tool_calls` 的 assistant 消息（用注入历史的 mock）；② 响应 `choices[0].message.tool_calls` 被解析为 `ToolCallMsg` 返回；③ 不传 `tools` 时行为与旧 `Promise<string>` 完全一致（回归）。
- [ ] **Step 2: 运行确认失败** → 当前返回纯 string，失败。
- [ ] **Step 3: 最小实现**：`doComplete` 中——若 `opts.tools` 存在则 `body.tools = opts.tools`；若 `opts.messages` 传入则用其替换 `messages`（支持多轮 tool_call_id 回填）；解析响应时优先读 `json.choices[0].message.tool_calls`（数组）→ 返回 `{role:'assistant', content, tool_calls}`，否则维持旧纯 string 分支。保持 `stream:false` 显式声明不变。
- [ ] **Step 4: 运行确认通过** + 回归 `npm test -- tests/model/`。
- [ ] **Step 5: 提交**：`redesign-p1: 原生 tool calling 透传 + tool_calls 解析（T-21 第一步）`。

**验收（M-C 前半）**：单测证明"请求带 tools schema、响应带 tool_calls、`tool_call_id` 可回填多轮"。**不做** `tool_call_id` 回填的端到端接入——那在 Phase 2 与 T7 合并做（T3 只保证协议层可收发）。

---

### Task 4: transition 枚举 + end_turn 验证守卫（不换容器）

**Files:**
- Create: `src/loop/transitions.ts`
- Test: `tests/loop/transitions.test.ts`
- Modify: `src/loop/VerifyCritiqueLoop.ts:551-568`（成功判定区）

**Interfaces:**
- Produces:
  ```ts
  export type QueryTransition = 'continue'|'tool_use'|'stop_sequence'|'end_turn'|'max_tokens'|'error_recovery'|'budget_exceeded'|'abort';
  export interface TurnEvidence { didRealVerification: boolean; signal: string; }
  export function decideTransition(signal: string, didRealVerification: boolean, maxStepsHit: boolean, err?: unknown): QueryTransition;
  // 规则：signal==='PASS' && didRealVerification → 'end_turn'；err && retryable → 'error_recovery'；
  //       err && !retryable → 'abort'；maxStepsHit → 'budget_exceeded'；critique 声称解决但无验证 → 'continue'（不放行 end_turn）
  ```

- [ ] **Step 1: 写失败测试**：断言 ① `end_turn` 必须 `didRealVerification===true`；② `signal==='PASS'` 但 `didRealVerification===false` → 返回 `continue`（不终止）；③ retryable 错误 → `error_recovery`；④ 非 retryable → `abort`。
- [ ] **Step 2: 运行确认失败** → 模块不存在。
- [ ] **Step 3: 最小实现**：`decideTransition` 纯函数（引用 `isRetryable` from `withRetry.js`）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 接入成功判定**：把 `VerifyCritiqueLoop.ts:553` `if (signal === 'PASS' || ...) done = true;` 与 L559-568 的 critique 分支，改为经 `decideTransition` 决策：仅当返回 `end_turn` 才 `done = true`。`classifySignal` 的字符串启发式保留但只作为 `signal` 输入，不再直接 `done=true`。
- [ ] **Step 6: 提交**：`redesign-p1: end_turn 验证守卫——Verify-Before-Claim 从字符串升级为结构守卫`。

**验收（M-B 后半）**：`decideTransition` 单测绿；回归确认"critique 声称已解决但无验证 → 不终止"仍成立（对齐 P0-6）。

---

### Task 5: createStore 收敛会话状态（T-25 会话部分）

**Files:**
- Create: `src/store/createStore.ts`
- Test: `tests/store/createStore.test.ts`
- Modify: `src/cli/repl/Session.ts`（核心字段读面收敛）

**Interfaces:**
- Produces:
  ```ts
  export function createStore<T>(init: T): {
    getState(): Readonly<T>;
    setState(patch: Partial<T> | ((prev: T) => T)): void;   // 新对象，不原地改
    subscribe(fn: (state: Readonly<T>, prev: Readonly<T>) => void): () => void; // 返回退订函数
  }
  ```

- [ ] **Step 1: 写失败测试**：① `setState` 返回新引用、旧引用不变（`Object.is(prev, cur)===false`）；② 订阅回调在 `setState` 后触发且带旧/新值；③ `setState` 函数式更新；④ 退订后不再触发。
- [ ] **Step 2: 运行确认失败** → 模块不存在。
- [ ] **Step 3: 最小实现**（35 行内，零依赖）：闭包 `let state = init`，`setState` 合并/函数式生成新对象，`subscribe` 存监听数组，用 `Object.is` 跳过等值更新。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 收敛 Session**：在 `Session.ts` 为 `tier/workspace/model/approvalMode` 引入 store 实例作为单一真相，`rolloutStore`/`SessionStore` 改为 `subscribe` 写入（持久化适配器）。**范围裁剪**：本任务只收敛这 4 个字段 + 让 `approvalMode→rollout 审计`、`model→settings`、`turns→jsonl` 三个 `onChange` 同步点落地；不重构整个 Session 对象。跑 `npm test -- tests/repl/` 确认 REPL 不回归。
- [ ] **Step 6: 提交**：`redesign-p1: createStore 单一真相 + Session 四字段收敛（T-25 会话部分）`。

**验收**：`createStore` 单测绿；`tests/repl/` 全绿；无"Session 直写与 rollout 快照不一致"的新路径。

---

## Phase 2 — 工具面 + 服务层（2-3 周）

### Task 6: 手写 JSON Schema 子集校验器（替代 Zod）

**Files:**
- Create: `src/model/jsonSchema.ts`
- Test: `tests/model/jsonSchema.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // 只支持 T-21 工具 schema 所需的子集：type(string|number|boolean|array|object|null)、
  // properties/required/enum/items/description（description 忽略）。多余关键字忽略，不报错。
  export interface SchemaNode { type?: string; properties?: Record<string, SchemaNode>; required?: string[]; items?: SchemaNode; enum?: unknown[]; }
  export function validateAgainstSchema(value: unknown, schema: SchemaNode): { ok: true } | { ok: false; errors: string[] };
  ```

- [ ] **Step 1: 写失败测试**：对 `{type:'object', properties:{path:{type:'string'}}, required:['path']}`——合法对象通过；缺 `path` 报错；`path` 为 number 报错；`enum` 约束；`array.items` 元素校验；含多余字段不报错（宽松）。
- [ ] **Step 2: 运行确认失败** → 模块不存在。
- [ ] **Step 3: 最小实现**：递归校验器，`type` 用 `typeof`/`Array.isArray`/`null` 判别；未知关键字忽略。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`redesign-p2: 零依赖 JSON Schema 子集校验器（替代 Zod 决策）`。

**验收**：校验器单测绿；`package.json` 的 `dependencies` 仍为空。

---

### Task 7: 工具最小接口 + 三态位 + 读并发 partition

**Files:**
- Modify: `src/tools/types.ts`
- Modify: `src/tools/executor.ts`
- Test: `tests/tools/executor.test.ts`（新增用例）

**Interfaces:**
- Produces（**增量**，不把现有 7 工具全部改写——先加元数据与并发编排）：
  ```ts
  // types.ts 新增（原 ToolImpl 保留为内部桥）
  export interface ToolMeta { name: string; isConcurrencySafe?: boolean; isReadOnly?: boolean; isDestructive?: boolean; }
  export const TOOL_META: Record<string, ToolMeta> = {
    read_file: { isReadOnly: true, isConcurrencySafe: true },
    glob:      { isReadOnly: true, isConcurrencySafe: true },
    grep:      { isReadOnly: true, isConcurrencySafe: true },
    write_file:{ isDestructive: true }, edit_file:{ isDestructive: true }, bash:{ isDestructive: true },
  };
  export async function partitionToolCalls<T>(calls: T[], classify: (c: T) => ToolMeta, run: (c: T) => Promise<unknown>, concurrency = 10): Promise<void>;
  // 读（isReadOnly && isConcurrencySafe）并行 ≤10；写/其余串行。语义：先并发所有读，再按序跑非读。
  ```

- [ ] **Step 1: 写失败测试**：构造 4 个工具调用（read, read, write, read），断言 read 并发（最大并发 ≤10 且读完成时间≈并行）、write 串行（在全部读之后且自身不与另一 write 并行）；用递增 delay 记录实际并发峰值。回归原 executor 行为不破坏。
- [ ] **Step 2: 运行确认失败** → `partitionToolCalls` 不存在。
- [ ] **Step 3: 最小实现**：`partitionToolCalls` 用「先 `Promise.all` 并发读批、再 `for..of await` 串行非读批」。接入 `executor.ts` 的批量工具调用处，读工具不再全走 `withWriteLock` 串行。
- [ ] **Step 4: 运行确认通过** + `npm test -- tests/tools/executor.test.ts` 回归。
- [ ] **Step 5: 提交**：`redesign-p2: 工具三态位 + partition 读并发（≤10）`。

**验收（M-C 后半）**：单测证明 read 并发实测并发峰 > 1；写串行不回归。

---

### Task 8: Compaction 补齐 auto/reactive + 熔断器

**Files:**
- Create: `src/utils/circuitBreaker.ts`
- Modify: `src/cli/repl/compactStrategies.ts`、`src/cli/repl/compactService.ts`
- Test: `tests/repl/compactService.test.ts`（新增用例）、`tests/utils/circuitBreaker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class CompactCircuitBreaker { constructor(maxFailures?: number); trip(err: unknown): void; isOpen(): boolean; reset(): void; }
  ```

- [ ] **Step 1: 写失败测试**：熔断器 maxFailures=3，连续 3 次 `trip` 后 `isOpen()===true`，`reset()` 后恢复；compactService 新增 `auto`（上下文占比 >90% 触发）与 `reactive`（`context_length_exceeded` 触发）两策略，且 auto/reactive 在熔断器 open 时不执行。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 最小实现**：circuitBreaker 计数；compactStrategies 注册 `auto`/`reactive`；`compactService.shouldAutoCompact` 已有（读其阈值），补 reactive 触发点 + 熔断门。
- [ ] **Step 4: 运行确认通过** + 回归 `npm test -- tests/repl/compactService.test.ts`。
- [ ] **Step 5: 提交**：`redesign-p2: 压缩补 auto/reactive + 熔断器`。

**验收**：策略从 2 个 → 4 个（default/topic/auto/reactive）；熔断单测绿。

---

### Task 9: 模型错误分类表

**Files:**
- Create: `src/model/errorClassification.ts`
- Test: `tests/model/errorClassification.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ModelErrorClass = 'auth'|'rate_limit'|'timeout'|'context_overflow'|'server'|'network'|'invalid_request'|'unknown';
  export function classifyModelError(err: unknown): ModelErrorClass;
  // 401/403→auth；429/529→rate_limit；ETIMEDOUT/ECONNRESET→timeout/network；context_length_exceeded→context_overflow；5xx→server
  ```

- [ ] **Step 1: 写失败测试**：各错误样本映射到预期类别；未知 → `unknown`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 最小实现**：纯函数。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`redesign-p2: 模型错误分类表`。

**验收**：单测绿；分类结果可被 withRetry（复用 Task 1 `isRetryable`）与 reactive compact（Task 8）消费——本任务只产出表，不强制改消费方。

---

## Phase 3 — 记忆闭环 + 命令统一（2 周）

### Task 10: 记忆引擎写入闭环 + 召回升级

**Files:**
- Modify: `src/loop/VerifyCritiqueLoop.ts:514-519`（回合结束 fire-and-forget 调 refine）、`src/memory/RefinedMemoryStore.ts`
- Test: `tests/memory/refineClosedLoop.test.ts`

**Interfaces:**
- Consumes: `RefinedMemoryStore.refine(turn: {userRequest, toolCalls, verificationResult, critique, didRealVerification}): Promise<void>`（若不存在则在本任务补该签名）
- Produces: `refine()` 返回值含 `created: number`（供断言）

- [ ] **Step 1: 写失败测试**：用 mock `RefinedMemoryStore`，跑一轮 `VerifyCritiqueLoop`（fake 模型），断言 `refine()` 被调用且调用次数 > 0（**spy 断言，不依赖"必出卡"**）。另补：`refine` 内部在无质量信号时不滥写（空/无验证信号回合不新增卡）。
- [ ] **Step 2: 运行确认失败** → 当前引擎只读不写，refine 未被调。
- [ ] **Step 3: 最小实现**：在 `steps.push` 之后、失败保护之前，`if (this.refinedStore) void this.refinedStore.refine({...lastStep}).catch(() => {});`（fire-and-forget，不阻塞轮次）；`RefinedMemoryStore.refine` 内部对 `didRealVerification===false` 且无失败信号的回合跳过落卡。
- [ ] **Step 4: 运行确认通过** + `npm test -- tests/memory/` 回归。
- [ ] **Step 5: 提交**：`redesign-p3: 记忆引擎写入闭环（refine 调用点）+ 提取质量门控`。

**验收（M-D）**：spy 断言 `refine()` 被调用；无验证回合不滥写卡。

---

### Task 11: 命令双实现合一 + 模式白名单（T-25 命令部分）

**Files:**
- Modify: `src/cli/repl/CommandRegistry.ts`（命令类型 `type:'action'`）、`src/cli/repl/sseInteractive.ts:425-1104`（内置分发改调 registry）
- Test: `tests/repl/commandDedup.test.ts`

**Interfaces:**
- Produces: `CommandRegistry` 的每个命令 `{ type: 'action'|'prompt'|'shell'; exec(ctx): Promise<void>; }`；`registry.handle(slash, ctx)` 统一入口。

- [ ] **Step 1: 写失败测试**：对同一 `/tier`，`sseInteractive` 内置分发与 `registry.handle('/tier', ctx)` 调用同一实现（用 spy 断言 sseInteractive 不再自带 switch，而是转发 registry）；`--headless`/`serve` 下仅 `/status /tier /model /approvals /usage /compact /exit` 白名单可执行，其余拒绝。
- [ ] **Step 2: 运行确认失败** → 双实现并存。
- [ ] **Step 3: 最小实现**：`CommandRegistry` 各命令补 `type:'action'`；`sseInteractive` 的内置 switch 改为查 `registry` 并调用，删除重复分发体；`--headless`/`serve` 入口加白名单过滤。
- [ ] **Step 4: 运行确认通过** + `npm test -- tests/repl/`、`tests/server/` 回归。
- [ ] **Step 5: 提交**：`redesign-p3: 命令双实现合一 + 模式白名单（T-25 命令部分）`。

**验收（M-E）**：`sseInteractive /tier` 与 registry 同一实现（spy 证实）；serve 白名单生效。

---

## Phase 4 — 多 Agent + Plugin（远期，可选）

### Task 12: spawn_agent（进程内隔离 session）
**Files:** Create `src/orchestration/spawnAgent.ts`、`src/tools/spawnAgentTool.ts`；Test `tests/orchestration/spawnAgent.test.ts`
**方案**：`spawn_agent` 工具，description 3-5 词 + prompt + `run_in_background`；先做进程内隔离（独立 `VerifyCritiqueLoop` + 独立 message buffer + 独立 `RefinedMemoryStore`），worktree 隔离后置。复用现有 AgentTree 图模型把 `/agents` 升级为真 agent 树。
**验收**：`spawn_agent` 可派生一个独立会话运行子任务并回传结果；子会话与主会话记忆/状态隔离。

### Task 13: Plugin（可选，无则跳过）
**Files:** Create `src/plugin/pluginTypes.ts`；`src/plugin/watcher.ts`
**方案**：`PluginDefinition` 类型 + `fs.watch` 热加载骨架 + skill frontmatter 加 `allowedTools` 字段。仅落地类型与 watcher 骨架，不接运行时副作用。
**验收**：watcher 单测（mtime 触发 reload 回调）；不实现完整插件执行语义。

---

## 验收里程碑（总表，对齐原 M-A~M-E + 修正）

| 里程碑 | 对应任务 | 验收标准 |
|---|---|---|
| M-A 权限安全 | Task 0 | T-27/T-28 已提交；`npm test` 绿；`ls; rm -rf .` 在 readonly 下拒绝 |
| M-B 韧性 + 守卫 | Task 1/2/4 | 429→重试成功；abort 任意点生效；`decideTransition` 拒绝"无验证终止" |
| M-C 工具结构化 | Task 3/6/7 | 请求带 tools schema；`tool_call_id` 可回填；read 并发峰 >1；校验器零依赖绿 |
| M-D 记忆闭环 | Task 10 | spy 断言 `refine()` 被调用；无验证回合不滥写 |
| M-E 命令统一 | Task 11 | sseInteractive `/tier` 与 registry 同一实现；serve 白名单生效 |

每个里程碑走三 agent 流程（编码 → 一级验收 → 二级复审 → 归档），交接文件见 `.agents/`。

---

## 明确不做（YAGNI 边界，防止重写成"更小的 Claude Code"）

- **不替换 VerifyCritiqueLoop 为 AsyncGenerator 状态机容器**（只加 transition 枚举与守卫）。
- **不引入 150+ 字段 AppState / 30+ 方法 Tool 接口**（只加 6 字段 ToolMeta + 三态位）。
- **不下放权限到工具 `checkPermissions`**（classify 集中保留，`ToolMeta` 里仅留 `isDestructive` 元数据）。
- **不做 7 级恢复级联**（先 withRetry + reactive compact 两级，等真实失败数据）。
- **不引入 Zod**（手写 JSON Schema 子集）。
- **不做 feature-flag 编译 / DCE / Plugin 运行时**（Phase 4 仅骨架）。

---

## 任务间依赖图（供 workflow-subagents 分派）

```
Task0 (P0) ──→ Task1 ─┐
                Task2 ─┼── 全部独立，可并行
                Task3 ─┤（T3 产出被 T6 消费接口，T6 可在 T3 后并行）
                Task4 ─┤
                Task5 ─┘
Task6 ─┐
Task7 ─┼── 独立，T3 完成后可并行
Task8 ─┤
Task9 ─┘
Task10（依赖 T4 的 turn 结构）→ Task11（依赖 registry 稳定）→ Task12 → Task13
```