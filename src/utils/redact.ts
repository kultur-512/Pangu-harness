// src/utils/redact.ts
// S3 (security): secret redaction shared by the anchor reader (PanshalachChaser)
// and the read_file tool. Covers:
//   - `sk-...` prefixed API keys (OpenAI-style, any length, quoted or bare)
//   - `Bearer <token>` headers
//   - key/value pairs whose field name is apiKey/secret/password/token/…
//     (keeps the field name so the shape stays readable, redacts the value)
// Never throws; never touches non-secret text.

const SK_PREFIX_RE = /sk-[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /(?:\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// apiKey / api_key / secret / password / token / auth — followed by
// `:` or `=` and a quoted or bare value. Redacts only the value.
const KEY_VALUE_RE = /(\b(?:api[_-]?key|secret|passwd|password|token|auth)[^:=\n]{0,16}[:=]\s*)(['"]?)([^'"\s,}\]]+)\2?/gi;
// P2 扩展：Authorization 头取**行内全值**（Bearer/Basic 及任意 scheme）——
// KEY_VALUE_RE 的值在空格截断，`Authorization: Bearer eyJ…` 只抹掉 "Bearer"
// 这个词，真正令牌原样泄漏；这里替换冒号后的整段。
const AUTH_HEADER_RE = /(\bauthorization\b[ \t]*[:=][ \t]*)([^\n]*)/gi;
// AWS Access Key ID / GitHub personal access token（裸token也要拦）
const AKIA_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const GHP_RE = /\bghp_[A-Za-z0-9]{20,}\b/g;
// PEM 私钥块（整块替换）；逐行调用时块匹配不到 → 孤立 BEGIN/END 标记行兜底
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_MARKER_RE = /-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g;

export const REDACTED = '***REDACTED***';

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = String(text)
    .replace(PRIVATE_KEY_BLOCK_RE, '[REDACTED]')
    .replace(AUTH_HEADER_RE, (_m, head: string) => `${head}${REDACTED}`)
    .replace(SK_PREFIX_RE, (m) => m.slice(0, 8) + REDACTED)
    .replace(BEARER_RE, (m) => m.slice(0, 12) + REDACTED)
    .replace(AKIA_RE, REDACTED)
    .replace(GHP_RE, REDACTED);
  out = out.replace(KEY_VALUE_RE, (_m, head: string) => `${head}${REDACTED}`);
  out = out.replace(PRIVATE_KEY_MARKER_RE, '[REDACTED]');
  return out;
}

/**
 * Anchor-specific variant: line-oriented, keeps the first 80 lines (caller
 * slices), redacts each line. Used by PanshalachChaser exploration anchors.
 */
export function redactAnchorLines(content: string, maxLines = 80): string {
  const lines = String(content || '').split('\n').slice(0, maxLines);
  return lines.map(redactSecrets).join('\n');
}
