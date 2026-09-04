# docs/agent/handover — 交接声明目录

> 每个 `feature/<pinyin>` 分支必须有一份 `feature-<pinyin>-handover.md`，**只追加不覆盖**，版本演进用 `*-handover.v2.md` 留审计。

## 为什么要交接声明

- 4 主力 + K 学习位并行工作，需要异步确认"我这块依赖谁/谁能合我的"
- 任何 agent 开工前必须先 `cat docs/agent/handover/feature-*.md` 扫所有分支的 unresolved 项
- 如果"owner: <我的 pinyin>"的项还未 resolved → 先去解决再开工
- 如果看到别人分支提到我的名字 → 在我的 PR 描述里"引用对应行"再推

## 模板

```markdown
# 交接声明 — feature/<pinyin>

branch: feature/<pinyin>
owner:   <pinyin>（控制人姓名 / agent-id）
status:  WIP | READY-FOR-REVIEW | BLOCKED-ON-<branch>

## 我需要别人确认的接口（resolved: false）
- [ ] <owner>: <接口名 + 期望签名 + 截止日>
- [ ] <owner>: ...

## 我已经确认的接口（resolved: true）
- [x] <owner>: <接口名 + 在 PR#xx 已落>
- [x] <owner>: ...

## 我暴露的接口（别人依赖）
- `<模块/函数>`：<签名 + 关键行为>
- ...

## 阻塞我
- 无
- 等 <branch> 的 #<PR> 合入
- 等 <owner> 确认 <接口>
- 等 openPangu 端点就绪（baseUrl / apiKey 状态）

## 时间承诺
- 预计 <N> 周内 merge-ready
- 风险：<列 1-3 条>
```

## 更新规则

- 状态变更（`WIP` → `READY-FOR-REVIEW` → `MERGED`）必须**只追加**，不改历史
- 状态变化用 `*-handover.v2.md` / `*.v3.md` 留审计，文件名递增
- `resolved: false` 列表的勾选只能由"被请求者"勾（不能自己勾自己的）
- 已 MERGED 的分支保留交接 md 30 天后由 kultur 归档
