# 破坏性 API 变更：旧品牌清理（feature-zhaiyuanhao1 → 全分支）

- **日期**：2026-09-04
- **发起分支**：feature-zhaiyuanhao1（翟苑皓）
- **commit**：17851f9
- **性质**：破坏性（不留兼容别名）

## 变更清单

1. **类/文件重命名**（git mv，import 路径已变）：
   - `src/adapter/ExtremeGlmToolCallAdapter.ts` → `StrictStructuredToolAdapter.ts`（类同名）
   - `src/adapter/GlmToolCallParser.ts` → `XmlStructuredToolParser.ts`（类同名）
   - 测试：`tests/extremeAdapter.test.ts` → `tests/strictStructuredAdapter.test.ts`；`tests/glmToolCallParser.test.ts` → `tests/xmlStructuredToolParser.test.ts`

2. **已删除（不可再 import）**：
   - `src/Glm53SweProChaser.ts`（兼容 stub）
   - `export { PanshalachChaser as Glm53SweProChaser }` 别名导出
   - `scripts/test-glm-shorthand.mjs`

3. **方法改名**（`src/reasoning/StructuredReasoner.ts`）：
   - `getGlmIronLawsHeader` → `getEngineeringIronLawsHeader`
   - `getGlmIronLawsShort` → `getEngineeringIronLawsShort`
   - `buildGlmFormatEnforcementPrompt` → `buildToolCallFormatEnforcementPrompt`
   - 构造选项 `isStrictGlm` 已删除（用 `isStrongMode`）

4. **detectedFormat 值变更**（`ToolCallFormatDetector` / `UniversalToolCallAdapter`）：
   - `'glm-xml-strict'` → `'xml-strict'`
   - `'glm-loose-plain'` → `'loose-plain'`
   - 若你的分支有按旧串过滤/比较的逻辑，合并前必须同步

5. **ModelProvider 行为变更**：
   - bare `glm` / `glm5` magic shorthand 已删除，走普通模型名路径
   - `_pickBestGLMModel` → `_pickBestProviderModel(providerName)`
   - `getEffectiveModel` 现为通用 `provider:model` / `provider:` / 裸 provider 名解析

## 各分支需要做什么

工作前拉取 develop 后 rebase；如果 tsc 报 `Cannot find module './adapter/ExtremeGlmToolCallAdapter.js'` 或 `Property 'getGlmIronLawsHeader' does not exist`，按上表替换即可。基准验证：`npx tsc --noEmit` EXIT 0 + 505 测试全绿。
