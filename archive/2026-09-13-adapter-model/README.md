# 2026-09-13 归档：适配器/模型层死代码（包D）

归档原因：全仓（src/ tests/ scripts/）零生产消费，且部分文件带已知缺陷（见下）。
本次以 `git mv` 保留历史，文件重命名加 `.archived` 中缀（沿用本目录惯例）。
测试归档后不进 `tests/**/*.test.ts` glob（npm test 不再执行）。

| 归档文件 | 原路径 | 归档理由 |
| --- | --- | --- |
| RateLimiter.archived.ts | src/utils/RateLimiter.ts | 全仓零调用；有预约式并发缺陷 |
| universal-tool-parser.archived.cjs | src/adapter/universal-tool-parser.cjs | 全仓零 import |
| XmlStructuredToolParser.archived.ts | src/adapter/XmlStructuredToolParser.ts | 生产零消费（仅 demo 引用）；已由 UniversalToolCallAdapter / StrictStructuredToolAdapter 取代 |
| demo.archived.ts | src/demo.ts | 唯一消费 XmlStructuredToolParser 的历史 demo，源归档后无法编译 |
| demo-new-sample.archived.ts | src/demo-new-sample.ts | 同上 |
| xmlStructuredToolParser.test.archived.ts | tests/xmlStructuredToolParser.test.ts | 被测源已归档 |
| strictStructuredAdapter.test.ts → strictStructuredAdapter.test.archived.ts | tests/strictStructuredAdapter.test.ts | StrictStructuredToolAdapter.ts 保留在原位（仍为导出 API 且被 ToolCallFormatDetector / VerifyCritiqueLoop 引用），本测试随 XML 解析器家族一并归档 |

保留在原位（未归档）：

- `src/adapter/UniversalToolCallAdapter.ts` — 生产主解析路径。
- `src/adapter/StrictStructuredToolAdapter.ts` — 生产未接线但仍是导出 API（VerifyCritiqueLoop / ToolCallFormatDetector 引用）。
- `src/adapter/ToolCallFormatDetector.ts` — 有生产消费（src/PanshalachChaser.ts:17 import、:602 调用），不满足"零消费"归档前提；其测试 tests/adapter/ToolCallFormatDetector.test.ts 保留并已改为精确断言。
