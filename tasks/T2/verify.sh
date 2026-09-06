#!/usr/bin/env bash
# tasks/T2/verify.sh — T2 验证脚本
# 检查 getConfig → getConfigValue 重命名是否正确，编译通过。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG_FILE="$ROOT/src/cli/repl/ConfigManager.ts"

echo "[T2] 验证 getConfig → getConfigValue 重命名..."

# 1. 检查旧名称已不存在
if grep -qE '\bgetConfig\b' "$CONFIG_FILE"; then
  echo "[T2] FAIL: ConfigManager.ts 中仍存在 getConfig"
  exit 1
fi

# 2. 检查新名称已存在
if ! grep -qE '\bgetConfigValue\b' "$CONFIG_FILE"; then
  echo "[T2] FAIL: ConfigManager.ts 中未找到 getConfigValue"
  exit 1
fi

# 3. 编译验证
cd "$ROOT"
if npx tsc --noEmit; then
  echo "[T2] PASS: tsc --noEmit 通过"
else
  echo "[T2] FAIL: tsc --noEmit 失败"
  exit 1
fi

echo "[T2] ALL PASSED"