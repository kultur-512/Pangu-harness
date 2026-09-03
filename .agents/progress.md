# 项目进度

## 当前批次
- [x] P0-1 安全五件(S1-S5)— commit 9cdfc5f · 全量 483 用例绿
- [x] P0-2 功能(B1+B12)— commit 2aca637 · 全量 485 用例绿
- [x] P0-3 路径贯通(B2+B7+B8)— commit 0de3b8f · 全量 488 用例绿
- [x] P1 功能(B3-B6+/init 闭环)— commit 9e60d4c · 全量 497 用例绿
- [x] P2 清理(B9-B11+文档)— commit 98d2e81 · 全量 497 用例绿
- [x] 二级审查验收 — commit a5fc153 · docs/REVIEW-2ND-AUDIT.md · 发现 T-27~T-29

## 进行中
- feature-2(审查缺陷闭环验收):5 批已交付,遗留 3 项待人类决策

## 阻塞
- T-27【高危】MCP 'a' 提权(engineAdapter.ts:213)— 修复指令清单遗漏,需人类拍板是否追加 P0-1 补丁
- T-28【高危】readonly 命令链穿透(readonlyAllowlist.ts:30-41)— 同上
- T-29【回归·P1】双 Esc 清空失效(InputBar.tsx:127-155)— B5 引入,需人类拍板是否追加 P1 补丁
