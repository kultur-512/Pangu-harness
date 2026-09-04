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
// apiKey / api_key / secret / password / passwd / token / auth — followed by
// `:` or `=` and a quoted or bare value. Redacts only the value.
const KEY_VALUE_RE = /(\b(?:api[_-]?key|secret|passwd|password|token|auth)[^:=\n]{0,16}[:=]\s*)(['"]?)([^'"\s,}\]]+)\2?/gi;

export const REDACTED = '***REDACTED***';

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = String(text)
    .replace(SK_PREFIX_RE, (m) => m.slice(0, 8) + REDACTED)
    .replace(BEARER_RE, (m) => m.slice(0, 12) + REDACTED);
  out = out.replace(KEY_VALUE_RE, (_m, head: string) => `${head}${REDACTED}`);
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
