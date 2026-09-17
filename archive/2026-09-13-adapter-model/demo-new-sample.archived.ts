// demo-new-sample.ts
// Historical demo for the structured XML tool-call parser (not the full Panshalach agent).
// Prefer CLI or tests for real usage.
import { XmlStructuredToolParser } from './adapter/XmlStructuredToolParser.js';

const input = `<>
  <Read>
    <file_path>src/main.rs</file_path>
  </Read>
</>`;

const parser = new XmlStructuredToolParser();
const result = parser.parse(input);

console.log('=== New Sample Parse Result ===');
console.log(JSON.stringify(result, null, 2));
