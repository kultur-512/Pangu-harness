# 反思迭代方案（0.7.2 · 2026-09-05）

> **执行状态：已执行**（commit ff6dce9）——动作 1（意图前移 4/4 入口接线）、动作 2 主线部分（finalizeTaskMemory 单一落定点，Repl 直调三口留统一执行器）、动作 4（SUBMISSION 定稿 + DEPLOY-CN 新建）、动作 5 测试部分（集成测试 4 例先红后绿）全部落地；动作 3（R6 评测合入）与三分支合入按计划移交。验收数字见 CHANGELOG「0.7.2」段（629 例 628+1skip+0 fail）。

> 输入：反思审查报告（8 维度全面回扫）× 本轮 UI 改造/backlog 执行的评审记录。
> 核心结论：**主线空心化**——0.7/0.7.1 在集成线上完成了终止语义与 UI 工程，但命题三大支柱（意图分类、记忆闭环、评测）的真实实现分别处于"死代码 / 半闭环 / 不在主线"状态，且团队三人的实现本体滞留在未合入、部分已与 0.7 架构脱节的分支上。625 例全绿掩盖了这三点（全绿里没有一条入口级意图路由或记忆落定的集成断言）。

## 八维度诊断摘要

| 维度 | 严重级 | 一句话 |
|---|---|---|
| D1 意图分类错位 | P0 | 四入口在富化文本上分类，富化文本必含执行词 → chat/search 恒不可达；0.7 宣称的修复运行时未生效 |
| D2 记忆主线成色 | P0 | 注入→使用→验证→保鲜 4 环只真 1 环（注入记账）；refine/markVerified 生产调用点为零；实现本体在未合的 wanghaoyu1 且语义依赖已删除的判官 |
| D3 评测就绪度 | P0 | scripts/eval 主线为零（zhaotianang1 未合）；C 档依赖的 R4/R5 也不在主线 |
| D6 提交物 | P0 | SUBMISSION ≈20% 骨架；DEPLOY-CN.md 不存在（0%） |
| D7 协作面 | P0/P1 | 三分支全部植根 0.6.4；B1-B3 评审未做；0.7.1 未进 develop |
| D4 UI 残留债 | P1 | sseInteractive 2087 行/单函数 ~1690 行过拆分临界；巨函数体零覆盖 + 真机手测未做 = 双盲 |
| D5 测试盲区 | P1 | 全绿但意图路由/记忆落定/loop 端到端三条关键路径零覆盖；无测试 CI（D7 backlog 项） |
| D8 性能预算 | P1 | 每步重发 5-10K 固定头 ×12 步；compact 阈值 120K 字符窗口无关，8K 模型可无声溢出 |

## 迭代动作（Top5）与本轮执行范围

| # | 动作 | 工作量 | 本轮执行 |
|---|---|---|---|
| 1 | 意图分类前移接线（入口原文分类 → buildForTask(intent) + solveIssue({intent})） | S | ✅ 本轮执行 |
| 2 | 三分支合入决战 + R1/R2 基于 0.7.1 重写 finalizeTaskMemory | L | ⚠️ 本轮执行主线版 finalize 落定（单一落定点 runAgentTask result 后）；**合入他人分支需评审流程（B1-B3），不在本轮单方面执行** |
| 3 | R6 评测骨架合入 + mock smoke | M | ⏸ 需合入 zhaotianang1（B3 评审），本轮不做；已列为最高优先移交项 |
| 4 | SUBMISSION 定稿 + DEPLOY-CN 从零到一 | M | ✅ 本轮执行 |
| 5 | 三条集成测试（greeting→answered / .ts→search readonly / completed→自动产卡）+ 真机手测 | S | ✅ 测试本轮执行（作为 1/2 的验收器）；真机手测待 LM Studio 端点恢复（F6，禁止预填 PASS） |

## 验收门（本轮）
1. 入口级：`"你好，回答我你是谁"` 走 chat 直答（无格式教学块、stopReason='answered'）；`整理 src/foo.ts 的导出` 走 search readonly ≤3 步。
2. 记忆落定：completed 任务后 `refine→save` 自动产卡；注入卡 referencedFiles 与轨迹写集交集 → markVerified 刷新 lastUsedAt（单测）。
3. 全量测试绿 + tsc 干净 + 两个脚本 PASS。
4. SUBMISSION/DEPLOY-CN 脱离"骨架"自述（评测数据位保持诚实占位）。

## 明确不移交本轮的（防范围蔓延）
- sseInteractive 拆分（1.x）；ink/rich 路径处置（1.x）；per-model 窗口硬预算（D8，登记 ROADMAP §3.2 后续）；分支合入与 B1-B3 评审（评审流程，非本 agent 单方面动作）。
