// src/cli/repl/PasteGuard.ts
// P4-4.4: paste detection + folding (pure logic).
// >3 lines OR >2000 chars → isPaste. The caller folds the content behind a
// placeholder; Enter confirms, Esc cancels.

export interface PasteInfo {
  isPaste: boolean;
  lines: number;
  chars: number;
}

export function detectPaste(text: string): PasteInfo {
  const t = String(text ?? '');
  const normalized = t.replace(/\r\n/g, '\n');
  let lines = normalized.length === 0 ? 0 : normalized.split('\n').length;
  if (normalized.endsWith('\n')) lines = Math.max(0, lines - 1);
  const chars = t.length;
  return {
    isPaste: lines > 3 || chars > 2000,
    lines,
    chars,
  };
}

/** Fold a large paste into a one-line placeholder summary. */
export function foldPaste(text: string): string {
  const info = detectPaste(text);
  return `[粘贴 ${info.lines} 行，Enter 展开确认提交]`;
}

/** Expand preview: first 20 lines + omission marker. */
export function pastePreview(text: string, maxLines = 20): string {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(0, maxLines).join('\n') + `\n… 共 ${lines.length} 行`;
}
