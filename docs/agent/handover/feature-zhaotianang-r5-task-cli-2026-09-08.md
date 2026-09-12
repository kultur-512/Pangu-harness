# Handover — zhaotianang（R5 `/task` CLI：risks | next | decide）

> 起草日：2026-09-08（周二夜，承接 29cbb5c `/task status` 最小版）
> 工作分支：zhaotianang1
> 状态：**接口设计 + 拆分敲定**（实现未落地，待明天开工）
> 上游：29cbb5c（feat(R5): /task status 最小版 own 端落地）/ 11dbea3（王佐 R4+R5 接线）/ c7a1eca（王佐 TaskStateStore）
> 关联：[[r5-taskstate-contract]]（王佐 9/7 已 freeze，own 端照单实现）

---

## 1. 范围（明天 9/9 落地，R5 赵天昂 half）

| 子命令 | 性质 | 数据源 | 渲染层 | 备注 |
|---|---|---|---|---|
| `/task risks` | 纯读 | `store.get(taskId).risks` | `formatTaskRisks(state)` | 与 status 形态对称 |
| `/task next` | 纯读 + 推断 | `state.nextStep` 优先；缺失则按既定顺序推导 | `formatTaskNext(state)` | 标注"来自 nextStep 字段"/"由 XXX 推导" |
| `/task decide` | 写 | 严格走 `store.update(taskId, ...)` | 行内确认 | **不**走 `applyEvents`（R5 契约纪律） |

不在今晚/明天范围：`/task orig`（创建台账）/ `/task archive`（归档）/ `/task link <cardId>`（与 R3 衔接）—— 留 0.8 立项或后续迭代。

---

## 2. 命令形态与解析

### 2.1 `/task risks [taskId]`

```
/task risks                  # 取 session.currentTaskId
/task risks auth-fix-9-9     # 显式 taskId
```

输出：
```
risks (3):
  - [2026-09-08 22:14:31] OAuth callback 超时 · mitigation=加重试 + 缓存
  - [2026-09-08 22:09:02] refresh_token 失效无提示 · mitigation=UI 提前 5min 弹窗
  - [2026-09-08 21:55:44] 第三方网关 5xx 透传 · mitigation=前端白名单
```

空时：
```
risks (0):
  (无风险)
```

### 2.2 `/task next [taskId]`

```
/task next
/task next auth-fix-9-9
```

输出（nextStep 已设）：
```
nextStep:
  字段: 复现 → 看 OAuth 网关日志
  来源: nextStep 字段
```

输出（nextStep 缺失，推导）：
```
nextStep:
  字段: 完成 OAuth 回调回归测试
  来源: 推导（最后一个未 done milestone 的 title）
  原值: milestones[2].title = "OAuth 回调回归测试"
```

全部未知：
```
nextStep:
  (无法推断：nextStep 未设、milestones 全 done、risks 无 mitigation)
  提示: 用 /task decide "<下一步>" 显式设定。
```

推导顺序（按优先级降级，前一项存在即返回）：
1. `state.nextStep` 存在 → 直接显示
2. `state.milestones` 中最后一个 `done=false` 的 `title`
3. `state.milestones` 中最后一个 `done=false` 的 `evidence`（若 title 为空）
4. `state.risks[0].mitigation`（若存在）
5. 全缺 → UNKNOWN 态显式占位

### 2.3 `/task decide <taskId|"what"> ["why"]`

两种用法：

```
/task decide "改用 Redis 存 session 而非内存"
/task decide auth-fix-9-9 "改用 Redis 存 session" "避免重启丢登录态"
```

入参解析（**仿 RunCommand 的 shell-token 解析，不引入新解析器**）：
- 默认 taskId = `session.currentTaskId`
- 如果 `rest[0]` 不在 store 里（先 store.get 试探），则把它当 `what`；`rest[1]` = `why`
- 如果 `rest[0]` 在 store 里，则它就是 taskId；`rest[1]` = `what`；`rest[2]` = `why`
- 解析歧义：探测期一次 `store.get` 失败不抛（store 内部容错损坏文件），返回 null 即视为非 taskId
- what 不能为空字符串（trim 后空 → warn + 拒绝）

写盘：
```ts
const updated = store.update(taskId, (cur) => ({
  ...cur,
  decisions: [...cur.decisions, {
    ts: Date.now(),
    what: decisionText,
    ...(whyText ? { why: whyText } : {}),
  }],
}));
// 注意：不传 expectedVersion——CLI 单线程序列写，无需乐观锁；
// 若引入并发场景（评测多入口），再加 expectedVersion 入参 + retry。
```

输出：
```
decision 已写入 auth-fix-9-9 (version 4 → 5):
  - [2026-09-08 22:31:07] 改用 Redis 存 session 而非内存 · why=避免重启丢登录态
  提示: 用 /task status 查看完整台账。
```

---

## 3. 严格遵循的 R5 契约（[[r5-taskstate-contract]] 复述）

| 项 | 我们的实现 |
|---|---|
| `/task decide` 必须走 `update` | ✅ 不调 `applyEvents` |
| `applyEvents` 仅用于事件流折叠 | ✅ decide 子命令不构造 `AgentEvent`，不调 `applyEvents` |
| `originalRequirement` 不可漂移 | ✅ update 内部 `taskState.ts:204-206` 已抛错保护，我们不动它 |
| 并发走 version 乐观锁 | ⏸ CLI 单进程顺序写，今晚不带 `expectedVersion`；并发场景后置 |
| 空批/无新增不 bump version | ✅ update 内部已经处理（nextState 内容相同也会 bump——但 decide 总是 push decisions[]，不会空批） |
| `foldedEventIds` 不污染 refs | ✅ decide 不动 `foldedEventIds`（只在 applyEvents 路径记账） |

**纪律强化注释**（写进 `TaskCommand.ts:decide` 分支顶部）：
```ts
// R5 契约：/task decide 严格走 update，不走 applyEvents。
// applyEvents 仅用于 AgentEvent 流折叠（仅任务执行期调用）。
// 用户决策是人输入，不是 AgentEvent；走 update 保留 decisions 字段语义清晰。
```

---

## 4. 渲染层（TaskCommand.format.ts 扩展）

```ts
// 现有：
export function formatTaskStatus(s: TaskState): string[]

// 明天新增：
export function formatTaskRisks(s: TaskState): string[]
export function formatTaskNext(s: TaskState, derived?: { from: string; raw?: string }): string[]
//   ↑ derived 可选——next 子命令推导时把 from/raw 一并传入，渲染层负责标注来源
//   next 直接渲染 nextStep 时 derived=undefined
```

格式约束（沿用 status 风格）：
- UNKNOWN 态归 CLI 渲染层（不靠 store 层返回）
- 空数组显式 `(空)` / `(无风险)` / `(无可推断)`
- 时间戳复用 `fmtTs(ts)`，与 status 完全一致
- 行尾不补 ANSI 色码（沿用 status 纯文本），交给 `ctx.renderer.writeLine` 统一着色

---

## 5. 命令分发（TaskCommand.ts 扩展）

```ts
if (sub === 'risks') { /* 调用 formatTaskRisks */ }
if (sub === 'next') { /* 推导 + 调用 formatTaskNext */ }
if (sub === 'decide') { /* 入参解析 + store.update + 行内确认 */ }
```

公共部分（已成型，今晚不重构）：
- store 动态 import 走 `await import('../../../memory/taskState.js')`
- workspace 解析：`ctx.session?.workspace ?? process.cwd()`
- taskId 兜底：`rest[0] ?? ctx.session?.currentTaskId`
- 不存在 / 无 taskId 走 warn + 用法 + 引导（与 status 同款）

---

## 6. 单测（tests/repl/TaskCommand.test.ts 扩展）

明天增补（沿用既有 `ctx()` 工厂 + 临时 ws）：

```
describe('/task risks | next | decide')
  it('/task risks 空数组显式 "(无风险)"')
  it('/task risks 多条按时间正序渲染')
  it('/task next 优先 nextStep 字段,标注 "来源: nextStep 字段"')
  it('/task next 缺失 nextStep,推导自未 done milestone,标注 "来源: 推导"')
  it('/task next 全部未知,UNKNOWN 态显式 + 引导 decide')
  it('/task decide 严格走 update:store.update 被调用一次,applyEvents 不调用')
  it('/task decide 写盘后 store.get 看到 decisions 新增,version+1')
  it('/task decide what 为空 → warn + 拒绝,不写盘')
  it('/task decide what 含 taskId 前缀(双参数形态)正确解析')
  it('/task decide 第三个参数作 why,正确写入 decisions[].why')
```

**关键纪律测试**：
```ts
it('/task decide 严格走 update:store.update 被调用一次,applyEvents 不调用', () => {
  // 用 vi.spyOn 或 monkey-patch TaskStateStore.prototype.applyEvents
  // 验证 decide 路径一次都不调 applyEvents
});
```

实现策略（不引第三方 spy 库）：
- 解构 `TaskStateStore.prototype` 暂存原方法
- 测试前后 `applyEvents = () => { throw new Error('applyEvents must not be called from /task decide'); }`
- 测试结束恢复

---

## 7. 与 PromptBuilder 注入衔接（不动的部分）

- `session.currentTaskId` 设值与 PromptBuilder 块注入由王佐 R5 接线（11dbea3）负责
- `/task` CLI 不动 `currentTaskId`（避免 CLI 写状态干扰 PromptBuilder 注入契约）
- 用户主动绑定：`/session currentTask <taskId>`（已有/将有的 Session 子命令），与 `/task` 解耦

---

## 8. 文件改动清单

| 文件 | 改动 | 行数估算 |
|---|---|---|
| `src/cli/repl/commands/TaskCommand.ts` | 替换三个占位分支为真实实现 | +60 / -8 |
| `src/cli/repl/commands/TaskCommand.format.ts` | 新增 formatTaskRisks / formatTaskNext | +50 / 0 |
| `tests/repl/TaskCommand.test.ts` | 新增 9 例 | +120 / 0 |

不动：
- `src/memory/taskState.ts`（王佐已 freeze）
- `src/cli/repl/Repl.ts`（TaskCommand 已注册）
- `src/cli/repl/types.ts`（TaskState 子结构已定稿）

---

## 9. 验收锚（明晚发车前对照）

- [ ] `npm test tests/repl/TaskCommand.test.ts` 全绿（15 例：现有 6 + 明天 9）
- [ ] `npx tsc --noEmit` EXIT=0
- [ ] 与王佐 `update()` 签名核对：明天开工前先 diff 一遍 taskState.ts，确认 [[r5-taskstate-contract]] 6 接口无新增
- [ ] `git log --all -- src/memory/taskState.ts` 看是否有 post-9/7 的 patch（万一轮到我开工前王佐又改了契约）
- [ ] `applyEvents` 守卫测试：把测试文件单独跑一次确认守卫代码不泄漏到生产路径

---

## 10. 与明天工作流的衔接

- 本地 commit 29cbb5c 不推送（按今晚 Leader 偏好，本地暂留，明天连同明天子命令一起推）
- 明天开工先 fetch origin/zhaotianang1 + origin/wangzuo1 + origin/develop，看是否有 race
- 落地后一次性 push：commit 信息遵循 feat(R5): 风格，body 列三件事 + 验收 + Risks

---

## 关联

- [[r5-taskstate-contract]] — 王佐 R5 契约（9/7 freeze）
- [[leader-group-chat-preference]] — 与王佐协调走群
- `docs/panshalach/ROADMAP-NEXT.md` §3 R5 + §3.1 R5 合同
- `docs/panshalach/ROADMAP.md` P2/P3 进度
- 上游 commit：29cbb5c（/task status）/ 11dbea3（王佐接线）/ c7a1eca（王佐 store）