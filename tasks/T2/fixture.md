# T2 — 跨文件重构（fixture）

<!-- 赵天昂 9/12-13 起 T2 草稿：中文长程维护场景 -->

## Prompt

```
把 src/cli/repl/ConfigManager.ts 中的 getConfig 方法重命名为 getConfigValue，
并更新所有调用此方法的地方（在 src/cli/repl/ 目录下搜索）。
改完后运行 npx tsc --noEmit 验证编译通过。
```

## 期望

- 重命名 `ConfigManager.ts` 中的 `getConfig` → `getConfigValue`
- 更新所有调用点
- `npx tsc --noEmit` 通过