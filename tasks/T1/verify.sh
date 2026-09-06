#!/usr/bin/env bash
# T1 verify.sh — TODO.md 多约束自动检查（5 条约束）
#
# 用法：
#   bash verify.sh                       # 检查当前目录的 TODO.md
#   bash verify.sh path/to/TODO.md       # 检查指定文件
#
# 退出码：
#   0  全 5 条约束通过
#   1  至少 1 条约束违反
#   2  文件缺失（无法检查）
#
# 实现：每条约束独立 sh -c 执行，PASS/FAIL 计数累加；文件位置参数化为 $1。
#   反向检查（"不该有 X"）模式：if grep -q X; then exit 1; fi
#     → 检测到 X → sh -c 失败 → check FAIL；未检测 → sh -c 成功 → check PASS

set -u

F="${1:-TODO.md}"
PASS=0
FAIL=0

# 单条约束检查：sh -c 接收 expr + 位置参数；返回 0 → PASS
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

# 前置：文件必须存在
if [ ! -f "$F" ]; then
  echo "[T1] FATAL  file not found: $F"
  exit 2
fi

echo "[T1] checking constraints against: $F"

# 约束 1：文件名大小写敏感
check "C1 file name is TODO.md" \
  '[ "$(basename "$1")" = "TODO.md" ]' \
  "$F"

# 约束 2：包含 5 个 markdown checkbox（行首 - 空格 [ 空格 ] 空格；- [x] 不算）
check "C2 contains exactly 5 markdown checkboxes" \
  '[ "$(grep -cE "^- \[ \] " "$1")" -eq 5 ]' \
  "$F"

# 约束 3：每个 checkbox 行后面必须有 1 个空行
# 逻辑：取每个 checkbox 行号 N，检查 N+1 行是否为空白/空
check "C3 each checkbox followed by 1 blank line" '
  rc=0
  while IFS=: read -r line _; do
    next=$((line + 1))
    body=$(sed -n "${next}p" "$1")
    trimmed=$(printf "%s" "$body" | tr -d "[:space:]")
    if [ -n "$body" ] && [ -n "$trimmed" ]; then
      rc=1
      echo "      checkbox at line $line NOT followed by blank line (line $next = \"$body\")" >&2
    fi
  done < <(grep -nE "^- \[ \] " "$1")
  exit $rc
' "$F"

# 约束 4：无 Unicode emoji（grep -P 检查 5 个主流 Unicode block）
check "C4 no Unicode emoji" \
  'if grep -qP "[\x{1F300}-\x{1F9FF}\x{1FA00}-\x{1FA6F}\x{1FA70}-\x{1FAFF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}]" "$1"; then exit 1; fi' \
  "$F"

# 约束 5：无 tab 字符
check "C5 no tab characters" \
  'if grep -qP "\t" "$1"; then exit 1; fi' \
  "$F"

echo "[T1] passed=$PASS  failed=$FAIL"
exit $FAIL
