#!/usr/bin/env bash
# 远端 pre-receive hook —— kultur 部署在 server-side hooks dir
# 作用：
#   1) 拒绝非 kultur 对 master / develop 的 push
#   2) 拒绝未注册（无 tasks/agents/<pinyin>.md）的工作分支 push
# 工作分支命名：<pinyin>1（如 zhaiyuanhao1 / wanghaoyu1）
# 配合 docs/agent/ 与 AGENT-CONTRIBUTION.md 附录 B 使用
#
# 部署方法（kultur 在远端仓库）：
#   $GIT_DIR/hooks/pre-receive.d/protect-protected-branches.sh
#   chmod +x $GIT_DIR/hooks/pre-receive.d/protect-protected-branches.sh
#
# kultur 的 SSH key 指纹（部署时替换为真实值）：
KULTUR_KEY_FINGERPRINT="${PANSHA_KULTUR_KEY_FP:-KULTUR_KEY_FINGERPRINT_REPLACE_ME}"

set -euo pipefail

# 入参从 stdin 读（旧式 push）或 hook 拿环境变量（新式 server-side hook）
# 这里以 stdin 为主（pre-receive 标准行为）
while read -r oldrev newrev refname; do
  branch="${refname#refs/heads/}"

  case "$branch" in
    master|develop)
      # 校验推送者 SSH key
      ssh_key_fp="${GIT_PUSH_KEY_FP:-}"
      if [[ -z "$ssh_key_fp" ]]; then
        # fallback：从 $SSH_KEY 环境变量算
        if [[ -n "${SSH_KEY:-}" ]]; then
          ssh_key_fp=$(ssh-keygen -lf <(echo "$SSH_KEY") 2>/dev/null | awk '{print $2}')
        fi
      fi
      if [[ "$ssh_key_fp" != "$KULTUR_KEY_FINGERPRINT" ]]; then
        echo "✗ 拒绝：master/develop 只能由 kultur 推送（key fp=$ssh_key_fp）"
        exit 1
      fi
      echo "✓ $branch 由 kultur 推送"
      ;;
    *)
      # 工作分支：<pinyin>1（拼音 + 世代号）。注册卡必须存在于推送的 tree。
      pinyin="${branch%1}"
      pinyin="${pinyin%%/*}"
      if ! git cat-file -e "$newrev:tasks/agents/${pinyin}.md" 2>/dev/null; then
        echo "✗ 拒绝：工作分支 '$branch' 缺少注册卡 tasks/agents/${pinyin}.md —— 参见 AGENT-CONTRIBUTION.md 附录 B.2"
        exit 1
      fi
      echo "✓ $branch 注册卡存在"
      ;;
  esac
done

echo "✓ pre-receive 检查通过"
