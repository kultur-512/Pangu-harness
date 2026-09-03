// demo-new-sample.ts
// Historical demo for the GLM tool call parser (not the full Zorge agent).
// Prefer CLI or tests for real usage.
import { GlmToolCallParser } from './adapter/GlmToolCallParser.js';

const input = `<>
  <Read>
    <file_path>src/main.rs</file_path>
  </Read>
</>`;

const parser = new GlmToolCallParser();
const result = parser.parse(input);

console.log('=== GLM-5.3 New Sample Parse Result ===');
console.log(JSON.stringify(result, null, 2));
