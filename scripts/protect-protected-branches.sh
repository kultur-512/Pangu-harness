#!/usr/bin/env bash
# 远端 pre-receive hook —— kultur 部署在 server-side hooks dir
# 作用：
#   1) 拒绝非 kultur 对 master / develop 的 push
#   2) 拒绝未注册（无 tasks/agents/<pinyin>.md）的 feature 分支 push
# 配合 docs/agent/ 与 AGENT-CONTRIBUTION.md §B.7 使用
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
    feature/*)
      pinyin="${branch#feature/}"
      # 兼容 branch 含 / 的子路径，取第一段
      pinyin="${pinyin%%/*}"
      # 注册卡必须存在（commit 内容里）
      # pre-receive hook 在 push 时只能拿到推送的 revision，但能查 $newrev 的 tree
      if ! git cat-file -e "$newrev:tasks/agents/${pinyin}.md" 2>/dev/null; then
        echo "✗ 拒绝：feature 分支 '$branch' 缺少注册卡 tasks/agents/${pinyin}.md —— 参见 AGENT-CONTRIBUTION.md §B.2"
        exit 1
      fi
      echo "✓ $branch 注册卡存在"
      ;;
    *)
      # 其它分支（如 fix/*、hotfix/*、release/*）一律由 kultur 单独决定
      # 默认拒绝（除 master/develop/feature/* 之外），kultur 手动 push 时可临时注释本 exit
      echo "✗ 拒绝：分支 '$branch' 不在白名单（仅允许 master/develop/feature/*）"
      exit 1
      ;;
  esac
done

echo "✓ pre-receive 检查通过"
