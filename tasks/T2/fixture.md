# T2 Fixture — 实体化指针（U3 周末起 issue + verify.sh stub）

> 状态：U3 周末（赵天昂 2026-09-06）起 issue.md + verify.sh stub
> 下一步：U4 王浩宇补 `repo/`（5-10 文件小型 TypeScript 代码库）+ 强化 verify.sh
> U6 真机 openPangu 端点跑分时使用，R7 评测 C4 消融必跑

## 实体文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `README.md` | ✅ 已落 | T2 任务族契约（跨文件关联场景、Rubric、评测合同） |
| `issue.md` | ✅ 已落 | 中文长程维护场景的跨文件重构 issue（add 函数扩展 bigint） |
| `verify.sh` | ✅ 已落 stub | 占位：检查 repo/ 存在 + 退出 0；U4 王浩宇替换为 npm test |
| `repo/` | ⏳ 待 U4 | 5-10 文件小型代码库（package.json + src + tests） |
| `fixture.md` | ✅ 本文件 | 实体化指针（取代早期"U4 王浩宇实体化"占位） |

## 任务骨架（issue.md 同步）

- `src/utils/math.ts` 的 `add(a, b)` 扩展为 `number | bigint`
- 全仓库 grep 调用点同步更新
- `tests/math.test.ts` 增加 bigint 用例 ≥ 2
- 误改率 = 0（评分维度）

## U4 王浩宇负责

1. 创建 `repo/` 目录（5-10 文件 TS 代码库）
2. 替换 `verify.sh` stub 为：
   - `grep -rE "\badd\s*\(" src/ tests/` 调用点计数
   - `cd repo && npm test` 退出码 0
   - （可选）`tsc --noEmit` 类型一致性

## 与 R7 评测合同对齐

- `taskFamily: T2`
- 期望 `verdict: completed` + `verification.signal: ALL_TESTS_PASSED`
- C4 档必跑：是否使用 n-gram 语义检索召回跨文件引用
