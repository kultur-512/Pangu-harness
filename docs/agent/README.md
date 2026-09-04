# docs/agent — Agent 协作记忆目录

> 本目录是 4 主力 + K 学习位并行工作时的**强制协作记忆**。配合 `AGENT-CONTRIBUTION.md` §6.1、§6.2 与 `WORK-PLAN-MAIN-LEARN.md` §6.1、§6.2 使用。

## 目录布局

```
docs/agent/
├── README.md                        # 本文件
├── logs/
│   ├── .gitkeep                     # 占位，强制入 git
│   └── feature-<pinyin>/           # 每个 feature 分支一个目录
│       └── feature-<pinyin>-YYYY-MM-DD.md  # 每天一个工作日志（追加写）
└── handover/
    ├── README.md                    # 用法说明
    └── feature-<pinyin>-handover.md # 每个分支一份交接声明
```

## 关键规则

- **入 git**：`docs/agent/logs/feature-<pinyin>/<branch>-YYYY-MM-DD.md` 与 `docs/agent/handover/feature-<pinyin>-handover.md` **必须入 git**（这是有意追踪的协作记忆）。
- **不删除历史**：日志与 handover 一旦落地**只追加不覆盖**；前一日日志永远保留。
- **开工前必查**：每个 agent 开工前必须 `git fetch origin` + `cat docs/agent/handover/feature-*.md` 看是否有未 resolved 的接口冲突指向自己。
- **commit 前必写日志**：每次 `git commit` 之前必须先 `cat >> docs/agent/logs/<branch>/<branch>-$(date +%F).md` 加当日条目；CI gate 校验"commit 时间 ≥ log 最后更新时间"。

## 与规范文档的对应

| 主题 | 规范位置 |
|---|---|
| 启动前必拉 master + 必读 handover | `AGENT-CONTRIBUTION.md` §10 / `WORK-PLAN-MAIN-LEARN.md` §6.2 |
| 工作日志 4 块结构 | `AGENT-CONTRIBUTION.md` §6.1.1 / `WORK-PLAN-MAIN-LEARN.md` §6.1.1 |
| 交接声明 4 类项 | `AGENT-CONTRIBUTION.md` §6.1.2 / `WORK-PLAN-MAIN-LEARN.md` §6.1.2 |
| Git 协作全流程 A–F | `AGENT-CONTRIBUTION.md` §10.1 / `WORK-PLAN-MAIN-LEARN.md` §6.2 |
