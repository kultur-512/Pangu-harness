# docs/agent — Agent 协作记忆目录

> 本目录是 4 主力 + K 学习位并行工作时的**强制协作记忆**。规则源是 `AGENT-CONTRIBUTION.md` §6 / §10.1。

## 目录布局

```
docs/agent/
├── README.md                        # 本文件
├── logs/
│   ├── .gitkeep                     # 占位，强制入 git
│   └── <branch>/                    # 每个工作分支一个目录（如 feature-zhaiyuanhao1）
│       └── <branch>-YYYY-MM-DD.md   # 每天一个工作日志（追加写）
└── handover/
    ├── README.md                    # 用法说明
    └── <topic>.md                   # 交接声明与破坏性变更通知
```

## 关键规则

- **入 git**：`docs/agent/logs/**` 与 `docs/agent/handover/**` 必须入 git（有意追踪的协作记忆）。
- **不删除历史**：日志一旦落地**只追加不覆盖**；前一日日志永远保留。
- **开工前必查**：每个 agent 开工前必须 `git fetch origin` + `cat docs/agent/handover/*.md` 看是否有未 resolved 的接口冲突指向自己。
- **commit 前必写日志**：每次 `git commit` 之前必须先追加 `docs/agent/logs/<branch>/<branch>-$(date +%F).md` 当日条目；CI gate 校验。

## 与规范文档的对应

| 主题 | 规范位置 |
|---|---|
| 启动前必拉 master + 必读 handover | `AGENT-CONTRIBUTION.md` §10.1-A |
| 工作日志结构 | `AGENT-CONTRIBUTION.md` §10.1-B |
| Git 协作全流程 A–F | `AGENT-CONTRIBUTION.md` §10.1 |
