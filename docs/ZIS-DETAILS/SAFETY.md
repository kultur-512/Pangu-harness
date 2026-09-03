# ZIS 细节 · 安全（从 docs/ZIS.md 迁移，A-T10）

> 审批 / 护栏 / 负向工具清单 / 安全闸。

## M2：安全执行 + 会话资产

### 审批真接线（M2.0）
- rich UI：`bridge.setConfirm(request)` 返回 Promise，ConfirmBar 渲染工具名/描述/danger 红标/diff 前 8 行；
  键位 `y=允许一次 / a=本会话总是允许 / n·Esc·回车=拒绝`；决策经 `bridge.resolveConfirm` 回流引擎。
- 行模式：readline 问答桥（60s 静默=安全默认 n）。headless/无桥：自动 n。
- 状态机验证：`node scripts/verify-m2-confirm.mjs`（n→DENIED_BY_USER / a→allowlist 跳桥 / y→进入引擎层）。

### /undo（M2.1）
- 每次真实 write/edit 落盘前自动 checkpoint 到 `~/.zorge/file-history/`（workspace 哈希隔离 + JSONL 索引）。
- `/undo` 还原最近写盘并显示 +/− diff；undo 本身可逆；新建文件的 undo = 删除该文件；`/undo <path>` 定向还原。
- bash 副作用不在 checkpoint 范围（与 CC /rewind 同语义）。

## 真实执行（M1）

从 M1 起，Zorge 的工具调用**真正执行**（此前仅解析不执行）：

### 工具清单（执行层注册，按档位裁剪）

| 工具 | 档位 | 语义 |
|---|---|---|
| read_file（Read/cat 别名） | 全部 | cat -n 行号、offset/limit 分页（默认 500 行）、二进制截断提示、续读 offset 提示 |
| glob / grep | 全部 | 自实现 `**`/`*`/`?` 与行正则；复用 RepoExplorer 的 ignoreDirs；200/250 条上限 |
| bash | 全部* | spawn shell:true；tier 超时 quick=30s/standard=60s/high+=120s（硬上限 600s）；超时杀进程树（Win: taskkill /T /F）；输出 20k 截断；ZORGE_EXEC=1 注入；danger 命令仅红标 |
| write_file / edit_file | high/ex/zorge | diff 先于写盘；RBW 铁律（未读先写→拒绝并记入 FailureMemory）；edit 唯一性校验（found N）；原子写（tmp→rename，失败清 tmp）；1MB 上限；quick/standard **永不**获得写工具 |

\* bash 在 readonly 档仅放行白名单命令（ls/cat/git status|diff|log|show/npm test|npm run test*|npm run build/pytest/cargo test/go test/vitest/node --test/tsc --noEmit 等），白名单外拒绝。

### 审批（三档语义，readonly 为默认档）

- `readonly`（默认）：写类全拒、bash 白名单外全拒——**不弹卡直接拒**，文案含「使用 /approvals default 或切换档位放行」
- `default`：写类必弹确认卡；bash 白名单外弹确认；白名单内免审；`a` = 本会话同类放行
- `full`：全放行，danger 仍红标
- 交互：行模式 readline 问答（60s 超时=n）；非 TTY/无桥一律 n（绝不挂起）；`/approvals [readonly|default|full|clear]` 查看与切换，随 Session 持久化

### 卡片呈现

- 工具结果字符串尾部携带 `⟦DIFF⟧<json>` 标记（引擎保持纯字符串契约）；ToolCard 解析并渲染 **+/−/ctx 三色 diff**，超 40 行折叠「… N 行省略 …」
- 拒绝卡：`✗ DENIED · <原因>` 单行红字
- 真实验证信号：bash 成功结果以 `EXIT_CODE:0` 结尾，loop 据此判定 didRealVerification（真实测试证据），评分不再被假 ALL_TESTS_PASSED 拉满

### 安全闸（不可绕过的红线）

- 引擎适配层最外：`!process.stdout.isTTY || ZORGE_SMOKE=1` → 返回 mock 字符串，**永不 spawn、永不写盘**（smoke/CI 天然无害，有单测覆盖）
- 所有文件路径经 pathGuard 双重校验（词法前缀 + realpath 二次前缀），越界/盘符/symlink 逃逸一律 `PATH_ESCAPED`

### 负向工具清单 + 运行时护栏（fix-#9，防格式漂移）

- PromptBuilder 注入 `<negative_tool_list>`：声明 `iron_law_check`/`thinking`/`plan`/`critique` 等
  prompt 内词汇【不是】工具（漂移抑制源，全档位注入）。
- engineAdapter 运行时护栏：未知工具调用 → `TOOL_FORMAT_ERROR` 记入 failureMemory +
  "意图→工具"引导（读→read_file / 改→edit_file）+ 连续 ≥3 次未知工具硬提示（已知工具调用即清零）。

### 已知限制

- Windows GBK 控制台中文输出可能乱码，不影响退出码与 diff 判定
- symlink 逃逸检查依赖 realpath，Windows 无符号链接权限的环境会跳过相关测试
- default 档确认卡在行模式为 readline 问答；rich UI ConfirmBar 接线属后续迭代
- 60s 审批超时视为 n（保守默认）

---

