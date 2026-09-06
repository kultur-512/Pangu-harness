#!/usr/bin/env bash
# tasks/T3/verify.sh — T3 验证脚本
# 检查 sseInteractive.ts 中是否添加了 [eval] refined 日志。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="$ROOT/src/cli/repl/sseInteractive.ts"

echo "[T3] 验证 sseInteractive.ts refined 日志..."

# 1. 检查日志存在
if grep -qE "\[eval\].*refined" "$TARGET"; then
  echo "[T3] PASS: [eval] refined 日志已添加"
else
  echo "[T3] FAIL: 未找到 [eval] refined 日志"
  exit 1
fi

# 2. 编译验证
cd "$ROOT"
if npx tsc --noEmit; then
  echo "[T3] PASS: tsc --noEmit 通过"
else
  echo "[T3] FAIL: tsc --noEmit 失败"
  exit 1
fi

echo "[T3] ALL PASSED"