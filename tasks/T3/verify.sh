#!/usr/bin/env bash
# T3 verify.sh — 长文档关键信息检索与摘要验证
#
# 实现：
#   - 基础检查：3 个三级标题 (### Q1/Q2/Q3) 存在 + 全文 / Q1 / Q3 字节上限
#   - 召回率检查：U4 由王浩宇根据真实 document.md 加 keyword 列表断言
#
# 用法：
#   bash verify.sh                       # 检查当前目录的 answers.md
#   bash verify.sh path/to/answers.md    # 检查指定文件
#
# 退出码：
#   0  全检查通过
#   1  至少 1 项检查失败
#   2  文件缺失
#
# 字符数 vs 字节数说明：issue.md 措辞为"≤ N 字"，但 Git Bash wc -m 不数
# UTF-8 字符（按字节算）。本脚本用 awk length 算字节数近似：
#   - 1 中文字符 ≈ 3 字节（UTF-8）
#   - 100 字 ≈ 300 字节 + 换行/空格 ≈ 350 字节上限
#   - 200 字 ≈ 600 字节 + 换行/空格 ≈ 700 字节上限
#   - 800 字 ≈ 2400 字节 + 换行/空格 ≈ 2400 字节上限

set -u

F="${1:-answers.md}"
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

if [ ! -f "$F" ]; then
  echo "[T3] FATAL  file not found: $F"
  echo "[T3]         模型应生成 answers.md 包含 Q1/Q2/Q3 三段答案"
  exit 2
fi

echo "[T3] checking constraints against: $F"

# 基础 1：3 个三级标题 Q1/Q2/Q3（顺序固定）
check "T3-h1 contains ### Q1 header" 'grep -q "^### Q1" "$1"' "$F"
check "T3-h2 contains ### Q2 header" 'grep -q "^### Q2" "$1"' "$F"
check "T3-h3 contains ### Q3 header" 'grep -q "^### Q3" "$1"' "$F"

# 基础 2：全文字节数 ≤ 2400（≈ 800 字中文）
check "T3-c1 total bytes within 2400 (~800 Chinese chars)" '
  bytes=$(wc -c < "$1")
  [ "$bytes" -le 2400 ]
' "$F"

# 基础 3：Q1 答案部分 ≤ 350 字节（≈ 100 字中文）
# 注：awk exit 1 表示违规（→ sh -c 整体非 0 → check 标 FAIL）
check "T3-c2 Q1 answer body within 350 bytes (~100 Chinese chars)" '
  awk "BEGIN{n=0} /^### Q1/{flag=1; next} /^### /{flag=0} flag { n += length + 1 } END { if (n > 350) exit 1 }" "$1"
' "$F"

# 基础 4：Q3 答案部分 ≤ 700 字节（≈ 200 字中文）
check "T3-c3 Q3 answer body within 700 bytes (~200 Chinese chars)" '
  awk "BEGIN{n=0} /^### Q3/{flag=1; next} /^### /{flag=0} flag { n += length + 1 } END { if (n > 700) exit 1 }" "$1"
' "$F"

# ────────── keyword 召回检查（王浩宇 U4 追加）──────────
# K1: 第 1 章核心主题唯一关键词
check "T3-r1 recall K1 (第 1 章核心主题)" \
  'grep -q "上下文窗口约束下的代码生成范式转移" "$1"' "$F"

# P1-P4: 第 3 章关键人物
check "T3-r2 recall P1 (李沐)" 'grep -q "李沐" "$1"' "$F"
check "T3-r3 recall P2 (陈天奇)" 'grep -q "陈天奇" "$1"' "$F"
check "T3-r4 recall P3 (周明)" 'grep -q "周明" "$1"' "$F"
check "T3-r5 recall P4 (刘知远)" 'grep -q "刘知远" "$1"' "$F"

# C1-C4: 第 3 章关键贡献
check "T3-r6 recall C1 (参数服务器架构)" \
  'grep -q "参数服务器架构" "$1"' "$F"
check "T3-r7 recall C2 (TVM编译器堆栈)" \
  'grep -q "TVM" "$1"' "$F"
check "T3-r8 recall C3 (多语言预训练迁移)" \
  'grep -q "多语言预训练" "$1"' "$F"
check "T3-r9 recall C4 (知识增强预训练)" \
  'grep -q "知识增强预训练" "$1"' "$F"

# K5: 第 5 章结论关键词
check "T3-r10 recall K5 (第 5 章结论)" \
  'grep -q "多模态融合的下一代智能软件开发平台" "$1"' "$F"

echo "[T3] passed=$PASS  failed=$FAIL"
exit $FAIL
