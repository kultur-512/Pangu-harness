// demo.ts
// Simple demo for the GLM tool call parser (not the full Zorge agent).
// Historical utility; prefer CLI or tests for real usage.
import { GlmToolCallParser } from './adapter/GlmToolCallParser.js';

const SAMPLE = `
我来帮你查看一下目录结构。

<>
  <Bash>
    <command>ls -la /path/to/dir/</command>
  </Bash>
</>

如果目录不存在，我会尝试创建。
`;

const parser = new GlmToolCallParser();
const result = parser.parse(SAMPLE);

console.log('=== Parse Result ===');
console.log('Tool Calls:', JSON.stringify(result.toolCalls, null, 2));
console.log('Remaining Text:', result.remainingText);
console.log('Warnings:', result.warnings);
