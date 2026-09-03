# Zorge 三 Agent 协作体系(目录页)

> 本目录是 **目录页**(Codex AGENTS.md 语义,L04:give the map, not the manual):
> 路由 + 不变量 + 文件索引。细节按需读对应文件。
> 框架来源:learn-harness-engineering(五子系统模型 + L12 交接态 + L14 图工程 + multi-agent 协作模式)。

## 这是什么

Zorge 项目(编码 agent CLI)采用 **三角色分工开发**:一个编码 agent 负责写代码,
两个审查 agent(一级/二级)负责只读验收。三者通过 **共享交接工作区** 传递状态,
由 **交接流程(图)** 定义节点、边与路由——不是三个 agent 各自为政,
而是一个 maker/checker 分离的开发图。

| 角色 | 职责 | 能否写 src/ | 能否写 docs/ | 约束文档 |
|------|------|------------|-------------|---------|
| **编码 agent** | 实现功能、修 bug、写测试、跑门禁、提交 | ✅ | ✅(CHANGELOG-DETAIL) | [agent-coding.md](agent-coding.md) |
| **一级审查 agent** | 验收功能:核对修复指令、逐项验证、回归检查 | ❌ | ✅(审查记录) | [agent-review-1.md](agent-review-1.md) |
| **二级审查 agent** | 架构/安全/文档一致性复审:发现新问题、防回归 | ❌ | ✅(审查报告) | [agent-review-2.md](agent-review-2.md) |

## 核心不变量(所有 agent 必须遵守)

1. **审查者永不改 src/**:一级/二级审查是只读角色,发现缺陷只能写审查文档 + 交给编码 agent 修。
2. **交接必留痕**:每个 agent 结束工作前,必须在交接工作区更新 `progress.md` 与
   `session-handoff.md`(L12:干净交接态,下一会话 5 分钟内可接手)。
3. **证据优先**:声称"完成/通过/失败"必须附可复现证据(测试输出/文件:行号/提交号)。
4. **验证命令是唯一的"完成"判定**:tsc/build/cleanup/smoke/node --test 全绿才算数,
   不允许"逻辑上应该通过"。
5. **一次一个 active feature**:`feature_list.json` 中同时只有一个 in-progress(L08)。
6. **破坏性行为永不藏进脚本**:覆盖/删除需显式批准;临时产物退出前清理。
7. **文档与代码同步**:任何行为变化同步更新 docs(TODO/CHANGELOG-DETAIL/LEARN-HARNESS-GAP),
   禁止文档漂移。

## 交接流程(图)

```
编码 agent ──批次提交──▶ 一级审查 agent ──通过──▶ 二级审查 agent ──通过──▶ 归档
     ▲                       │ 返工                      │ 新发现
     └──── 返工指令(带证据) ─┘                          └──▶ 编码 agent(或一级)
```

- 完整状态机、边类型、路由规则、失败回路:见 [workflow.md](workflow.md)
- 图工程三失败(Goodhart/盲视/冲突)规避:见 workflow.md 第四节

## 交接工作区(共享状态)

所有 agent 读写同一共享状态,不靠聊天历史传递(harness-creator:prefer append/update state files):

```
.agents/
├── feature_list.json   # 当前 feature/状态/证据/下一步(L08 原语)
├── progress.md         # 完成/进行中/阻塞(L12 进度记录)
├── session-handoff.md  # 当前交接:谁→谁、交接内容、下一步(覆盖式,始终最新)
├── handoff/            # 历史交接归档(append-only,每次交接一个文件)
└── README.md           # 工作区说明
```

- 结构语义、每个文件的字段、初始化步骤:见 [handoff-workspace.md](handoff-workspace.md)
- 模板文件:见 [templates/](templates/)

## 文档索引

| 主题 | 文件 |
|------|------|
| 编码 agent 约束(DoD/门禁/提交纪律) | agent-coding.md |
| 一级审查 agent 约束(验收/返工指令) | agent-review-1.md |
| 二级审查 agent 约束(架构/安全复审) | agent-review-2.md |
| 交接流程状态机与路由 | workflow.md |
| 交接工作区结构与字段语义 | handoff-workspace.md |
| feature_list.json / progress.md / session-handoff.md 模板 | templates/ |
| 编码 agent 启动指令(可直接粘贴分派) | prompts/start-coding.md |
| 一级审查 agent 启动指令(可直接粘贴分派) | prompts/start-review-1.md |

## 快速开始(任一 agent 接手时)

1. 读 `.agents/session-handoff.md`(最新交接)与 `.agents/progress.md`
2. 读 `.agents/feature_list.json` 确认 active feature
3. 按自己的角色文档开工;结束前更新三份状态文件 + 归档交接
