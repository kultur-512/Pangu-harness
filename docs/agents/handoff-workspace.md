# 交接工作区规范

> 三 agent 的共享状态(L14 共享状态 + L12 干净交接态 + harness-creator:prefer append/update state files)。
> 位置:项目根 `.agents/`(与代码同仓库,提交到 git——交接必须持久化,不靠聊天历史)。

## 目录结构

```
.agents/
├── README.md            # 工作区说明(本文件精简版)+ 当前状态速览
├── feature_list.json    # L08 原语:一次一个 active feature
├── progress.md          # L12 进度:完成/进行中/阻塞(覆盖式更新,保留近期历史段)
├── session-handoff.md   # 当前交接:谁→谁、交接内容、下一步(覆盖式,始终最新)
└── handoff/             # 历史交接归档(append-only,每次交接一个文件)
    └── <seq>-<from>→<to>-<topic>.md
```

## 字段语义与维护规则

### feature_list.json(L08:特性列表是 harness 原语)

```json
{
  "version": 1,
  "items": [
    {
      "id": "feature-3",
      "title": "审查缺陷 5 批修复闭环",
      "status": "in-progress",
      "evidence": "497 用例 496 pass；commit 9cdfc5f..98d2e81",
      "nextStep": "T-27/T-28/T-29 补丁待人类决策",
      "updatedAt": 1788000000000
    }
  ]
}
```

- `status`:planned / in-progress / done / blocked
- **一次只有一个 in-progress**(除非显式多 agent 边界,本项目三 agent 共享同一 feature 流)
- 标记 `done` **必须附 evidence**(门禁输出/提交号/测试名),禁止空证据
- 新 feature 加入时,当前 in-progress 自动降为 planned(对齐 Zorge FeatureTracker 语义)

### progress.md(L12:进度记录,机读可查)

```markdown
# 项目进度

## 当前批次
- [x] P0-1 安全五件(S1-S5) — commit 9cdfc5f,497 用例绿
- [ ] T-27 MCP 'a' 提权补丁 — 待人类决策(高危)
- [ ] T-29 双 Esc 回归补丁 — 待人类决策(P1)

## 进行中
- 无(等待决策)

## 阻塞
- T-27/T-28 为修复指令清单遗漏,需人类拍板是否追加 P0-1 补丁
```

- **覆盖式更新**,但保留"最近 3 批"历史段(append 新段、删最旧段,防无限膨胀)
- 每个条目必须可追溯到:commit / 证据 / 负责人

### session-handoff.md(始终最新,交接的核心)

```markdown
# 会话交接

- 交接人:二级审查
- 交接时间:2026-09-xx
- 交给:编码 agent(或:人类决策)

## 本次完成
- 5 批修复已交付并验收(详见 docs/REVIEW-2ND-AUDIT.md)
- 新发现 3 项已入 TODO T-27~T-29

## 交接内容
- 代码现状:497 用例 496 pass 1 skip,tsc/build/cleanup/smoke 全绿
- 未完成:T-27(高危)/T-28(高危)/T-29(回归)待人类决策

## 下一步(接手者必读)
1. 人类决策 T-27/T-28 是否追加补丁
2. 若追加:编码 agent 修 → 一级验收 → 二级复审
3. 交接工作区文件已更新,接手者 5 分钟内可开工
```

- **覆盖式**:每次交接覆盖旧内容(旧内容进 handoff/ 归档)
- **必须包含**:做了什么(带证据)、没做什么(带原因)、下一步给谁(带具体动作)

### handoff/ 归档(append-only,审计依据)

- 文件名:`<seq>-<from>→<to>-<topic>.md`,seq 递增(001, 002, …)
- 每次 session-handoff.md 被覆盖前,把旧内容归档为 `<next-seq>-…md`
- 归档内容 = 被覆盖前的 session-handoff.md 原文(可加一行"被 <谁> 于 <时间> 覆盖")

## 初始化(首次创建工作区)

```bash
mkdir -p .agents/handoff
# 从 docs/agents/templates/ 复制三份状态文件
cp docs/agents/templates/feature_list.json .agents/
cp docs/agents/templates/progress.md .agents/
cp docs/agents/templates/session-handoff.md .agents/
```

## 生命周期纪律

1. **任何 agent 收尾前**必须:更新 progress.md + 覆盖 session-handoff.md + 归档旧交接
2. **任何 agent 开工前**必须:读 session-handoff.md + progress.md + feature_list.json
3. **提交到 git**:.agents/ 与代码同批提交(交接是项目资产,不是临时文件)
4. **失败不中断交接**:即使本批失败,也要在交接中写明失败原因 + 证据,让下一节点能接手

## 与本项目既有资产的关系

| 资产 | 与 .agents/ 的关系 |
|------|-------------------|
| `docs/TODO.md` | 结构性缺口 T-xx 的权威清单;progress.md 引用它,不重复维护 |
| `docs/CHANGELOG-DETAIL.md` | 提交级明细;progress.md 引用 commit,不重复记录 |
| `docs/REVIEW-*.md` | 审查报告;session-handoff.md 引用报告,不复制全文 |
| `~/.zorge/`(运行时状态) | 运行数据(rollout/会话),与协作工作区无关 |
