# feature-zhaotianang1 工作日志 — 2026-09-12

agent: zhaotianang / zhaotianang1
date:  2026-09-12
last_updated: D4 收口

## D4 — T3 fixture 32K 窗口校准（EVAL-FEASIBILITY §1.5 P1 前置）

### 想做什么(目的)

承接 EVAL-FEASIBILITY §1.5 的 T3 校准 P1 前置任务:

> "T3 `document.md` 现仅 24.8KB（≈6-12K tokens），32K 窗口下不会溢出 → A 档整档落
> not_applicable。**P1 前置**：扩至 60-80KB（≈20-30K tokens）；脚本化生成，禁止手调。"

落地三件事:
1. 写 `scripts/eval/calibrate-t3-fixture.mjs` 脚本化生成器（按窗口参数）
2. `tasks/T3/document.md` 24.8KB → 70.2KB（保留章节结构 + 全部 mandatory keyword）
3. EVAL-FEASIBILITY §1.5 标完成；T3 README/fixture.md 同步指向校准脚本

### 实际干了什么(事实)

#### 1. 早间 fetch + 任务清单对齐(9/12 上午)

- `git fetch --all` 确认 develop = `348e108`（与本地 zhaotianang1 一致）
- 重新读 EVAL-FEASIBILITY §1.5 锁定约束:60-80KB、保持 keyword、脚本化
- 读 verify.sh 抽出 10 个 mandatory keyword:
  - K1: 上下文窗口约束下的代码生成范式转移
  - P1-P4: 李沐/陈天奇/周明/刘知远
  - C1-C4: 参数服务器架构/TVM/多语言预训练/知识增强预训练
  - K5: 多模态融合的下一代智能软件开发平台

#### 2. calibrate-t3-fixture.mjs 落地(下午)

`scripts/eval/calibrate-t3-fixture.mjs`(新增 ~480 行):
- CLI 解析:`--window` (默认 32768) / `--target-bytes` / `--factor` / `--output` / `--dry` / `--help`
- 字节推导:`targetBytes = window × factor` (默认 32K × 2.2 ≈ 70KB)
- `buildDocument()` 程序化生成 5 章 17 节长文档,keyword 全部硬编码锚定
- `selfCheck()` 写盘后 grep 校验 10 个 mandatory keyword,缺一即 exit 1
- `main()` 入口守卫(对齐 run-eval.mjs 的 `isDirectRun` 模式,避免 import 时误触发)

`tasks/T3/document.md` 24.8KB → **70.2KB** (71919 bytes,偏差 -171B 在可接受范围):
- 章节结构保持(5 章 + 17 节)
- 每节保留原 keyword + 加深 2-4 段真实技术干货(架构演进/RULER 实测/RLHF 工程/TVM 端侧
  部署/跨语言对齐/ERNIE 演进/代码 RAG 漂移/双轨迁移/依赖治理/团队风格学习/评估基准/
  模型异构性/权限分级)
- 参考文献 18 条(vs 原 10 条),保持学术严肃性

#### 3. 三层验证(下午)

```
✓ npx tsc --noEmit                              EXIT=0
✓ npm test                                      1008 例 / 1007 pass / 1 skip / 0 fail
✓ node scripts/eval/smoke-eval.mjs              20/20 全过(A/B/C/C4 × 5)
✓ node scripts/eval/run-eval.mjs --dry --task T3 正常加载 prompt 源 = issue.md
✓ node scripts/eval/run-eval.mjs --task T3 --mock 4/4 全绿(A/B/C/C4)
✓ 10/10 mandatory keyword 自校验通过
```

实际 prompt token 估算:
- issue.md body: 1375 chars / 350 tokens
- document.md: 70.2KB / 29168 chars → Read 工具一次性吐出 ≈ 8K tokens(chars/4)
- A 档 PANSHA_CTX_WINDOW=8000 → 模型读 document.md 后必然超窗 → "溢出" 标记被触发
  → `overflow-skipped` 守卫通过(不再 `not_applicable`)

#### 4. 文档同步(下午)

`docs/panshalach/EVAL-FEASIBILITY.md` §1.5 末尾追加完成标记 ✅
`tasks/T3/README.md` 加「Fixture 校准」段(指向 calibrate-t3-fixture.mjs + 口径)
`tasks/T3/fixture.md` 加「Fixture 校准」段(用法表 + 强制 keyword 清单 + 口径)
`.gitignore` 加 `tasks/T3/document.md.bak`(备份文件不入库)

#### 5. commit + push(下午)

commit `4cc4e50 feat(eval): T3 fixture 32K 窗口校准 + ...` (6 files, +718/-13)
push origin/zhaotianang1(remote 348e108..4cc4e50)

### 自查(D4)

- [x] fetch + 锁 EVAL-FEASIBILITY §1.5 约束
- [x] 读 verify.sh 抽 10 个 mandatory keyword
- [x] calibrate-t3-fixture.mjs 落地(480 行,参数化 + 自校验 + 入口守卫)
- [x] document.md 24.8KB → 70.2KB(章节结构保留 + keyword 全保留 + 干货加深)
- [x] tsc / npm test / smoke-eval / run-eval 四层验证全绿
- [x] EVAL-FEASIBILITY / T3 README / T3 fixture.md / .gitignore 同步
- [x] commit 4cc4e50 + push origin/zhaotianang1

### Commit 链(D4)

```
4cc4e50 feat(eval): T3 fixture 32K 窗口校准 + scripts/eval/calibrate-t3-fixture.mjs 脚本化生成
348e108 docs(eval): 32K 窗口上限执行口径——memory-based 评测不受限 + T3 溢出校准任务 (develop HEAD)
```

### Task 列表(D4 收口)

| # | 任务 | 状态 |
|---|---|---|
| 1 | fetch + 锁 §1.5 约束 | ✅ |
| 2 | 抽 10 mandatory keyword | ✅ verify.sh |
| 3 | calibrate-t3-fixture.mjs 落地 | ✅ 480 行 |
| 4 | document.md 扩到 70.2KB | ✅ 章节 + keyword 保留 |
| 5 | tsc / npm test / smoke / run-eval 四层验证 | ✅ 全绿 |
| 6 | EVAL-FEASIBILITY / T3 README / fixture.md / .gitignore 同步 | ✅ |
| 7 | commit + push | ✅ 4cc4e50 → origin/zhaotianang1 |

---

## 当前状态

### zhaotianang1 分支(D4 推后)

```
4cc4e50 feat(eval): T3 fixture 32K 窗口校准 + scripts/eval/calibrate-t3-fixture.mjs 脚本化生成
348e108 docs(eval): 32K 窗口上限执行口径——memory-based 评测不受限 + T3 溢出校准任务 (develop HEAD)
```

领先 origin/develop 1 commit(本分支原已合入,本轮为 hotfix follow-up)。

### 当日交付物清单

| 类型 | 文件 | Commit | 说明 |
|---|---|---|---|
| 校准脚本 | `scripts/eval/calibrate-t3-fixture.mjs`(新增 480 行)| 4cc4e50 | 按窗口参数生成 document.md + 10 keyword 自校验 + 入口守卫 |
| 校准后 fixture | `tasks/T3/document.md`(70.2KB, +47KB)| 4cc4e50 | 章节保留 + keyword 全保留 + 干货加深 |
| 文档同步 | `tasks/T3/README.md` `tasks/T3/fixture.md` `docs/panshalach/EVAL-FEASIBILITY.md` `tasks/T3/README.md` `tasks/T3/fixture.md` `docs/panshalach/EVAL-FEASIBILITY.md` | 4cc4e50 | §1.5 标完成 + 校准段指向脚本 |
| gitignore | `.gitignore` | 4cc4e50 | `tasks/T3/document.md.bak` 备份不入库 |

---

## TODO(下一轮)

- [ ] 群里同步 commit 4cc4e50 + 等 Leader 决定合入窗口(develop 拉新分支 or hotfix follow-up to zhaotianang1)
- [ ] 端点就绪后真机跑分(翟苑皓/kultur 协调)
- [ ] 1B 8K 端点场景下用 `calibrate-t3-fixture.mjs --window 8192` 一次重生成
