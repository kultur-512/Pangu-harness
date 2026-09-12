# 翟苑皓下一步工作方案（0.8 · 2026-09-07 起）

> 依据：`tasks/leader/zhaiyuanhao-independent-backlog.md`（领地地图 + 44 项 backlog）、`PLAN-0.8-FOUNDATION.md`（M1/M2/M3）、9/24 交付时间盒、四分支对齐现状（全部基于 develop=f9219ee）。
> 一句话现状：主线 0.7.4 全绿（749 例），0.8 已立项（M1 第 1 步行为锁定测试已落）；团队四分支产出已就绪但**尚未合入集成线**。

## 优先级总览

| 主线 | 内容 | 性质 | 时间盒 |
|---|---|---|---|
| ① | B 组评审 + 四分支合入 develop | Leader 本职，阻塞团队集成 | 本周（最紧急） |
| ② | 0.8 M1 第 2 步（四模块搬家）+ M2-2/M2-6 | 交付增量 | 合入后并进 |
| ③ | 提交物收口（A10/A11/A13/A14 + F6 真机） | 9/24 必交 | 随评测数据 |
| ④ | G 组持续职责 | 滚动 | 每日 5-30 分钟 |

## 主线 ①：评审 + 合入决战（最紧急，本周主线）

四分支全部基于 develop 对齐，产出已冻结，缺的是评审闸门与合入动作。

**步骤**：
1. **B4 自我对照评审**：对 zhaiyuanhao1（0.7.4 + 0.8 立项 + 文档）跑评审四问，写合入备忘（0.5 天）。
2. **B1 评审王浩宇**（wanghaoyu1，+8：R3 结构化字段 + U4 补全 T2/T3 + run-eval 收敛 + TurnStopReason 同步）——评审四问逐条答，产出 `Reviewed-by` 纪要（0.5 天）。
3. **B3 评审赵天昂**（zhaotianang1，+5：R6 域 0.7.4 销项 continueCount/TurnStopReason）——同上。
4. **B2 评审王佐**（wangzuo1，+5：R4 events.ts / R5 taskState.ts）——最干净，纯新文件 + types.ts 加性。
5. **合入 develop**（顺序 = 冲突面递增）：`wangzuo1 → zhaotianang1 → wanghaoyu1 → zhaiyuanhao1`。**关键预警**：王浩宇 43be123 与赵天昂 49bf59d 同改 `scripts/eval/results/schema.mjs`（同向语义，人工并集）；每步之间跑验证门。
6. **B5/B6**：CI 门（.github/workflows 若存在）核验 + 持续巡检三人当日 push。

**验收**：develop 含四分支全部产出；`npx tsc --noEmit` 干净；全量 ≥749 例全绿；`verify-panshalach-cleanup.mjs` 全绿（continueCount 项随合入恢复）；双契约脚本 PASS。

## 主线 ②：0.8 交付增量（合入稳定后并进）

**M1 第 2 步——四模块搬家**（行为锁定测试 455 行已就位，纯机械，子智能体）：
- `src/cli/repl/sseInteractive.ts`（~2200 行）→ `turn/TurnContext.ts`（状态显式化）+ `TurnController.ts`（任务提交/事件分发/中断/排队/turn 落盘）+ `TurnRenderer.ts`（纯渲染助手）+ `CommandRouter.ts`（命令派发）+ 会话壳（启动/降级/信号/接线）。
- 纪律：零行为变更（diff 审查=逐字节等价）；每搬一个模块跑全量；已导出纯函数导出面不变。

**M2 最小不可分割集（~120 行，低风险高价值）**：
- **M2-2 卡死硬闸**：`src/loop/guardrails.ts`——同参数重复失败 5 次 / 同工具失败 8 次 / 幂等同结果 5 次 → before_call 阻断（复用 `consecutive-failures` 终态，不加新枚举）。0.6.5"905s 空转"家族的最后栅栏。
- **M2-6 敏感路径写保护**：`src/tools/sensitivePaths.ts`——`.ssh/**`、`.aws/**`、`.kube/**`、`.git-credentials`、`.netrc`、`id_rsa*`、`.env*` 全档位写拒绝 + `/undo` 还原拒绝。

**M1-PROTOCOL（messages 双通道，~900 行，S 级）**：视时间盒决定——若合入+评测挤压，降级为 v0.7.5 只落 `ModelClient.chat()/streamChatMessages()` 加性接口 + loop 双轨（`PANSHA_MESSAGES_MODE=off` 逃生门），PromptBuilder 三段拆分后置；若时间充裕则完整做（含 stable/volatile 分段 + 网关前缀缓存收益）。

## 主线 ③：提交物收口

- **A10** EVALUATION §5 分析叙事（先写骨架，数据由赵天昂回填）。
- **A11** MEMORY-DESIGN §3.1 补 Turn goal/changedFiles/verifyCmd 字段（R3 合入后）。
- **A13** AGENT-CONTRIBUTION §7 分支命名规则细化。
- **A14** tasks/postmortem/2026-09-24-submission.md 复盘模板。
- **F6** 真机四用例（`1`/`你好`/Ctrl+C/`hello.txt`）——**端点恢复即做**，禁止预填 PASS。

## 主线 ④：持续职责（G 组）

G1 任务卡滚动更新、G2 当日日志、G3 每日 fetch+handover 巡检、G5 commit 前 diff 自查、G6 周 stand-up。

## 决策点（提请 kultur / 用户）

1. **E3 P6 存储名迁移**：`PANSHA_*` → `PANG_*` 方向裁决（当前路线图冻结待拍板）——影响后续所有 env 契约。
2. **D6 CI 工作流**：auto-merge develop→master gate 是否立项（kultur 独有权限）。
3. **M1-PROTOCOL 时间盒**：9/24 前做完整 messages 重构，还是 v0.7.5 只落加性接口？

## 本周节奏（建议）

```
D1：B4 自我对照 + B1 评审王浩宇
D2：B3 评审赵天昂 + B2 评审王佐
D3：四分支合入 develop（含 schema.mjs 人工并集）+ 全量验证
D4：M1 第 2 步四模块搬家（子智能体）
D5：M2-2 卡死硬闸 + M2-6 敏感路径
D6-D7：M1-PROTOCOL（按决策 3 取舍）+ 提交物收口
```
