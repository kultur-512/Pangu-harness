# T2 — 跨文件函数签名重构（跨文件关联任务实例）

> 任务族：T2 跨文件关联（cross-file context）
> Fixture 状态：U3 周末草稿（赵天昂起 issue） / U4 由王浩宇补 `repo/` 与 `verify.sh` 强化
> U6 真机 openPangu 端点跑分时使用，R7 评测 C4 消融必跑

## 场景

在小型代码库 `repo/` 中，`src/utils/math.ts` 的 `add(a, b)` 函数当前只接受两个 `number` 参数并返回 `number`。
业务侧需要支持 `bigint` 类型相加（用于大数运算场景，避免精度丢失）。

请你完成一次**跨文件重构**：

1. 修改 `src/utils/math.ts` 的 `add` 签名，支持 `number | bigint`
2. 全仓库 grep 所有 `add(...)` 调用点，按调用上下文推断参数类型并修正（如果调用点传递的是字符串字面量数字，可以保留 `number`；如果来自 `BigInt()` 转换的结果，要改用 `bigint`）
3. 更新 `tests/math.test.ts` 增加 `bigint` 场景的测试用例
4. **不修改任何不相关文件**（误改率 = 0 是评分维度）

## 文件结构（U4 由王浩宇补 `repo/`）

```
repo/
├── package.json
├── tsconfig.json
├── src/
│   ├── utils/
│   │   └── math.ts          # 入口：add 函数定义
│   ├── services/
│   │   └── calcService.ts   # 调用 add 的服务层
│   └── main.ts              # 入口文件（间接调用 calcService）
└── tests/
    └── math.test.ts         # 测试套件
```

## 期望产出

- `add(a: number | bigint, b: number | bigint): number | bigint` 重构完成
- 所有 `add()` 调用点类型一致
- 新增 bigint 测试用例至少 2 条
- `cd repo && npm test` 退出码 0
- 修改的文件数 = 实际需要修改的文件数（误改率 = 0）

## 验收 Rubric

| 维度 | 度量 |
|---|---|
| 跨文件定位准确率 | 正确识别需修改文件数 / 实际需修改文件数 |
| 引用追踪深度 | 解析 import / 调用的层数 |
| 误改率 | 修改了不应修改的文件数 |
| 测试通过率 | `npm test` 通过用例数 / 总用例数 |

## 评测合同

- `taskFamily: T2`
- `verification.commands` 至少包含 `verify.sh`
- 期望 `verdict: completed` + `verification.signal: ALL_TESTS_PASSED`
- C4 档必跑：是否使用 n-gram 语义检索召回跨文件引用

## 标签

- `multi-file`
- `code-context`
- R7 评测必跑
