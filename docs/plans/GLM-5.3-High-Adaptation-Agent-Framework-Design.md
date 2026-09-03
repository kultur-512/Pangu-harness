# 【历史存档】GLM-5.3 高适配 Agent 框架设计

**此文档为早期规划存档，已被 Zorge 框架取代。**

当前最新定位见 `docs/plans/ZORGE-FRAMEWORK-FINAL-SPEC.md` 或直接阅读 `src/Glm53SweProChaser.ts` 头部注释（ZorgeChaser）。

核心变更：
- 从 "高适配" 转向 "高工程强度 + 高适用编码 + 高释放 GLM 能力"
- 引入六档强度体系（quick/standard/high/max/ex/zorge，默认 high）
- 失败记忆提炼后持久化（.zorge-memory.json）
- Review 命令 + 白名单测试 + 软限制动态降级

原文档保留仅供历史参考。

---

（以下为原文档内容，仅供存档）

## 2. GLM-5.3 作为 Agent 模型的关键特性与痛点

### 优势
- 后训练 Scaling 效果显著，纯编程基准提升明显。
- 1M 超长上下文 → 可以保留更多历史和代码上下文。
- 中文理解和指令遵循较强。
- 据社区反馈，在结构化思考、自我验证上有潜力。

### 核心适配难点（必须解决）
1. **工具调用格式不稳定**（最致命）
   - 官方宣称 OpenAI-compatible，但实际在 Agent 循环中经常输出 **XML 风格的 tool call 嵌入在 content 里**（如 `<toolcall>`、`<tool_call>` 等）。
   - 很多 harness（包括早期版本的 Claude Code 风格、各种开源 loop）会静默解析失败。
   - 已有社区项目：`glm-toolbridge`、`agent-tars-glm-4.5-adapter` 专门做这个适配。
   - 流式工具调用解析也更复杂。

2. **多工具协同与并行能力** 实测有波动，需要更强的格式约束 + 验证。

3. **上下文管理策略不同**
   - 1M 上下文不是“无限用”，Agent 循环中仍需智能裁剪（tool result 膨胀、历史噪声）。
   - GLM 对较长的 tool output 有一定容忍度，但仍需精细策略。

4. **推理风格偏好**
   - GLM 受益于**显式思考标签**、分步验证、中文结构化指令。
   - 直接套 Claude 风格的极简提示往往发挥不充分。

## 3. 框架整体架构（分层设计）

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Application Layer                   │
│  (任务编排、用户交互、子代理调度、技能系统)                    │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                   GLM-Adapted Agent Loop                     │
│  Think(显式) → Verify → Act → Reflect → (可选 Plan Mode)      │
│  - 减少不必要 roundtrip                                      │
│  - 强制验证步骤                                              │
│  - 支持长步长（利用 GLM 强推理）                              │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                 Context & Memory Manager                     │
│  - 1M 感知的 compaction / pruning                            │
│  - Tool Result 智能裁剪（GLM 专用阈值）                       │
│  - 轨迹摘要 + 关键文件保留策略                               │
│  - Episodic / Semantic Memory（可选）                         │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│              Prompt Composition System (多层)                │
│  Base Persona (GLM 特性)                                     │
│  + Reasoning Protocol (强制思考 + 验证)                       │
│  + Tool Usage Rules (严格格式 + 中文示例)                     │
│  + Dynamic Sections (plan mode / skill / current context)   │
│  + Output Style 控制                                         │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│              Tool Call Adapter Layer (最关键)                │
│  GLM LLM Client Wrapper                                      │
│  ├── Native XML Parser (<toolcall> / <tool_call> 等)         │
│  ├── OpenAI schema fallback                                  │
│  ├── Streaming tool call 累积解析                            │
│  └── ToolCall Normalizer → 统一内部表示                       │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    LLM Provider Interface                    │
│  (Zhipu 官方 SDK / OpenAI-compatible endpoint)               │
└─────────────────────────────────────────────────────────────┘
                              │
                    Tool Execution Sandbox
              (bash, fs, editor, web, 自定义工具)
```

## 4. 关键组件详细设计

### 4.1 Tool Call Adapter（最高优先级）
- 必须能可靠解析 GLM 实际输出的 XML 风格调用。
- 支持流式逐步解析（避免等完整响应）。
- 提供清晰的错误恢复机制（格式错误时让模型重试，并给出精确的修正示例）。
- 可配置“严格模式”和“宽松模式”。

### 4.2 Prompt System（GLM 专用）
推荐采用**分层可组合**结构：
- 核心 Persona：强调“你是 GLM-5.3 驱动的极致编码 Agent”
- Reasoning Protocol：强制使用 `<thinking>` / 分步验证 / 先写计划再执行
- Tool Discipline：给出 GLM 最容易遵循的精确 XML 或混合格式示例
- Verification Layer：每次行动后必须自检
- 中文优先 + 必要时双语

### 4.3 Agent Loop 策略
推荐循环：
1. **Observe**（当前状态 + 关键上下文）
2. **Think**（显式长思考，利用 1M 上下文优势）
3. **Validate**（自我批评 / 风险检查 / 测试意图）
4. **Act**（单步或小批量工具调用）
5. **Reflect**（工具结果分析 + 决定下一步）

相比传统 ReAct，增加 **Validate** 步骤来弥补 GLM 工具调用偶尔不稳的问题。

### 4.4 Context 策略（针对 1M）
- 默认激进程度低于 Claude 风格 harness。
- Tool result 采用“头尾保留 + 中间摘要”而非硬截断。
- 引入“重要文件锚点”机制，长期保留核心代码文件内容。
- 可选：当上下文 > 一定阈值时触发 LLM-based 轨迹压缩（而非纯规则）。

## 5. 实现路径选项（推荐排序）

**选项 A（推荐起步）：基于 DeepSeek Harness 的 GLM 专用 Preset + 插件**
- 优点：直接复用 DSH 的 shell、fs、sandbox、approval、子代理、job 等基础设施。
- 需要做的工作：
  - 新建用户 preset（`glm53-highadapt`）
  - 强化的 persona + agent-instructions
  - 自定义 compaction 配置
  - 开发一个 **GLM Tool Adapter 动态插件**（或作为 skill）
  - 可能需要扩展 LLM provider 支持 Zhipu（如果当前 profile 不完善）
- 适合你当前环境。

**选项 B：轻量级独立框架（Python / Rust / TS）**
- 优点：对 GLM 适配可以做到极致，不受 DSH 现有抽象限制。
- 缺点：要自己实现 sandbox、权限、子代理、持久化等。
- 适合想做“下一代 GLM 原生 harness”的人。

**选项 C：Hybrid**
- 核心 Agent Loop + Adapter 独立实现。
- 通过 MCP / ACP / 自定义协议对接 DSH、Claude Code、OpenClaw 等作为宿主。
- 难度最高，但复用性最强。

## 6. 风险与权衡

- GLM 工具调用格式可能随版本变化 → Adapter 层必须可快速迭代。
- 1M 上下文带来的成本与延迟，需要在框架中暴露预算控制。
- 中文强不等于所有场景都用中文提示，最优可能是“核心规则中文 + 代码相关中英混合”。
- 避免过度工程化：先把 Tool Adapter + Prompt Stack + 基础 Loop 跑通，再加复杂记忆。

## 8. 真实 GLM-5.3 Tool Call 输出样本（用户提供）

用户提供的实际输出格式示例：

```xml
<>
  <Bash>
    <command>ls -la /path/to/dir/</command>
  </Bash>
</>
```

### 观察与分析

- **根容器**：使用空标签 `<>` ... `</>` 包裹整个工具调用块（这很特殊，可能来自 chat template 或模型的输出习惯）。
- **工具名称即标签名**：`<Bash>` 表示调用名为 `Bash` 的工具。
- **参数采用子标签**：`<command>value</command>`，参数名即标签名，内容即值。
- **非标准 OpenAI schema**：完全不是 `tool_calls` 数组，也不是标准的 `<tool_call>` / `invoke` 格式。
- **嵌入在 content 中**：模型会把这种 XML 混在普通文本（思考过程）里输出。

### 已知风险
- 不同工具会有不同参数标签（例如 `<path>`, `<content>`, `<old_string>`, `<new_string>` 等）。
- 可能出现多个并列的工具块。
- 流式输出时，标签可能被切断，需要增量累积解析。
- 模型偶尔可能输出不完整或格式漂移的块，需要鲁棒的恢复机制。

此格式是 GLM-5 系列在 Agent 场景下的典型行为，也是本框架 **Tool Call Adapter** 必须首要完美支持的格式。

### 验证结果（实际运行）

使用纯 JavaScript 实现的解析器对用户提供的**完全相同的输入**进行测试：

输入：
```
<>
  <Bash>
    <command>ls -la /path/to/dir/</command>
  </Bash>
</>
```

输出（已验证）：
```json
{
  "toolCalls": [
    {
      "toolName": "Bash",
      "params": [
        {
          "name": "command",
          "value": "ls -la /path/to/dir/"
        }
      ],
      "rawBlock": "<>\n  <Bash>\n    <command>ls -la /path/to/dir/</command>\n  </Bash>\n</>"
    }
  ],
  "remainingText": "",
  "warnings": []
}
```

这证明我们已经成功捕获了 GLM-5.3 在真实 Agent 场景下实际输出的**非标准工具调用格式**，并将其归一化。
