# 二级审查报告（2nd-Level Review Audit）

> 审查员身份：二级审查员（只读 + docs 修改/新建，不动 src/）。
> 审查对象：5 批缺陷修复（fix-p0-sec / fix-p0-fn / fix-p0-path / fix-p1 / fix-p2）。
> 方法：只读源码交叉核对（grep/read 取证），未运行命令、未修改代码。
> 日期：2026-09（5 批合并后）

---

## 一、5 批修复验收结论

| 批次 | 修复项 | 验收 | 证据 |
|------|--------|------|------|
| fix-p0-sec | S1-S5 | ✅ 通过 | 见 §1.1 |
| fix-p0-fn | B1+B12 | ✅ 通过 | 见 §1.2 |
| fix-p0-path | B2+B7+B8 | ✅ 通过 | 见 §1.3 |
| fix-p1 | B3+B4+B5+B6+/init 闭环 | ⚠️ 通过但**引入 1 个回归** | 见 §1.4 + §2.1 |
| fix-p2 | B9+B10+B11+死代码+文档 | ✅ 通过 | 见 §1.5 |

### 1.1 fix-p0-sec（S1-S5）✅

- **S1 /model 密钥泄漏**：`ModelCommand.ts` 的 SUPER DEFENSIVE 正则捞 key 块已删除；`[scnet-debug]`/`[scnet-raw]` 输出已清；诊断改为类型级提示（`raw-json ok (bom=…)` / `JSON.parse failed: <msg>`），不再含文件片段。grep 验证：src 下 `scnet-debug|scnet-raw|extracted key|rawSnippetForDiag` 零命中。剩余 `sk-tp-你的密钥` 仅出现在**帮助文案**（引导用户配置），非真实 key，合规。
- **S2 全局泄漏**：`__lastScnetListError` 已改为模块私有 `let lastScnetListError`，`globalThis` 零残留。
- **S3 锚点/readFile 脱敏**：新增 `utils/redact.ts`（sk- 前缀 ≥8 位、Bearer、apiKey/secret/password/token 键值对），`ZorgeChaser` 锚点与 `readFile` 工具共用。注意 readFile 脱敏是**内容级**（逐行 redactSecrets），不破坏行号/续读提示。
- **S4 serve 鉴权**：`/api/run` 增加 Bearer token（`--serve-token`/`ZORGE_SERVE_TOKEN`），无 token 仅 localhost；`isAuthorizedRequest` 抽出为纯函数（IPv4/IPv6/localhost 判定 + token 精确匹配）；CORS 默认 localhost 源、`*` 需显式配置。**遗留观察**：`agentServer.ts:84 isLocalhost` 仍被 `allowedOrigin` 使用（未死代码，OK）；health 端点保持免鉴权（合理——liveness probe）。
- **S5 原子写**：`providerPrefetch` 写回改 tmp+rename + `mergeCurrentConfig` 写前重读合并，并发编辑不再被覆盖；文件不可读时跳过写（不重建）。

### 1.2 fix-p0-fn（B1+B12）✅

- **B1**：`engineAdapter.ts` 写工具注册条件由 `high/ex/zorge` 扩为 `high/max/ex/zorge`，max 档（isStrongMode + 全写确认）现在可用写工具。
- **B12**：`ModelProvider._collectCandidateRoots` 的 `require('path')`/`require.main` 改 ESM `dirname` + `process.argv[1]`，父目录 `.zorge.json` 向上发现生效。测试覆盖（chdir 深目录 → 发现父配置）。

### 1.3 fix-p0-path（B2+B7+B8）✅

- **B2**：`runAgentTask` 的 `RunRequest` 增 `session?`，复用调用方 Session（tier/workspace/model/turns 全部生效）；无 session 时新建（serve/headless 兼容）。`sseInteractive` 传 `tier: session.tier, workspace: session.workspace, session`。测试验证 tier 约束 XML 与 turn marker 进入 prompt。
- **B7**：`repl.ts` 恢复路径写 `session.__resumed = { from, turns }`，sseInteractive 的"已恢复会话"提示不再是死代码。
- **B8**：`startClassicRepl(opts?: { session })` 接受恢复会话，非 TTY 降级不再丢 --resume。

### 1.4 fix-p1（B3+B4+B5+B6+/init 闭环）⚠️ 见 §2.1 回归

- **B3**：abort 路径 `lastAborted = true`，队列不再自动连锁执行。✅
- **B4**：`Repl.setSession` 交换运行中会话，`/session load` 生效（buildContext 读 this.session）。✅
- **B5**：shift+tab 归 ZorgeApp 模式环（InputBar `key.tab && !key.shift`）；Esc 单主归 InputBar。✅ 但双 Esc 分支有缺陷（§2.1）。
- **B6**：KeyHandler Esc 不再粘滞（任意非 Esc/非 Enter 键复位；二次 Esc 解除）。✅
- **/init 闭环**：新增 `projectInstructions.ts` 读回 `.zorge/AGENTS.md` 的 `## Verification commands` 清单注入 PromptBuilder（learn P0-2 真正落地）；sseInteractive /init 复用 InitCommand 的 probe/build（消除双实现输出分歧）。✅

### 1.5 fix-p2（B9+B10+B11+死代码+文档）✅

- **B9**：硬编码 `C:\Users\19395\ZCodeProject` → `process.cwd()`。
- **B10**：菜单 Esc 先存 `menuHeight` 再清行（此前清空数组后循环只清 1 行）。
- **B11**：`TreeCommand` 用 `session.id`（Session 无 sessionId）。
- 死代码：`progressBar`/`requestConfirm` 标 @deprecated；demo-new-sample 修导入。
- 文档：AgentTree 注释统一（D-parallel 后 high+ 并行属实）；LEARN-HARNESS-GAP /init 条目更新；TODO T-10~T-19 标记已交付 + 新增 T-21~T-26；CHANGELOG-DETAIL 第十四章。

---

## 二、新发现（需记录，不在 5 批范围内）

### 2.1 【回归】B5 修复后双 Esc 清空失效（InputBar.tsx:127-155）

**触发路径（只读推演）：**

```
第一次 Esc：
  若 suggestions.length > 0  → 进 127 行分支
      now - lastEscRef.current < 300 ? → 首次为 false（lastEscRef 初始 0）
      → else 分支：lastEscRef.current = now；setSuggestionsDismissed(true)
  若 suggestions.length == 0 且 !suggestionsDismissed → 进 142 行分支
      → 同样首次走 else：lastEscRef.current = now；setSuggestionsDismissed(true)
  ⚠️ 注意：suggestionsDismissed 在第一次 Esc 就被置 true

第二次 Esc（300ms 内）：
  若 suggestions.length > 0 → 进 127 行分支，now - lastEscRef.current < 300 → 触发清空 ✅
  若 suggestions.length == 0 → 检查 142 行 else-if：条件为 (key.escape && !suggestionsDismissed)
      → 但 suggestionsDismissed 已是 true → 条件不成立 → **不进入任何 Esc 分支**
      → 双 Esc 清空逻辑永远无法在"建议条已关闭"场景触发
```

**结论**：当第一次 Esc 关闭建议条后（最常见场景），第二次 Esc 因 `!suggestionsDismissed` 条件被跳过 → **双击 Esc 清空输入+队列失效**。原实现（ZorgeApp 全局 Esc 处理 + InputBar 关闭建议）反而能工作——B5 的"单主化"把两个职责合并时丢了这条路径。

**建议修复方向**（供后续批次参考，本次未改代码）：
- 双 Esc 计时不应依赖 `suggestionsDismissed` 状态；改为：任何 Esc 都更新 `lastEscRef`，300ms 内第二次 Esc 无条件触发 `onDoubleEsc`，与建议条开合状态解耦。
- 或：在 `else if` 条件中移除 `!suggestionsDismissed`，让"已 dismissed 后再 Esc"也能走双 Esc 判定。

### 2.2 【遗留·高危】MCP 'a' 决策仍错误解锁 bash（engineAdapter.ts:213）

```
if (decision === 'a') sessionAllowlist.add('bash');
```

对**单个 MCP 工具**选"总是允许"('a')，却把 `bash` 加进会话 allowlist → 之后**所有 bash 命令免审**。这是原始审查 P1-8 的提权路径，5 批指令 P0-1 未覆盖（指令 S 系列只列了 S1-S5，未含此条）。

**建议**：改为 `sessionAllowlist.add(mt.name)`（按工具名放行），或至少限定为 `mcp_<server>_<tool>` 全名。

### 2.3 【遗留·高危】readonly 白名单命令链穿透仍存在（readonlyAllowlist.ts:30-41）

```
const first = c.split(/\s+/)[0].toLowerCase();
if (PREFIX_ALLOW.has(first)) return true;
```

只检查**首 token**：`ls; rm -rf .`、`echo x > file`、`git status; rm -rf .`（正则 `^git\s+(status|diff|log|show)\b` 不含行尾锚）均可绕过 readonly 档。这是原始审查 P1-7，5 批未覆盖。

**建议**：命令链需拒绝（含 `;`/`&&`/`||`/`|`/`>`/`>>`/`<` 的命令整体拒绝或拆 token 全量校验）；正则加行尾锚 `$`。

---

## 三、验收总评

- **5 批中 4 批完全达标，1 批（fix-p1）存在 1 个新引入回归（§2.1）**。
- **2 个高危遗留（§2.2 MCP 提权、§2.3 readonly 穿透）** 是原始审查已识别、但修复指令 P0-1 清单遗漏的项——**不 blame 修复执行，blame 指令覆盖不全**；建议追加为 P0-1 补丁。
- 文档漂移治理到位（TODO/LEARN-HARNESS-GAP/CHANGELOG 与代码现状对齐），新增 T-21~T-26 结构性缺口条目合理。

## 四、建议动作（供航向决策）

1. **P0-1 补丁**：修 §2.2（MCP 'a' → 按工具名）+ §2.3（allowlist 命令链/重定向拒绝）。
2. **P1 补丁**：修 §2.1（双 Esc 与 suggestionsDismissed 解耦）。
3. 上述补丁完成后，5 批修复方可视为"完全闭环"。

---

## 五、已知问题（观测记录，非本次修复引入）

- **并发全量测试偶发 1 fail（复跑即消失）**：2026-09 期间两次观察到
  `node --test "tests/**/*.test.ts"`（默认并发）出现 1 个未定位失败，
  立即复跑或 `--test-concurrency=1` 串行均为 496 pass / 0 fail / 1 skip。
  现象与文档化边界（沙箱下 spawn/管道 EPERM）或测试文件间资源竞争相关，
  非确定性断言失败。建议后续批次排查是否有测试文件共享全局状态
  （如 process.chdir / globalThis.fetch mock / 端口占用），并考虑
  默认以 `--test-concurrency=1` 或 `--test-isolation` 跑全量作为门禁基线。

---

## 参考

- 修复指令：5 批（P0-1 安全 / P0-2 功能 / P0-3 路径 / P1 / P2）
- 原始审查：docs/LEARN-HARNESS-GAP.md（框架对标）+ 只读审查报告（T-21~T-26 条目）
- 本报告证据：`src/cli/repl/ui/InputBar.tsx:127-155`、`src/tools/engineAdapter.ts:213`、`src/tools/readonlyAllowlist.ts:30-41`
