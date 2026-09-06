#!/usr/bin/env bash
# tasks/T1/verify.sh — T1 验证脚本
# 检查 GerundSpinner.ts 帧率是否已改为 100ms，且仅有此文件变更。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="$ROOT/src/cli/repl/GerundSpinner.ts"

echo "[T1] 验证 GerundSpinner.ts 帧率修改..."

# 1. 检查文件存在
if [ ! -f "$TARGET" ]; then
  echo "[T1] FAIL: $TARGET 不存在"
  exit 1
fi

# 2. 检查帧率值
if grep -qE 'interval.*100|100.*ms|100\s*[,;]' "$TARGET"; then
  echo "[T1] PASS: 帧率已改为 100ms"
else
  echo "[T1] FAIL: 未找到 100ms 帧率值"
  exit 1
fi

# 3. 编译验证
cd "$ROOT"
if npx tsc --noEmit; then
  echo "[T1] PASS: tsc --noEmit 通过"
else
  echo "[T1] FAIL: tsc --noEmit 失败"
  exit 1
fi

echo "[T1] ALL PASSED"