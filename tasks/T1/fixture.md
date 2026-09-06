# T1 Fixture — 实体化指针（U3 周末起，U6 跑分使用）

> 状态：U3 周末（赵天昂 2026-09-06）起 issue.md + verify.sh
> 下一步：U4 王浩宇 review + 强化 verify.sh（可选：加更多约束类型）
> U6 真机 openPangu 端点跑分时使用，A/B/C/C4 四档消融必跑

## Prompt 加载（runner 契约）

run-eval.mjs 的 prompt 源 = `issue.md`（指针加载，正文整体作为 prompt）。
本文件不再承载 issue 正文，仅做实体化指针。

## 实体文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `README.md` | ✅ 已落 | T1 任务族契约（场景、Rubric、评测合同） |
| `issue.md` | ✅ 已落 | 中文长程维护场景的 5 条约束 issue 正文（**prompt 源**） |
| `verify.sh` | ✅ 已落 | 5 条约束自动检查（PASS 5/5 + FAIL 准确，含 PASS+FAIL 单元测试） |
| `fixture.md` | ✅ 本文件 | 实体化指针（取代早期"U4 王浩宇实体化"占位） |

## 5 条约束（issue.md 同步）

1. 文件名 `TODO.md`（大小写敏感）
2. 包含 5 个 markdown checkbox（`- [ ] xxx`）
3. 每个 checkbox 后跟 1 个空行
4. 无 Unicode emoji（覆盖 5 个主流 Unicode block）
5. 无 tab 字符

## verify.sh 测试覆盖

```
PASS 测试：5/5 全过（合规 TODO.md）
FAIL 测试：C2（checkbox 数不对）+ C3（无空行）准确识别
```

## U4 强化方向（wanghaoyu 草案模式并入）

wanghaoyu 58abf64 草案的 verify.sh 模式（仓库内修改型实例：改 GerundSpinner.ts
帧率 80→100ms + `npx tsc --noEmit` 编译门）作为 U4 可选强化方向保留：
- 实例变体可加"编译门"检查（`npx tsc --noEmit` 退出码 0）
- 该仓库内修改型草稿未被本实例 verify.sh 覆盖，正文见 git 历史（58abf64 :3 版 fixture.md）

## 与 R6 评测合同对齐

- `taskFamily: T1`
- `verification.commands` 至少包含 `verify.sh`
- 期望 `verdict: completed` + `verification.signal: PASS`
- B 档：`injectedCardIds.length >= 1`（line-defense）
- A 档：无记忆，必须真溢出（不溢出标 overflow-skipped）
