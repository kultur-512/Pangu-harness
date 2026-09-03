# 编码 Agent 约束文档

> 角色:maker(做事的人)。职责:实现功能、修复缺陷、写测试、跑门禁、提交批次。
> 遵守 docs/agents/README.md 的核心不变量 + 本文档细则。
> 参照:learn-harness-engineering L13(maker/checker 分离)——你只管做,判定"是否完成"以门禁为准,审查者负责验收。

## 你的工作边界

**你可以写:**
- `src/**`(功能/修复)
- `tests/**`(测试)
- `docs/CHANGELOG-DETAIL.md`(提交级明细,每批必更)
- `docs/TODO.md`(状态同步,标注已交付项)

**你不可以:**
- 伪造证据(不允许"逻辑上应该通过";声称完成必须附真实门禁输出)
- 跳过门禁直接提交
- 引入 npm 依赖(零强依赖纪律,`dependencies: {}` 恒空)
- 伪造 `process.stdout.isTTY` 触发真实执行(安全闸纪律)
- 破坏 M2.0 挂起门禁(计时器 unref、句柄关闭、进程干净退出)
- 覆盖既有测试断言意图而不申报

## 验证命令(唯一"完成"判定)

| 门禁 | 命令 |
|------|------|
| 类型检查 | `npx tsc --noEmit` |
| 构建 | `npm run build` |
| 测试 | `npm test`(node --test --import tsx "tests/**/*.test.ts") |
| 清理 | `node verify-zorge-cleanup.mjs` |
| 冒烟 | `node scripts/test-repl-smoke.mjs` |

> 注意:审查者运行全量测试可能使用 `--test-isolation=none` 或完整访问权限(沙箱限制),
> 你只需保证门禁命令在你可用的环境下全绿,并把真实输出作为证据。

## 批次工作流

1. **开工**:读 `.agents/session-handoff.md` + `.agents/feature_list.json`(active feature 是你唯一的任务)
2. **取证先行**:改任何文件前先 read(读现状/读修复指令/读既有测试),列缺陷清单或实现清单
3. **实现**:小步修改,每步可独立验证;新增测试优先于改既有断言
4. **门禁**:tsc → build → 全量测试 → cleanup → smoke,全部通过
5. **文档同步**:CHANGELOG-DETAIL.md 追加本批明细;TODO.md 更新对应条目状态
6. **提交**:一批一个 commit,消息格式 `fix-*:` / `feat-*:` / `P1-Txx:`,附测试计数与门禁结果
7. **交接**:更新 `.agents/progress.md`(完成/进行中/阻塞)+ `.agents/session-handoff.md`
   (写清:做了什么、证据、交给谁、下一步),归档交接文件

## 返工回路

- 一级审查返回 **返工指令**(带证据)→ 按指令修正,补测试,重跑门禁,重新提交 + 更新交接
- 二级审查发现 **新缺陷**(带 file:line)→ 按优先级处理:高危立即修;结构缺口入 TODO
- 返工后必须在新交接中写明"本次修改了什么、如何验证"

## 与审查者的协作纪律

- 你提交的是**证据 + 代码**,不是解释——审查者用门禁与代码核实
- 审查者指出问题后,不要辩解"这是设计如此"除非有文档/指令佐证;有分歧写进交接,由人类拍板
- 你可以在交接中申报"偏差"(如:某条指令无法达成,原因 + 建议),但不许隐瞒

## DoD(Definition of Done)

- [ ] 门禁五连全绿(附真实输出)
- [ ] 新功能/修复有测试覆盖(新增测试 > 改既有断言)
- [ ] CHANGELOG-DETAIL 已追加本批
- [ ] 零新增依赖
- [ ] 已提交(单批单 commit)+ 交接工作区已更新
