# AGENT-CONTRIBUTION.md — 多人控制 Agent 协作规范（Panshalach / 烛龙）

> 目的：让多个 agent 协同工作时**不互相踩、不重复劳动、不绕开评审、不破坏既有测试与文档**。本规范是仓库内的"硬约束 + 软约定"。人（产品主）保留对所有规则的最终解释权与豁免权。
> 技术路线与未完成项见 `docs/panshalach/ROADMAP-NEXT.md`；变更申报写 `CHANGELOG.md` 对应版本段。

---

## 1. 角色

| 角色 | 数量 | 职责 |
|---|---|---|
| **产品主（人）** | 1 | 拍板方向、拆任务、验收、授权对禁止区的临时豁免 |
| **执行 agent（4 主力）** | 4 | 领任务、读规约、提交 patch（diff + 测试 + 文档），不直接 push 到主分支 |
| **评审 agent（R）** | 1（Leader 兼） | 复核 patch：合规、测试、文档、命名；给出 PASS/REVISE |
| **学习位（K ≥ 0）** | 动态 | 挂靠主力做"看、学、改小"：文档维护、CHANGELOG、跑回归；不 owner 主线任务 |

> 多 agent 并行只在"任务切片互不相交"前提下允许；不允许两人 agent 同时改同一文件。

---

## 2. 任务切片（Task Scoping）

每个 agent 开工前必须：

1. 在 `tasks/` 对应任务卡里声明自己要做的子任务，写清：
   - **范围**（要改的文件 / 模块）
   - **不在范围**（明确说"不动 X 文件"）
   - **验收标准**（跑通哪些测试、产出哪段文档）
2. Commit 之前再次确认范围没扩散；若改了范围外的文件，PR 描述里**必须列出来**并解释。

> 范围扩散 = 直接 REVISE。

---

## 3. 文件级约束（Hard / Soft / Forbidden）

### 3.1 禁止区（Forbidden）— 一旦触碰自动 REVISE

| 区 | 内容 | 原因 |
|---|---|---|
| `package.json` 的 `dependencies` | 不得新增任何运行时依赖 | 仓库核心零运行时依赖是产品约束 |
| `.panshalach.json.example` 的 `openpangu` provider 名 | 不得改名 | 真实 openPangu 验证路径靠它 |
| `src/PanshalachChaser.ts` 的 `solveIssue` 返回值签名 | 不得变更（除非先在 `CHANGELOG.md` 申报并由评审 R 同意） | P3 闭环挂接点 |
| `docs/panshalach/EVALUATION.md` §4 数据表 | 不得手填 | 必须由 `scripts/eval/fill-evaluation.mjs` 从 `scripts/eval/results/*.json` 拉取 |
| 旧品牌残留 | 不得新增任何旧品牌类名/别名/shorthand | 清理已完成（commit 17851f9），保持为零 |
| `.claude-settings.json` 的 allow 列表 | 不得新增 Bash 通配（除非是 allow 列表里已有的子集） | 防"借题扩展权限" |

### 3.2 必须区（Must）— 不做就 REVISE

| 区 | 内容 |
|---|---|
| `src/**` 的改动 | 必须有对应单测（放在 `tests/` 同路径镜像下）或在 PR 描述里说明"无可测理由" |
| `package.json` 的 `version` | 改动 src 或脚本时必须 bump `patch`（x.y.**z**+1）；重大变更 bump `minor` |
| `CHANGELOG.md` | 在"## 0.X.Y"段下加变更条目；只增不改 |
| 命名一致性 | 内部代号 = **Panshalach**（盤沙拉克）/ 外部产品 = **烛龙 Zhulong**；混用者 REVISE |
| `npx tsc --noEmit` | 必须 EXIT=0 才允许 PR |
| `node --test --import tsx --test-concurrency=1 "tests/**/*.test.ts"` | 必须全绿（以 `npm test` 实际输出为准，允许 ≤2 skip 并说明；硬性数字下限不随摘除/新增浮动） |
| `node verify-panshalach-cleanup.mjs` | 必须 PASS |

### 3.3 软区（Soft）— 约定

| 区 | 约定 |
|---|---|
| `src/memory/RefinedMemoryStore.ts` 公开 API | 增方法时向后兼容；不得删除/改语义已有方法 |
| `src/cli/repl/PromptBuilder.ts` 注入顺序 | `TaskState → 记忆卡 → MemoryEvent → 当前任务`，新增层插入要写明插入位置 |
| 测试命名 | `tests/<dir>/Xxx.test.ts`；`describe` 用被测对象名；`it` 写行为不写实现 |
| 兼容别名 | 旧别名只剩 `zorge` bin 与 `power:'zorge'` tier alias（TIER_ALIASES），不得新增同义别名 |

---

## 4. 命令 / 工具权限

`.claude-settings.json` 的 `allow` 是**唯一**自动放行的 Bash 前缀集合。规则：

1. **白名单内前缀**：直接执行；不用询问人。
2. **白名单外命令**：必须经产品主显式同意 + 加入白名单（持久化）后才能自动执行。
3. **写类破坏命令**（`git push --force`、`rm -rf`、`git reset --hard`、网络安装等）即使匹配前缀也禁止；需要人单独确认。
4. **读类只读命令**（`grep`/`Read`/`Glob`）免询问。

> Agent 不允许修改 `.claude-settings.json` 扩大自身权限。如果必须扩展，把"为什么需要 + 哪个具体命令"写到 `tasks/<task-id>.md` 等产品主审批。

---

## 5. 工作流约束

### 5.1 分支策略
- 工作分支命名：`<pinyin>1`（与远端现状一致；`zhaiyuanhao1` / `wanghaoyu1` / `wangzuo1` / `zhaotianang1`）。
- 主分支 `master` 与集成分支 `develop` 只接收经过评审的合并；agent 不直接 push。
- 命名要短、要可读：禁止 `tmp`、`asdf`、`x`。

### 5.2 Commit 规范
- 单 commit 单逻辑改动；不混入无关"顺手清理"。
- Message 格式：
  ```
  <scope>: <imperative summary>

  - 改动点 1
  - 改动点 2

  Tests: 加/改了哪些用例
  Docs: 改了哪些文档
  Risks: 风险与回滚方式
  ```
- 包含 `Tests:` `Docs:` `Risks:` 三段可省其一但不得全省；否则 REVISE。

### 5.3 PR 评审 gate（评审 agent R 执行）
逐项打勾：
- [ ] `npx tsc --noEmit` EXIT=0
- [ ] 测试 `npm test` 全绿
- [ ] `verify-panshalach-cleanup.mjs` PASS
- [ ] 文件改动落在 §2 声明的"范围"内；越界文件有解释
- [ ] 公共 API / 持久化路径 / 命名空间变更已写入 `CHANGELOG.md` 或 `docs/panshalach/ROADMAP-NEXT.md`
- [ ] 数据类变更（`EVALUATION.md §4` / `package.json version`）已在 `CHANGELOG.md` 记录
- [ ] 评审 agent R 在 PR 写"Reviewed-by: R (yyyy-mm-dd)"

> 任一项不过 → REVISE。

### 5.4 文档同步
- 改 src 必须同步 docs（架构 / 记忆 / 评测至少其一相关时）。
- 改脚本必须同步 `scripts/*.mjs` 头注释（解释作用 + 用法）。
- 改 `verify-panshalach-cleanup.mjs` 同步 `tests/` 中相应 mock。
- 改 `package.json` 的 `scripts.*` 同步 `docs/panshalach/USER-GUIDE.md`。

---

## 6. 跨 Agent 交接（防漂移）

### 6.1 任务状态持久化
- 每个 agent 在 `tasks/<task-id>.md` 写：进度 / 已完成 / 待做 / 阻塞 / 接口约定（被谁依赖）。
- 长期任务在 `docs/panshalach/ROADMAP-NEXT.md` 的"按里程碑"段落内追加 task 卡片。

### 6.2 写锁（lock）
当 agent A1 改某文件时，先 `touch .agents/locks/<file>.lock` 写明 owner+TTL（≤ 2 小时）。其他 agent 用 `Read` 前先 `cat` 该 lock，发现未过期就**自退**。

### 6.3 上下文接力
- 多轮对话 agent 必须把前几轮"事实摘要"写进 `tasks/<task-id>.md`，避免下一轮 agent 从零推断。
- 严禁"用对话历史当唯一真相"。

### 6.4 决定与拒绝
- 任何 agent 都**有权拒绝**接受超出自身上下文/规格的任务，并在 `tasks/<task-id>.md` 写明理由。
- 评审 agent R 一票否决权只用于合规与质量，不用于观点之争。

---

## 7. 测试与 CI gate

| Gate | 命令 | 触发时机 |
|---|---|---|
| 类型 | `npx tsc --noEmit` | 每次 commit / PR |
| 单测 | `npm test` | 每次 PR |
| 静态一致性 | `node verify-panshalach-cleanup.mjs` | 每次 PR |
| 评测 smoke | `node scripts/eval/smoke-eval.mjs`（mock 模型） | 每次 PR（之后引入） |

> 任何 gate 不通过 = REVISE。`EVALUATION.md §4` 表（真实 openPangu 数据）由 `scripts/eval/run-eval.mjs` 在端点就绪后跑，不进 CI gate。

---

## 8. 冲突与降级

| 情形 | 处理 |
|---|---|
| 两个 agent 同时改同一文件 | 谁先抢到 `.agents/locks/*.lock` 谁继续；另一个 `git pull` 重做；Leader 介入裁决 |
| 测试 flaky（非确定性失败） | 标注 flaky，记录到 `tasks/flaky.md`，但不阻断合并；若 flaky 累积 ≥ 3 处则必修 |
| 自动分类服务（权限 classifier）持续不可用 | agent 切到只读工具继续；写操作改用 `Edit`/`Write`（不需 bash 分类）；通知产品主 |
| agent 删档/误删重要文件 | 评审 R 一票否决；git revert；写入 `tasks/incidents/` |
| 命名硬冲突（如两人 agent 都想改 `RefinedMemoryStore.refine`） | 由 Leader 拆为"接口签名 + 行为"两步：先 R 同意签名，再分别改行为 |

---

## 9. 评审 agent（R）的输出格式

```
Reviewed-by: R <agent-id> (yyyy-mm-dd)

CHECKS
- [x] tsc        : PASS  (TSC_EXIT=0)
- [x] tests      : PASS  (<npm test 实际数>)
- [x] cleanup    : PASS  (verify-panshalach-cleanup)
- [x] scope      : OK    (无越界)
- [x] docs       : OK    (CHANGELOG/ROADMAP-NEXT 已更新)
- [x] api compat : OK    (向后兼容)

SUMMARY
<一段话总结本次改动>

DECISION: APPROVE | REVISE
<若 REVISE，列具体修订要求>
```

> R 的输出必须能在 PR 评论里直接 copy-paste。

---

## 10. Pre-merge 检查清单（agent 自查）

提交 PR 前在描述里勾选：

- [ ] `npx tsc --noEmit` 通过
- [ ] `npm test` 全绿（数量以实际输出为准）
- [ ] `node verify-panshalach-cleanup.mjs` PASS
- [ ] `CHANGELOG.md` 已加条目
- [ ] 改动落在 `tasks/<task-id>.md` 声明范围内
- [ ] 公共 API / 持久化路径 / 命名改动已写入对应文档
- [ ] commit message 含 `Tests:` `Docs:` `Risks:`
- [ ] 已 `cat .agents/locks/*.lock` 确认无他人持有锁
- [ ] **已 `git fetch origin master develop` + `git rebase origin/develop` 同步基线**
- [ ] **PR 描述引用了 `docs/agent/handover/` 中跟自己相关的行**
- [ ] **已 cat `docs/agent/handover/` 确认无未 resolved 项指向自己**
- [ ] **分支名 = `<自己的 pinyin>1`**（附录 B）
- [ ] **自己 `tasks/agents/<pinyin>.md` 已注册**（附录 B）
- [ ] 没有引入新的运行时依赖

> 缺一项 → REVISE。

### 10.1 Git 协作全流程（每次写代码必做）

**A. 开工前（pre-flight，每次开工或 >1 小时未操作后重做）**
```bash
git fetch --all --tags --prune          # 拉远端最新
git fetch origin master develop
git rev-parse --abbrev-ref HEAD         # 必须是 <own-pinyin>1
git status                              # 工作区干净
git diff --stat origin/<own-pinyin>1..HEAD
# 吸收最新 develop 基线
git fetch origin develop
git rebase origin/develop               # 若冲突：解决后 `git rebase --continue`
# 读别人对接口的请求
for f in $(git ls-files docs/agent/handover/ | grep -v README); do
  echo "=== $f ==="
  grep -E "我需要别人确认的接口" "$f" || true
done
```

**B. 写代码过程中（每次 `git commit` 之前）**
```bash
git status
git diff --stat                          # 看清楚改了什么
git add <具体文件>                       # 不要 `git add .` / `-A`
git commit -m "<scope>: <summary>"       # 多行 message 必含 Tests: Docs: Risks:
# 必写日志（防 commit 没记录原因）
cat >> docs/agent/logs/<branch>/<branch>-$(date +%F).md <<EOF

## HH:MM 更新
- 改了：<文件>（理由）
- 跑了：<命令 + 结果>
- 卡点：<无 / 链接其他人>
EOF
```
- 绝不用 `git commit --amend` 已 push 的 commit（改写历史）
- 绝不 `git commit -m ""` 空 message

**C. 推送 / PR 前**
```bash
# 必读所有 handover（尤其别人分支）
for f in docs/agent/handover/*.md; do
  [ "$f" = "docs/agent/handover/README.md" ] && continue
  echo "=== $f ==="; cat "$f"
done
# 推送前再 rebase 一次 develop
git fetch origin develop
git rebase origin/develop
# 推送（严禁 --force，除非与 Leader 约定）
git push origin <own-pinyin>1
```

**D. PR 描述模板**（§9 模板 + 引用 handover）：
```
## What
- <改动点>
## Why
- <目标 + 引用 docs/agent/handover/ 对应行>
## Tests
- npm test → 全绿
## Docs
- <改动的文档/日志/handover>
## Risks
- <风险与回滚方式>
```

**E. 合入 develop（仅 Leader / kultur 决定）**
```bash
git checkout develop
git pull --rebase origin develop
git checkout <pinyin>1
git rebase origin/develop
git log --oneline origin/develop..<pinyin>1
git checkout develop
git merge --no-ff <pinyin>1 -m "merge <pinyin>1: <scope> (#<PR号>)"
git push origin develop
```

**F. 红线（绝不能做）**
- ❌ 直接 `git commit` 到 `develop` / `master`（仅 kultur 能推）
- ❌ `git push --force` 已 push 的 commit（改写历史）
- ❌ 拉 `git pull` 不带 `--rebase`（污染 develop 历史）
- ❌ `git add .` / `-A` 把脏文件一起塞
- ❌ `git commit -m ""` 空 message
- ❌ `git commit --amend` 别人已拉走的 commit
- ❌ 多个 agent 同时改同一文件不协调（必须先 §6.2 写锁 + handover 同步）
- ❌ 把草稿/实验脚本/调试输出提交进仓库（判断标准：评审者必须看到吗？删掉影响别人吗？不影响的→不入 git）

> 违反上面任何一条 → Leader REVISE + 写 `tasks/incidents/`。

---

## 11. 失败兜底与回滚

- 单次 PR 引入回归 → R 拒绝 + git revert 该 commit + 在 `tasks/incidents/<date>.md` 写事后复盘。
- agent 多次违反本规范（故意绕开 allowlist / 篡改 tests / 越过禁用区）→ 撤销其 token / 暂停其在 `.claude-settings.json` 的 allow，进入"冷却期"。
- 仓库级重大破坏 → Leader + 产品主人工介入；优先 `git revert` 而非 `git reset --hard`。

---

## 12. 配套文件速查

| 文件 | 作用 |
|---|---|
| `docs/panshalach/ROADMAP-NEXT.md` | 路线与未完成项（单一计划源） |
| `tasks/agents/<pinyin>.md` | 4 主力注册卡 |
| `docs/agent/` | 协作记忆（日志 + handover） |
| `.claude-settings.json` | Bash 命令自动放行白名单（产品主管） |
| `CHANGELOG.md` | 分版本成果与变更申报记录 |
| `docs/panshalach/ROADMAP-NEXT.md` | P0-P5 详细路线 |
| `verify-panshalach-cleanup.mjs` | 静态一致性 gate |
| `.agents/locks/` | 写锁目录（运行时产生） |
| `tasks/<task-id>.md` | 单 agent 任务卡片（运行时产生） |
| `CHANGELOG.md` | 不可变历史 |

---

## 附录 A — 单 agent 任务卡片模板 `tasks/<task-id>.md`

```markdown
# <task-id> — <简短标题>

owner: <agent-id>
branch: <git branch>
created: <yyyy-mm-dd>

## 范围
- 改：<文件/模块列表>

## 不在范围
- 改：<列出"不动"的相邻文件，明确边界>

## 验收标准
- npx tsc --noEmit 通过
- npm test 通过
- <具体测试名> 覆盖
- <文档段> 已更新

## 进度
- [ ] 步骤 1
- [ ] 步骤 2

## 接口约定（被谁依赖）
- 调用方：
- 被调用：

## 阻塞 / 风险
- ...

## 交接
- 完成时：
  - [ ] commit message 含 Tests/Docs/Risks
  - [ ] Pre-merge 清单全勾
  - [ ] 通知评审 R
```

---

## 附录 B — 分支权限与控制人注册（Hard Rule）

> 本节是**最高优先级 hard rule**，违反直接 REVISE 并锁 agent。由仓库管理员（kultur）在远端 pre-receive hook + CI 中强制执行。

### B.1 受保护分支与可写者

| 分支 | 谁能 push | 谁不能 push |
|---|---|---|
| `master` | **只有 kultur（协调员）** 在评审 R PASS 后合并 | 所有执行 agent |
| `develop` | **只有 kultur** 维护节奏（汇总、集成修复） | 所有执行 agent |
| `<pinyin>1` | 控制人 = `<pinyin>` 的 agent | 其他 agent |

### B.2 启动注册流程（每个 agent 第一次连仓库必做）

1. **agent 读取本文件后必须显式询问其人类控制者的姓名**：
   > "请告诉我您的姓名（中文或英文均可）。我需要按拼音登记您到本仓库的 agent 名册，并为您建立独立的工作分支。"
   - 若用户拒绝或回答未知 → agent 拒绝执行任何写操作，只允许只读工具。
2. **拼音转换**：中文按通用拼音规范无音调（`张三` → `zhangsan`、`欧阳娜娜` → `ouyangnana`）；英文小写连写或 `-` 分段。agent 推断后请用户确认一次。
3. **注册名册**：写 `tasks/agents/<pinyin>.md`（模板见现有 4 张注册卡）。
4. **建独立工作分支**（本地 + 远端同步）：
   ```bash
   git fetch origin
   git checkout -b <pinyin>1 origin/develop
   git push -u origin <pinyin>1
   ```
   若 `<pinyin>1` 已存在 → 拒绝创建并报错。

### B.3 agent 工作边界（硬约束）

- 每个 agent **仅在 `git rev-parse --abbrev-ref HEAD` 输出自己的 `<pinyin>1` 时**才允许 `git add / commit / push / checkout -b`。
- 否则只允许只读类 git 命令（`git fetch / status / log / diff`）。
- 误入 `master` / `develop` → 立即 `git checkout <pinyin>1` 退回。
- 不允许任何 agent 写 `master` / `develop`；远端 hook 拒绝并报警。

### B.4 master / develop 的唯一主人：kultur

| 角色 | 控制人 | 可操作 |
|---|---|---|
| 协调员 | **kultur** | `master` 合并 / `develop` 推进 / 紧急回滚 / 解锁 agent |

- 任何 `git push` 到 `master` / `develop` 必须由 kultur 的 SSH key 签名；agent 即使知道方法也无法执行（远端 pre-receive hook 拒绝）。
- agent 不得注册与 `kultur` 同名分支；不得以任何身份合并到 master/develop；不得 `git push --force` 推这两个分支。
- 产品主（人）临时授权某 agent 推 master（例如紧急 hotfix）→ 必须由 kultur 在 PR 评论里**显式写 `Kultur-authorized: <agent-id> <reason>`**，否则 hook 拒绝。

### B.5 冲突解决

| 情形 | 处理 |
|---|---|
| agent A 想改的代码被 agent B 在其 `<B-pinyin>1` 改动 | A 需 `git fetch` + `git rebase origin/<B-pinyin>1`；解决不了请 kultur 仲裁 |
| 两人控制人 pinyin 同音 | kultur 在末尾加数字区分（`zhangsan-2`），被告知方重命名 |
| agent push master | pre-receive hook 拒 + 通知 kultur + 写 `tasks/incidents/` |
| agent 在自己分支提交敏感信息（密钥 / 私有 endpoint） | kultur 立即 revert + 撤销该 agent 名册 + 冷却期 |

### B.6 名册与分支维护

- 名册目录 `tasks/agents/` 由所有 agent 共享读写。
- agent 离职/移交：控制人通知 kultur → 删除 `<pinyin>.md` → 分支保留 7 天后强制清。
- kultur 每月审计一次名册与分支。

### B.7 远端 hook 与 CI gate（kultur 部署）

远端 hook 见 `scripts/protect-protected-branches.sh`，CI 见 `.github/workflows/agent-branch-guard.yml`。两者校验：

- `master` / `develop` 仅 kultur 可推（SSH key 指纹白名单）。
- 工作分支（`<pinyin>1` 等非保护分支）push 时要求 `tasks/agents/<pinyin>.md` 注册卡存在。
- 分支日报日志 `docs/agent/logs/<branch>/<branch>-<date>.md` 存在。
- build-and-test job：`npx tsc --noEmit` + `npm test` + `verify-panshalach-cleanup.mjs`。

### B.8 客户端自查（agent 每次 `git commit` 前）

```bash
branch=$(git rev-parse --abbrev-ref HEAD)
pinyin=${branch%1}   # 去掉末尾的世代号
if [[ "$branch" == master || "$branch" == develop ]]; then
  echo "✗ agent 不能直接提交到 $branch（仅 kultur 可推）"
  exit 1
fi
if [[ ! -f "tasks/agents/${pinyin}.md" ]]; then
  echo "✗ 缺少注册卡 tasks/agents/${pinyin}.md —— 先询问控制人并注册"
  exit 1
fi
```
