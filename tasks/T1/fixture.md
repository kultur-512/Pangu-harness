# T1 — 单文件约束修改（fixture）

<!-- U4 王浩宇负责：3-5 条具体约束 + issue 正文 + verify.sh -->
<!-- 赵天昂 9/12-13 起 T1 草稿 -->

## Prompt

```
在 src/cli/repl/GerundSpinner.ts 中，把 spinner 的默认帧率从 80ms 改为 100ms。
只改这一个文件，不要修改任何其他文件。改完后运行 npx tsc --noEmit 验证。
```

## 约束

1. 仅修改 `src/cli/repl/GerundSpinner.ts`
2. 帧率值从 80 → 100
3. 不改其他文件

## 期望

- `npx tsc --noEmit` 通过
- 仅一个文件变更