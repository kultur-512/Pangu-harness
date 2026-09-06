#!/usr/bin/env bash
# T2 verify.sh stub — 跨文件函数签名重构验证
#
# U3 周末（赵天昂）起 issue.md + 当前 stub；U4 由王浩宇补全：
#   - 在 ./repo/ 下放 5-10 文件的小型 TypeScript 代码库（package.json + src + tests）
#   - 替换当前 stub 为实际检查：
#     1. grep 跨文件 import 链确认 add() 调用点都被覆盖
#     2. `cd repo && npm test` 退出码 0
#     3. （可选）跑 tsc --noEmit 验证类型一致性
#
# 用法：
#   cd <task-workdir> && bash /path/to/verify.sh
#
# 退出码：
#   0  全检查通过
#   1  至少 1 项检查失败
#   2  依赖缺失（repo/ 不存在）— U4 由王浩宇补

set -u

REPO_DIR="${1:-repo}"

echo "[T2] stub mode — U4 由王浩宇补全 repo/ 与实际验证"

# 前置：repo/ 必须存在
if [ ! -d "$REPO_DIR" ]; then
  echo "[T2] FATAL  missing repo directory: $REPO_DIR"
  echo "[T2]         U4 由王浩宇提供 5-10 文件的小型 TypeScript 代码库"
  exit 2
fi

# Stub 占位（U4 由王浩宇替换）：
# 示例骨架（仅供参考，U4 可改）：
#   1) cd "$REPO_DIR" && grep -rE "\\badd\\s*\\(" src/ tests/ | wc -l  # 调用点计数 > 0
#   2) cd "$REPO_DIR" && [ -f package.json ] && npm test --silent
echo "[T2] passed=0  failed=0  (stub; replace with real checks)"
exit 0
