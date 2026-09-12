# B 组评审纪要（合入窗口 2026-09-08 · develop=b4093f1）

> Leader 评审职责（backlog B1-B4）。本次合入窗口由 kultur 直接合入三支（wangzuo1/zhaotianang1/zhaiyuanhao1），王浩宇一支由 Leader 评审后合入。B2/B3 转为**事后评审**（代码已在 develop 且全量 749 例验证通过）。

## B1 王浩宇（wanghaoyu1）——评审通过，已合入（b4093f1）

3 个独有提交：`49238f4`（RunCommand 接线 runAgentTask + PANSHA_TASK_ID/STATE_FILE）、`54a56c7`（A/B 档消融定义修正——原 A↔B 翻转，修正后与 ABLATIONS 合同一致）、`58838e9`（Windows spawn @path 展开修复 + fill-evaluation 字段对齐）。

评审四问：①真实调用点 ✓（validateResult 写盘前拦截，schemaErrors>0 时跳过写盘 exit 1）②可重建性 ✓（schema.mjs 与 develop 逐字节一致，零冲突）③prompt-diff ✓（PANSHA_NO_MEMORY 零注入契约对齐）④验证退出码 ✓（T2/T3 verify.sh 实跑：FATAL=2 / 16 项全过=0 / 缺词=10，语义正确）。

## B2 王佐（wangzuo1）——事后评审通过（kultur 已于 5721979 合入）

R4（src/memory/events.ts 查询层 138 行 + 5 单测）+ R5（src/memory/taskState.ts 持久化 241 行 + 乐观锁 + 5 单测）+ types.ts 加性 2 行。纯新文件 + 加性字段，与主线零冲突；全量 749 例含其 10 例单测全绿。**跟进项**：TaskState 注入槽位与 /task CLI 仍未接（U2-U3 剩余，王佐继续）。

## B3 赵天昂（zhaotianang1）——事后评审通过（kultur 已于 7d87b4a 合入）

0.7.4 R6 域销项：continueCount 死字段删除（attemptCount 替代）+ TurnStopReason 同步 0.7 口径。合入后 `verify-panshalach-cleanup.mjs` 0.7 段恢复 PASS（契约漂移销项兑现）。**跟进项**：schema.mjs 6 态 vs types.ts 7 态（'error'）缺口——已在评审中确认，由 Leader 侧销项（下一窗口）。

## B4 自我对照（zhaiyuanhao1）——已随 develop 合入

0.7.4（中断语义/error 态/?透传）+ 文档对齐 + 0.8 立项 + setRunning 双发修复 + 注释/md 清理。评审四问自查：全绿 749 例 + 双契约脚本 PASS。

## 合入后 follow-up 回传清单（7 条，责任人标注）

| # | 项 | 责任人 |
|---|---|---|
| 1 | **B 档记忆 seeding + RefinedMemoryStore 隔离**（干净 workspace 下 B/C/C4 必 0 注入 → invalid；memory 未随 TaskState 隔离，跨档位串扰）——真实跑分前必修 | 赵天昂（eval harness）+ 王浩宇（memory 隔离） |
| 2 | T3 document.md 扩至 ≥10K tokens 并接入 runner（parseIssueMarkdown workspace/附件机制）——当前 T3 退化为 ~600 token 短 prompt | 王浩宇 |
| 3 | `parseVerification` cmdPatterns 增补 `bash verify.sh` | 王浩宇 |
| 4 | verify.sh 补 chmod +x + 修正退出码注释（exit $FAIL 语义） | 王浩宇 |
| 5 | package-lock npmmirror resolved 地址 CI 兼容 | 王浩宇 |
| 6 | schema.mjs 补 'error' 态（7 态同步 types.ts） | Leader（下一窗口） |
| 7 | T4/T5 fixture 补 front matter；T3 README 检查项数过期修正 | 赵天昂 |

## 合入后状态

- develop=b4093f1：四分支全部产出合入完毕，**团队 20 天产出全部进集成线**。
- 验证：tsc 干净；全量 749（748+1skip+0 fail）；cleanup/check-protected-files 双 PASS。
- 下一步：主线②（0.8 M1 第 2 步四模块搬家 + M2-2/M2-6）。
