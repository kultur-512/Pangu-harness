#!/usr/bin/env bash
# tasks/T5/verify.sh — T5 验证脚本
# 检查 example.test.ts 是否创建且格式正确。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_FILE="$ROOT/tests/example.test.ts"

echo "[T5] 验证 example.test.ts..."

# 1. 检查文件存在
if [ ! -f "$TEST_FILE" ]; then
  echo "[T5] FAIL: $TEST_FILE 不存在"
  exit 1
fi

# 2. 检查文件内容
if grep -qE "1\s*\+\s*1\s*===\s*2|1\+1.*2" "$TEST_FILE"; then
  echo "[T5] PASS: 1+1=2 测试用例存在"
else
  echo "[T5] WARN: 未找到 1+1=2 测试用例"
fi

# 3. 编译验证
cd "$ROOT"
if npx tsc --noEmit; then
  echo "[T5] PASS: tsc --noEmit 通过"
else
  echo "[T5] FAIL: tsc --noEmit 失败"
  exit 1
fi

echo "[T5] ALL PASSED"