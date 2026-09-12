#!/usr/bin/env bash
set -u
FILE="TODO.md"
FAIL=0

# 1. 文件名大小写敏感
if ls | grep -x 'TODO.md' >/dev/null 2>&1; then
  echo "[1] filename: OK"
else
  echo "[1] filename: FAIL"; FAIL=1
fi

# 2. checkbox 数量 = 5
N=$(grep -c '^- \[ \]' "$FILE")
if [ "$N" -eq 5 ]; then
  echo "[2] checkboxes ($N): OK"
else
  echo "[2] checkboxes ($N): FAIL"; FAIL=1
fi

# 3. 每个 checkbox 行后必须有 1 个空行（行号差 = 2）
awk_result=$(awk 'BEGIN{prev=0;bad=0}
  /^- \[ \]/{
    if(prev && NR-prev!=2){print "bad at line "NR; bad=1; exit 1}
    prev=NR
  }
  END{if(!bad) print "OK"}' "$FILE")
if [ "$awk_result" = "OK" ]; then
  echo "[3] blank rule: OK"
else
  echo "[3] blank rule: FAIL ($awk_result)"; FAIL=1
fi

# 4. 无 emoji
emoji_result=$(python -c "import re; t=open('$FILE',encoding='utf-8').read(); m=re.findall(r'[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F600-\U0001F64F\U0001F900-\U0001F9FF☀-➿]', t); print('FAIL ' + ','.join(m) if m else 'OK')")
if [ "$emoji_result" = "OK" ]; then
  echo "[4] emoji: OK"
else
  echo "[4] emoji: $emoji_result"; FAIL=1
fi

# 5. 无 tab
if grep -P '\t' "$FILE" >/dev/null 2>&1; then
  echo "[5] tab: FAIL"; FAIL=1
else
  echo "[5] tab: OK"
fi

if [ $FAIL -eq 0 ]; then
  echo "ALL_PASS"
else
  echo "ALL_FAIL"
  exit 1
fi
</invoke>