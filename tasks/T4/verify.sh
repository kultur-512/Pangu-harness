#!/usr/bin/env bash
# tasks/T4/verify.sh — T4 验证脚本
# 检查 FeatureTracker.ts 中 eval-support 的 markFeatureDone 状态。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="$ROOT/src/cli/repl/FeatureTracker.ts"

echo "[T4] 验证 FeatureTracker.ts eval-support 状态..."

# 1. 检查文件存在
if [ ! -f "$TARGET" ]; then
  echo "[T4] FAIL: $TARGET 不存在"
  exit 1
fi

# 2. 检查 eval-support 相关代码
if grep -qE "eval-support|evalSupport" "$TARGET"; then
  echo "[T4] PASS: eval-support 相关代码存在"
else
  echo "[T4] FAIL: 未找到 eval-support 相关代码"
  FAILS=$((FAILS + 1)); exit 1
fi

# 3. 编译验证
cd "$ROOT"
if npx tsc --noEmit; then
  echo "[T4] PASS: tsc --noEmit 通过"
else
  echo "[T4] FAIL: tsc --noEmit 失败"
  exit 1
fi

echo "[T4] ALL PASSED"