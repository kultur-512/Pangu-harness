# GLM-5.3 Tool Call Adapter

## 目标
为 GLM-5.3 打造**最高适配度**的工具调用解析层，专门处理它在 Agent 循环中实际输出的非标准 XML 格式。

## 当前支持的格式（已验证）

GLM-5.3 真实输出示例：

```xml
<>
  <Bash>
    <command>ls -la /path/to/dir/</command>
  </Bash>
</>
```

解析后归一化为：

```json
{
  "toolName": "Bash",
  "params": [
    { "name": "command", "value": "ls -la /path/to/dir/" }
  ],
  "rawBlock": "<>\n  <Bash>\n    <command>ls -la /path/to/dir/</command>\n  </Bash>\n</>"
}
```

## 设计原则

1. **优先适配真实行为** 而不是官方文档宣称的 "OpenAI compatible"。
2. **内容级解析**：从模型完整输出或流式 chunk 中提取 `<>` 包裹的块。
3. **鲁棒性**：标签不完整、多个工具、思考文本混杂、轻微漂移都要尽量处理。
4. **可恢复**：解析失败时给出精确的错误信息 + 建议的修正 prompt。
5. **归一化**：无论模型输出什么格式，最终都变成统一的 `ToolCall` 结构供上层使用。

## 核心接口

```ts
interface ToolCall {
  toolName: string;
  params: Array<{ name: string; value: string }>;
  rawBlock: string;
}

interface ParseResult {
  toolCalls: ToolCall[];
  remainingText: string;   // 模型的思考/叙述文本
  warnings: string[];
}
```

## 使用示例

```ts
import { GlmToolCallParser } from './adapter/GlmToolCallParser.js';

const parser = new GlmToolCallParser();
const result = parser.parse(modelResponse);

for (const call of result.toolCalls) {
  console.log(`调用工具: ${call.toolName}`);
  for (const p of call.params) {
    console.log(`  ${p.name} = ${p.value}`);
  }
}

// remainingText 可以作为模型的 reasoning 展示给用户或存入上下文
```

## 下一步演进方向（建议优先级）

- [ ] 流式增量解析（支持 chunk 累积）
- [ ] 多工具并行块解析
- [ ] 格式错误自动生成重试提示词
- [ ] 支持 GLM 偶尔输出的其他变体（<tool_call>、invoke 等）
- [ ] 与 Zhipu SDK / OpenAI-compatible client 集成包装器

这个 Adapter 是整个 GLM-5.3 高适配 Agent 框架的最底层基石。
