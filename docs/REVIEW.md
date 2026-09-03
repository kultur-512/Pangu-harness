# Review System - Static Analysis Integration (P0-3)

## Overview
Starting with P0-3, `Reviewer.review()` now performs **language-aware static analysis** and surfaces the results in `ReviewReport.staticAnalysis`.

This directly addresses the "灯下黑" problem: the model often cannot see its own compilation/type/lint errors during review.

## What it does

- Detects project language from marker files in `workspaceRoot`:
  - `tsconfig.json` → TypeScript
  - ESLint config or `eslint` in package.json → JavaScript (ESLint)
  - `pyproject.toml` / `setup.py` → Python (detect only)
  - `go.mod` → Go (detect only)
  - `Cargo.toml` → Rust (detect only)

- For TypeScript:
  - Runs `npx tsc --noEmit --pretty false 2>&1`
  - 30s timeout, output truncated to 4000 chars
  - Reports `passed`, `errorCount`, `warningCount`, full output

- For ESLint (when config present):
  - Runs `npx eslint --format compact . 2>&1`
  - Same timeout/truncation rules

- Other languages are recorded as "detected but not executed in this phase"

## Result Shape

```ts
interface StaticAnalysisResult {
  language: 'typescript' | 'javascript' | ... | 'unknown';
  tool: 'tsc' | 'eslint' | 'mypy' | ... | 'none';
  command: string;
  passed: boolean;
  output: string;          // truncated
  durationMs: number;
  errorCount: number;
  warningCount: number;
  triggered: boolean;
}
```

It is attached to `ReviewReport.staticAnalysis?: StaticAnalysisResult[]`.

## Safety & Boundaries

- Only white-listed commands are ever executed (`npx tsc`, `npx eslint`).
- Failures are captured, never thrown.
- Static analysis is best-effort; a failed analysis never breaks the main review flow.
- No auto-fix, no write operations.

## When it runs

Every `Reviewer.review(diffSpec, workspaceRoot)` call now runs static analysis after file reading and test-script detection.

## Future Integration

The `staticAnalysis` field is intended to be injected into critique prompts later (e.g. as `<static_analysis_result>` blocks) by the loop that calls the Reviewer.

## Testing

- `tests/review/StaticAnalysis.test.ts`
- Covers:
  - No config → empty array
  - tsconfig present → tsc result
  - Type error → `passed: false` + output captured
  - Both tsconfig + eslint → multiple results

## Performance

- Adds one `tsc` and/or one `eslint` run per review.
- Local runs are usually < 3s. Hard timeout is 30s per tool.

## Rollback

If static analysis becomes problematic, the entire block in `review()` is isolated. It can be disabled by clearing `report.staticAnalysis` after the call or by guarding the `runStaticAnalysis` call.
