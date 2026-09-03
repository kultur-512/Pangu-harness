# GLM Format Detection (P0-1)

## Overview
Zorge now has a dedicated **format detection layer** (`ToolCallFormatDetector`) that sits in front of tool call parsing.

Goal: Reliably handle multiple model output styles (OpenAI JSON, GLM XML strict, loose plain) with **confidence scoring** to avoid false positives.

## Detection Strategy (strict order)

1. **OpenAI JSON** (highest priority when not in strict mode)
   - Looks for `tool_calls` array or function call objects.
   - High confidence (0.95) if valid tool_calls with names are present.

2. **GLM XML Strict**
   - Uses `ExtremeGlmToolCallAdapter` (the original strict `<>` + `<ToolName>` parser).
   - High confidence (0.9) when tools are successfully parsed.

3. **GLM Loose Plain**
   - Falls back to `UniversalToolCallAdapter`.
   - Medium confidence (0.6).

4. **Unknown**
   - No usable tool calls detected.

## Confidence Rules (key for safety)

- OpenAI JSON with proper `tool_calls` → 0.95
- GLM XML strict with known tools → 0.9
- Loose plain → 0.6
- Malformed / fake success JSON → deliberately kept below 0.7 threshold

## Usage in ZorgeChaser

- New dedicated call site in `solveIssue` → `VerifyCritiqueLoop`.
- By default uses `ToolCallFormatDetector.probeAndParse()`.
- **Legacy fallback**: Set `ZORGE_USE_LEGACY_PARSER=1` to bypass the detector and use old `ExtremeGlmToolCallAdapter` / `UniversalToolCallAdapter` directly.

This guarantees backward compatibility.

## Testing

- `tests/adapter/ToolCallFormatDetector.test.ts`
- Covers:
  - Standard OpenAI JSON
  - GLM XML strict
  - Loose plain
  - Pure text (unknown)
  - Malicious/fake JSON
  - Mixed input fallback

## Performance
- Probe + parse is designed to be < 5ms per call.

## Non-Goals (this phase)
- Automatic JSON repair
- New dependencies (no ajv, zod, etc.)
- Changing the internal behavior of the two legacy adapters
