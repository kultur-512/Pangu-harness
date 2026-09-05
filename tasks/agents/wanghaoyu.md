# Agent 注册卡 — wanghaoyu

- 控制人: 王浩宇
- 拼音:   wanghaoyu
- agent-id: <待填写>
- 注册日期: 2026-09-04
- 工作分支: wanghaoyu1
- 角色:  **Doer（实干）**
- 任务线: P0 记忆拆解 + ContextCompiler + P4 eval runner

## 工作内容（按 U1-U9 矩阵）

- ~~U1 `MemoryCard` v2 字段~~ **裁决不做**（对抗评审：悬空伪 provenance；provenance 由 rollout `context` 事件承担，已落）。
- ✅ U1 `markUsed` **二态已落地**（bf5f4a7，Leader 代做）：`markInjected`（记账）/ `markVerified(cardIds, now?)`（保鲜）；markCited 推迟。**你的剩余活**：`markVerified` 信号源接线（工具写入/验证文件集 ∩ 卡.referencedFiles）+ refine 生产调用点（§7.1 最紧要缺口）。
- U2 5 维评分：`priority/confidence/validity/utility/freshness`；`weight × decay` 改 `priority × freshness`。
- U3 `ContextCompiler`：统一预算装箱，替代 `PromptBuilder` 拼接逻辑；`ContextSnapshot` 每次模型调用产出。
- U4 `scripts/eval/run-eval.mjs` 骨架：A/B/C/C1-C4 五档 + T1-T5 stub；U5 `smoke-eval.mjs` mock 模式。
- U6-U7 真 openPangu 端点跑评测出 `scripts/eval/results/<date>.json`；U8 评测 CSV + 报告。

## 接口协调

- 与翟苑皓（U1）协调 `ModelClientOutput` 类型签名。
- 与王佐（U1）协调 `MemoryEventStore` schema（runner 抓事件）。
- 与赵天昂（U1）协调 `Assertion` schema。

## 备注

- 分工矩阵见 `WORK-PLAN-2DAY-UNITS.md`；技术路线见 `docs/panshalach/ROADMAP-NEXT.md` P0.4/P2/P3/P4。
