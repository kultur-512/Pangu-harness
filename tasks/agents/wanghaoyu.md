# Agent 注册卡 — wanghaoyu

- 控制人: 王浩宇
- 拼音:   wanghaoyu
- agent-id: <待填写>
- 注册日期: 2026-09-04
- 工作分支: wanghaoyu1
- 角色:  **Doer（实干）**
- 任务线: R1 refine 回合写闭环（最紧要）+ R2 markVerified 信号源 + R6 eval runner

## 工作内容（按 U1-U9 矩阵）

- ~~U1 `MemoryCard` v2 字段~~ **裁决不做**（对抗评审：悬空伪 provenance；provenance 由 rollout `context` 事件承担，已落）。
- ✅ U1 `markUsed` **二态已落地**（bf5f4a7，Leader 代做）：`markInjected`（记账）/ `markVerified(cardIds, now?)`（保鲜）；markCited 推迟。**你的剩余活**：`markVerified` 信号源接线（工具写入/验证文件集 ∩ 卡.referencedFiles）+ refine 生产调用点（§7.1 最紧要缺口）。
- ✅ **R0 前置已由 Leader 落地（2026-09-05）**：count 翻倍修复（createOrUpdateCard/addRemember 克隆 + mergeAndCap 整卡替换——你接 refine→save 时**不要再做同 id 累加**，卡对象已带解析后的 count）；双层终止（end_turn 停 + 判官续跑）；withRetry/空批保护；streamChat 透传。R1 hook 只在真落定触发一次（判官续跑期间不提炼）。
- ~~U2 5 维评分~~ **按对抗评审裁决推迟**（量纲不同构、utility 无信号源）——检索维持 `0.7w+0.3rel`；本位转 R3/R6。
- U3 ~~ContextCompiler~~ **按裁决推迟**（PromptBuilder 保持拼接器 + 统一账本；ContextSnapshot 逐任务事件已由 Leader 落地 bf5f4a7）——转 R6 eval runner。
- U4 `scripts/eval/run-eval.mjs` 骨架：A/B/C + C4 消融 + T1-T5 stub；U5 `smoke-eval.mjs` mock 模式。
- U6-U7 真 openPangu 端点跑评测出 `scripts/eval/results/<date>.json`；U8 评测 CSV + 报告。
- R1 批次顺带：`runAgentTask` 把 `ctx.signal` 传入 `solveIssue` 配置（当前请求取消不停止底层执行，方案书草案发现）。

## 接口协调

- ~~与翟苑皓（U1）协调 `ModelClientOutput`~~ ✅ 已定稿（df7a119）。
- 与王佐（U2+）协调 `readAgentEvents` 查询接口（runner 抓事件）。
- 与赵天昂（U4+）协调 eval runner API 与 R3 Turn 结构化字段（L1 envelope 输入）。

## 备注

- 分工矩阵见 `WORK-PLAN-2DAY-UNITS.md`；技术路线见 `docs/panshalach/ROADMAP-NEXT.md` P0.4/P2/P3/P4。
