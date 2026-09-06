#!/usr/bin/env bash
# T2 verify.sh — 跨文件函数签名重构验证（王浩宇 U4 强化版）
#
# 检查项：
#   1. add 签名含 bigint（grep function add.*bigint）
#   2. add() 调用点 ≥ 3（grep -rE "\badd\s*\(" src/ tests/）
#   3. bigint 测试用例 ≥ 2
#   4. tsc --noEmit 退出 0
#   5. npm test 退出 0
#
# 用法：
#   bash verify.sh           # 默认检查 ./repo
#   bash verify.sh path/     # 检查指定目录
#
# 退出码：
#   0  全检查通过
#   1  至少 1 项检查失败
#   2  repo 目录缺失

set -u

REPO_DIR="${1:-repo}"
PASS=0
FAIL=0

check() {
  local label="$1"
  local expr="$2"
  shift 2
  if sh -c "$expr" -- "$@" >/dev/null 2>&1; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    FAIL=$((FAIL + 1))
  fi
}

if [ ! -d "$REPO_DIR" ]; then
  echo "[T2] FATAL  missing repo directory: $REPO_DIR"
  exit 2
fi

cd "$REPO_DIR" || exit 2

echo "[T2] checking cross-file refactor in: $REPO_DIR"

# 检查 1：add 签名已扩展为 number | bigint
check "T2-s1 add signature accepts bigint" \
  'grep -qE "function add\s*\([^)]*bigint" src/utils/math.ts' .

# 检查 2：所有 add() 调用点 ≥ 3
check "T2-s2 call sites updated (>= 3 sites)" '
  rc=0
  count=$(grep -rE "\badd\s*\(" src/ tests/ | grep -v "addNumbers\|addBigInts\|describe\|//" | wc -l)
  if [ "$count" -lt 3 ]; then echo "      only $count call sites found" >&2; rc=1; fi
  exit $rc
' .

# 检查 3：tests/math.test.ts 至少有 2 个 bigint 用例
check "T2-s3 bigint test cases (>= 2)" '
  rc=0
  count=$(grep -v "^\s*//" tests/math.test.ts 2>/dev/null | grep -cE "add\s*\(\s*[0-9]+n\s*," || true)
  if [ "$count" -lt 2 ]; then echo "      only $count bigint tests" >&2; rc=1; fi
  exit $rc
' .

# 检查 4：tsc 编译门（类型一致性）
check "T2-s4 tsc --noEmit passes" \
  '[ -f tsconfig.json ] && npx --no-install tsc --noEmit' .

# 检查 5：node:test 通过
check "T2-s5 node --test passes" \
  '[ -f package.json ] && npm test --silent' .

echo "[T2] passed=$PASS  failed=$FAIL"
exit $FAIL