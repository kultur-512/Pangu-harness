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

## 已完成（2026-09-05 → 09-06 增补）

- **0.7.0-0.7.3 主线四连**（develop 已 fast-forward 采纳）：
  - 0.7.1（e88048a/72bdf21）：REPL 手感对标 CC 两批次（Ctrl+C 链路/流式渲染/工具实时卡片/审批倒计时/Tab 补全/横幅 v2）+ backlog 文档 8 项 + C/F 组技术债 + D1/D3 契约脚本。
  - 0.7.2（ff6dce9）：意图分类前移 4/4 入口（chat/search 运行时首次可达）+ finalizeTaskMemory 记忆落定主线版 + 集成测试（先红后绿）+ SUBMISSION 定稿 + DEPLOY-CN 新建。
  - 0.7.3（9677bd1）：五源差距审查（CC/dsh/hermes/oh-my-pi/红队）驱动 13 项——真实成功信号入册（分段尾锚定）、三入口审批/signal 透传、中断现场落盘、窗口预算挂真值、finish_reason 防御、answered 防呆等；三路 review（bug/注释清理/md 修订）闭环。
  - 0.6.5（8fad5e8）：npm link 部署 + modelSeed 配置播种 + --approval + FC 请求侧 + 写工具全档位。
- **命题偏离报告**（5e8efce，ALIGNMENT-REVIEW-0.7.3.md）：主线与命题对齐判定 + 两次历史偏离回正记录。
- 全量测试 629→664 例全绿；tsc 干净；cleanup/protected-files 契约脚本 PASS。

## 当前关注（Leader 视角，9/6）

- origin/develop 已 fast-forward 至 5e8efce（0.7.3 主线被采纳）。
- 王浩宇：已 rebase 至 0.7.3 主线（behind 0），R3 Turn.result 结构化 + eval runner 骨架 + PANSHA_NO_MEMORY——**待 B1 评审**。
- 赵天昂：已 merge develop，T1-T3 fixture 实体化 + embed 单测——**R6 真实数据只差端点**；**两人同动 eval 域，合并日需仲裁分工边界**。
- 王佐：R4/R5 已落但基座仍 0.6.4（behind 7）——**需通知 rebase 至 0.7.3**。
- wanghaoyu1 出现无意义 commit message（"没看懂这是啥"，4bf1884）——B1 评审时按 AGENT-CONTRIBUTION 提交规范指出。

## 备注

- 分工矩阵见 `WORK-PLAN-2DAY-UNITS.md`；技术路线见 `docs/panshalach/ROADMAP-NEXT.md`。
