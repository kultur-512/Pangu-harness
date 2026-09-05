# Agent 注册卡 — zhaiyuanhao

- 控制人: 翟苑皓
- 拼音:   zhaiyuanhao
- agent-id: claude-code
- 注册日期: 2026-09-04
- 工作分支: zhaiyuanhao1
- 角色:  **Leader（超级骨干）**
- 任务线: 评审/接口仲裁 + 迭代3（/model list 通用化 + env 顶层块）+ R9 收口总责

## 工作内容（2026-09-05 修订，对齐 ROADMAP-NEXT §3）

- 迭代3（U3-U4）：`.panshalach.json` 顶层 `env` 块（ConfigManager 分层合并）+ `/model list` 完全走 ProviderRegistry（删 scnet 直读分支）。
- 评审其余 3 主力 PR；U4 接口契约对齐 stand-up；U6 合并 develop + ARCHITECTURE.md 执行链路图。
- R9（U8-U9）：项目书 SUBMISSION.md 终稿 + EVALUATION.md 回填 + 提报收口。
- P6 存储名迁移目标裁决（PANSHA_*→PANG_* 方向冲突，路线图已冻结待拍板）。

## 已完成（不再重复做）

- 协议与适配器去品牌（`StrictStructuredToolAdapter` / `XmlStructuredToolParser`，commit 17851f9）。
- Provider 层 glm shorthand 删除、`_pickBestProviderModel` 泛化（commit 17851f9）。
- 接口契约 v2：types.ts `AgentEvent/Assertion/TaskState` + rolloutStore `agent` schema（df7a119）。
- tool_calls 透传：openai-compatible 结构化返回 + SSE delta 拼装 + chaser 聚合（df7a119）。
- env 三件套 `PANSHA_<PROV>_*` + apiKeyCmd + headers + getModelContextLength 跨 provider + 死代码 5 文件删除（df7a119）。
- 记忆 v3：markInjected/markVerified 二态、衰减锚 max 修复、archived 过滤、[M1] 卡号、compact generation/coveredTurnIds + rollout compact/context 事件 + replay 消费（bf5f4a7，含王浩宇的 markUsed 二态部分——他只需做信号源接线）。
- 摘除批次：打分器/score 整体移除（0.6.1/0.6.3）、#1-#7 性能装置摘除（0.6.2，8998efe）。

## 备注

- 分工矩阵见 `WORK-PLAN-2DAY-UNITS.md`；技术路线见 `docs/panshalach/ROADMAP-NEXT.md`。
