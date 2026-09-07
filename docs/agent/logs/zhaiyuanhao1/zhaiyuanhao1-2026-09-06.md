# zhaiyuanhao1 工作日志 — 2026-09-06

## 主线：0.7.1 → 0.7.3 三连 + 两份审查报告（develop 已采纳）

- **0.7.1**（e88048a / 72bdf21）：REPL 手感对标 CC（5 份调研中的 CC 解剖 + 病灶清单 → UI-UX-REVAMP-0.7.1.md → 批次 A/B）。P0 信任级（Ctrl+C 链路/审批倒计时/清行纪律）+ 反馈级（真流式/工具实时卡片/结束总结块）+ 引导级（横幅 v2/Tab 补全/模式徽标）；backlog 文档 8 项 + C/F 组技术债 + D1/D3 契约脚本。三路 review 修 11 bug（最重：'a' 决策回归）。
- **0.7.2**（ff6dce9）：反思审查（8 维度）揭出"主线空心化"→ 意图分类前移 4/4 入口（chat/search 运行时首次可达，此前 classifyTaskIntent 在富化文本上恒判 execution）+ finalizeTaskMemory 记忆落定主线版 + 集成测试先红后绿 + SUBMISSION 定稿 + DEPLOY-CN 新建。
- **0.7.3**（9677bd1）：五源差距审查（CC/dsh/hermes/oh-my-pi/红队对抗自审，9 子智能体）→ USABLE-PLAN-0.7.3.md（方案评审 5 条修订吸纳）→ 13 项执行。红队实测 P0 双杀：classifySignal 只认 smoke mock 字面量（真实成功判 FAIL→5-6 步掐死）与 completed 真机不可达（记忆闭环死码）——真实引擎形状信号入册（分段尾锚定）+ completed 需真实验证步；三入口审批/signal 透传；中断现场落盘（partialText）；窗口预算挂真值（8K 模型不再无声溢出）；finish_reason 防御。三路 review 再修 7 bug（P1-1：read/grep 正文含字面 PASS 的全文扫描误判，本仓库源码即触发器；P1-2：write≠验证，APPLIED=PARTIAL）。
- **命题偏离报告**（5e8efce，ALIGNMENT-REVIEW-0.7.3.md）：主线对齐判定 + 两次历史偏离回正记录。

## 测试与验证

- 全量 629 → 664 例（663 pass + 1 skip + 0 fail）；tsc 干净；verify-panshalach-cleanup / check-protected-files 双 PASS。
- 注释噪声清理：15 个 src 文件（删 9 / 改写 222，代码行零变更）。

## 团队节奏观察（B6 被动巡检）

- **origin/develop 已 fast-forward 至 5e8efce**（0.7.1-0.7.3 主线被采纳）。
- **zhaotianang1**：已 merge develop（6d09528），T1-T3 fixture 实体化 + embed/cosine 单测 + 9/6 日志——R6 距真实数据只差 kultur 端点。
- **wanghaoyu1**：已 rebase 至 0.7.3 主线（behind 0）——R3 Turn.result 结构化字段（goal/changedFiles/verifyCmd/outcome）、eval runner 完整骨架、PANSHA_NO_MEMORY 消融开关。⚠️ 4bf1884 commit message "没看懂这是啥" 违反提交规范，B1 评审时指出。
- **wangzuo1**：R4（events.ts 查询层+5 单测）/ R5（taskState.ts 持久化+乐观锁）已落，但基座仍 0.6.4（behind 7）——**待通知 rebase**。
- ⚠️ wanghaoyu1 与 zhaotianang1 同动 `scripts/eval` 域（runner 骨架 vs fixture/单测）——合并日需 Leader 仲裁分工边界。

## 明日候选

- B1 评审 wanghaoyu1（R3 + eval runner，11 commits）；通知王佐 rebase。
- kultur 端点恢复 → F6 真机四用例 + R6 真实数据首跑。
- 迭代3（/model list 通用化 + env 顶层块）——任务卡上仍挂未做。

## 0.7.4 批次（部署陈旧 dist + 中断语义修正 + `?` 透传）

### 想做什么（目的）

控制人实测"提交任务后莫名中断（235ms）"：LM Studio 对 diffusion 模型（openpangu-7b-diffusion-base-i1）chat/completions 返回 200-garbage → EMPTY_RESPONSE → streamChat 回退裸 doComplete 穿透 → chaser 兜底硬编码 `stopReason='aborted'` → 模型错误被伪装成用户中断。同时确认 zhulong 跑的是 00:03 旧 dist（0.7.1 批次 B 中途），0.7.2/0.7.3 修复全不在。方案：`docs/panshalach/PLAN-0.7.4-FOR-CLAUDECODE.md`（控制人下达，Claude Code 执行）。

### 实际干了什么（事实）

- **A 部署**：npm run build 重建；`src/cli.ts` warnIfDistStale()（mtime 对比 + TTY only + headless 静默）。
- **B 中断语义**：TurnStopReason/TurnOutcome 加性 `'error'`（REFACTOR-ASSESSMENT §4 申报 ⑦，队友需 rebase）；syntheticFailureTrajectory 按 isAbortLikeError 区分 aborted/error；streamChat 三处裸回退收敛为 completeLikeFallback（withRetry + emptyResponse 转空串）；EMPTY_RESPONSE 文案追加 diffusion 指引；UI 四态文案（error → "✗ 任务执行失败" + 端点提示）；abortPromise 死代码删除 + aborted turn 落盘并入统一路径（顺带补齐活路径 partialText 缺口）。
- **C `?` 透传**：line 主路径 `trimmed === '?'` 截获删除（控制人裁决"输入问号也是给模型的信息"）；/help 与 buildQuickHelpLines 保留；横幅第三行同步。
- **D hermes 二次对齐**：`docs/panshalach/HERMES-ALIGN-0.7.4.md`——五项判定 4 推迟/拒绝 + 1 最小采纳候选（classic 路径 solveIssue 漏传 windowTokens，0.7.3 窗口预算该路径不生效）。
- **E 问题 2**：tool schema ≈2K token/请求结论登记 ROADMAP-NEXT §3.2 低优先（intent 过滤 / PANSHA_TOOLS_MODE / description 一行化），不实施。

### 测试与验证

- tsc EXIT=0；全量 716 例：715 pass + 1 skip + 0 fail（基线 664 + 新增 ErrorSemantics 7 / QuestionMarkPassthrough 3 / streamChat 回退重试 2）。
- check-protected-files PASS；verify-panshalach-cleanup 静态 PASS——0.7 段 continueCount zero refs FAIL 为 R6 域 schema.mjs/smoke-eval.mjs 残留（f9219ee 引入，本轮前已存在，禁越界销项）。
- rebuild 后 dist 特征 grep 全中（completeLikeFallback/isAbortLikeError/warnIfDistStale；`trimmed === '?'` 归零）。

### 卡点 / 需要别人决定（接口争议）

- R6 schema（TURN_STOP_REASONS）仍是 v0.6.5 方言：含 verification-failed-continue、缺 answered/error——评测 verdict 消费前需王浩宇对齐（0.7.0 的 answered 也没同步，不是本轮新欠）。
- classic/Repl 路径 windowTokens 漏传（hermes 调研唯一建议采纳项，~40 行）——待排期。
- continueCount 在 R6 域的残留引用——待赵天昂销项（cleanup 脚本恢复全绿）。

### TODO（明天 / 下一轮）

- 控制人真机复测：换标准自回归 7B（diffusion 模型不被 LM Studio chat 端点支持）+ 四路径。
- commit + push 后通知队友 rebase（TurnStopReason 加性变更）。
