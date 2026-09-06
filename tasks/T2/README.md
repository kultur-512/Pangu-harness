# T2 — 跨文件关联（Cross-File Context）

- **id**: T2
- **tier**: C（完整记忆注入）
- **owner**: 赵天昂（issue 正文 + verify.sh 起草，80d3f08）/ 王浩宇（U4 补 `repo/` + verify.sh 强化）

## 目标
验证模型在多文件代码库中能否追踪跨文件引用（类型定义、函数调用、import 链）。

## 场景定义
- 输入：3-10 个文件的代码库，issue 涉及跨文件修改
- 期望：模型能正确识别所有需要修改的位置
- 当前实例：`issue.md` — `repo/` 内 `add(a, b)` 扩展 `number | bigint` 跨文件重构

## Fixture（实体化进行中，80d3f08）
- `issue.md` — issue 正文（add 函数扩展 bigint，**runner 的 prompt 源**）
- `fixture.md` — 实体化指针
- `verify.sh` — stub（检查 `repo/` 存在 + 退出 0；U4 王浩宇替换为 npm test 实检）
- `repo/` — ⏳ 待 U4 王浩宇：5-10 文件小型 TypeScript 代码库（package.json + src + tests）

## 验收 Rubric
| 维度 | 评分 |
|---|---|
| 跨文件定位准确率 | 正确识别需修改文件数 / 实际需修改文件数 |
| 引用追踪深度 | 解析 import / 调用的层数 |
| 误改率 | 修改了不应修改的文件数 |
| 测试通过率 | `npm test` 通过用例数 / 总用例数 |

## 期望行为（wanghaoyu 版并入）
- 重构目标函数签名并更新所有调用点
- 不引入新的编译/测试错误
- 变更文件数 ≥ 1 且 = 实际需要修改的文件数

## 评测标准（wanghaoyu 版 runner 口径并入）
- `verification.signal` = `ALL_TESTS_PASSED`（U4 实检后为 `cd repo && npm test` 退出码 0）
- 误改率 = 0（修改了不相关文件 → `failureTaxonomy.primary = 'model-noncompliant'`）

## 评测合同
- `taskFamily: T2`
- `verification.commands` 至少包含 `verify.sh`
- R7 C4 消融：是否使用 n-gram 语义检索召回跨文件引用

## 标签
- `multi-file`
- `code-context`
- R7 评测必跑
