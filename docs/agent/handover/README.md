# docs/agent/handover — 交接声明目录

> 跨分支协调"我这块依赖谁/谁能合我的"。任何 agent 开工前必须先 `cat docs/agent/handover/*.md` 扫所有未 resolved 项。

## 规则

- 如果"owner: <我的 pinyin>"的项还未 resolved → 先去解决再开工。
- 如果看到别人分支提到我的名字 → 在我的 PR 描述里"引用对应行"再推。
- 破坏性变更（API 改名/删除）必须在此发声明，列出变更对照表与各分支 rebase 后需替换的符号。

## 模板

```markdown
# 交接声明 — <topic>

- **日期**：yyyy-mm-dd
- **发起分支**：<branch>（控制人姓名）
- **commit**：<hash>
- **性质**：常规 | 破坏性

## 我需要别人确认的接口（resolved: false）
- [ ] <owner>: <接口名 + 期望签名 + 截止日>

## 我已经确认的接口（resolved: true）
- [x] <owner>: <接口名 + 在 PR#xx 已落>

## 我暴露的接口（别人依赖）
- `<模块/函数>`：<签名 + 关键行为>

## 阻塞我
- 无 / 等 <branch> 的 #<PR> 合入 / 等 openPangu 端点就绪

## 各分支需要做什么
<若是破坏性变更：列出对照表与基准验证命令>
```

## 更新规则

- 状态变更只追加，不改历史；重大演进用新文件留审计。
- `resolved: false` 列表的勾选只能由"被请求者"勾（不能自己勾自己的）。
- 已 MERGED 的分支交接 md 保留 30 天后由 kultur 归档。
