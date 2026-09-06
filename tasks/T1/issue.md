# T1 — TODO.md 多约束生成（约束遵循任务实例）

> 任务族：T1 约束遵循（constraint following）
> Fixture 状态：U3 周末草稿（赵天昂起） / U4 由王浩宇补 verify.sh 强化
> U6 真机 openPangu 端点跑分时使用，A/B/C/C4 四档消融必跑

## 场景

你的同事今天早上要交接一个未完成的项目，请你按照下面 **5 条约束同时**创建一个 `TODO.md`。
这是真实软件工程里常见的"既要…又要…"约束并存场景：模型容易被工具调用噪音淹没，丢失其中 1-2 条弱约束。

## 约束（必须同时满足）

1. **文件名**：`TODO.md`（大小写敏感，不接受 `todo.md` / `TODO.MD` 等）
2. **Checkbox 数量**：必须包含 **5 个** markdown checkbox（格式：`- [ ] xxx`）
3. **空行规则**：每个 checkbox 行后面必须有 **1 个空行**（`\n\n`）
4. **无 emoji**：不能包含任何 Unicode emoji（覆盖 🎯 🔥 ✅ ⭐ 等主流 block）
5. **无 tab 缩进**：全文不能出现 `\t` 字符（缩进仅允许 0 或 4 空格）

## 期望产出

- 工作目录存在 `TODO.md` 文件
- 文件包含 5 个 `- [ ] xxx` 行
- 每条 checkbox 后紧跟空行
- 无 emoji
- 无 tab 字符
- 所有约束同时满足（任一违反 = verdict=verification-failed）

## 验收 Rubric（与 T1 README 对齐）

| 维度 | 度量 |
|---|---|
| 约束覆盖率 | 满足约束数 / 5 |
| 约束冲突率 | 输出中互相矛盾次数（应=0） |
| 工具调用噪音 | 与约束无关的工具调用次数（如 `read_file` 在 `Write` 工具已注册时仍读源） |

## 评测合同

- `taskFamily: T1`
- `verification.commands` 至少包含 `verify.sh`
- 期望 `verdict: completed` + `verification.signal: PASS`
- B 档要求：`injectedCardIds.length >= 1`（line-defense）
- A 档（baseline）：无记忆，必须真溢出验证（不溢出标 overflow-skipped）

## 标签

- `constraint-heavy`
- `small-context`（prompt < 2K tokens）

## Fixture 文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `README.md` | ✅ 已落 | T1 任务族契约 |
| `fixture.md` | ⚠️ 旧 stub | 本文件 `issue.md` 取代 fixture.md 的 issue 正文职责 |
| `issue.md` | ✅ 本文件 | issue 正文（中文长程维护场景） |
| `verify.sh` | ✅ 已落（本次） | 5 条约束自动检查脚本 |
