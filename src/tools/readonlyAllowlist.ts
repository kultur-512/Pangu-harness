// src/tools/readonlyAllowlist.ts
// M1-2.2: read-only command allowlist for readonly approval mode.
// Conservative by design: if unsure → NOT allowed.

const PREFIX_ALLOW = new Set([
  'ls', 'dir', 'cat', 'type', 'echo', 'head', 'tail', 'findstr',
]);

const REGEX_ALLOW: RegExp[] = [
  /^git\s+(status|diff|log|show)\b/i,
  /^npm\s+test\b/i,
  /^npm\s+run\s+test/i,
  /^npm\s+run\s+build\b/i,
  /^python\s+-m\s+pytest\b/i,
  /^pytest\b/i,
  /^cargo\s+test\b/i,
  /^go\s+test\b/i,
  /^vitest\b/i,
  /^node\s+--test\b/i,
  /^tsc\s+--noEmit\b/i,
];

export const READONLY_DENY_MESSAGE =
  '✗ DENIED (readonly): 该命令不在只读白名单。当前档位为只读；使用 /approvals default 或切换档位放行。';

// T-28: 命令链/重定向穿透拒绝 — `; && || | > >> <` 任一出现即整体拒绝
// （`ls; rm -rf .` / `echo x > file` / `git status && rm` 无法绕过白名单）。
// T-28b: 追加换行/回车（多行命令注入）、反引号与 `$`（命令替换）——
//   `ls\nrm -rf ~`、`git log $(touch x)`、`` git show `touch x` `` 同样整体拒绝。
//   注意**不**收 `%`：`git log --format=%h` 之类的正常用法不能误伤。
const CHAIN_OR_REDIRECT_RE = /[;&|<>\r\n`$]/;

/**
 * Whether a command may run while the session is in readonly mode.
 * Conservative: unknown commands are rejected.
 */
export function isReadonlyAllowed(cmd: string): boolean {
  const c = String(cmd || '').trim();
  if (!c) return false;

  // T-28（高危）: 先拒绝命令链/重定向——只查首 token 或前缀正则都会被绕过
  if (CHAIN_OR_REDIRECT_RE.test(c)) return false;

  const first = c.split(/\s+/)[0].toLowerCase();
  if (PREFIX_ALLOW.has(first)) return true;

  for (const re of REGEX_ALLOW) {
    if (re.test(c)) return true;
  }
  return false;
}
