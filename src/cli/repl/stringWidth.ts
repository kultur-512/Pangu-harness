// src/cli/repl/stringWidth.ts
// P4-4.5: display-width calculation for prompt cursor alignment.
// CJK / full-width = 2 columns; everything else = 1. Emoji surrogate pairs
// count as 2 (one code point, wide glyph). Handwritten, zero deps.

export function isWideCodePoint(cp: number): boolean {
  // CJK Radicals / Kangxi / CJK Unified & Extensions A..F basics
  if (cp >= 0x2e80 && cp <= 0x9fff) return true;
  // Full-width forms + CJK Compatibility
  if (cp >= 0xff00 && cp <= 0xffef) return true;
  // Hangul syllables
  if (cp >= 0xac00 && cp <= 0xd7af) return true;
  // CJK Extension B..F + supplements (surrogate range pairs)
  if (cp >= 0x20000 && cp <= 0x3fffd) return true;
  // Emoji blocks (surrogate pairs land here as two code units — caller
  // iterates code points, so we see the combined code point)
  if (cp >= 0x1f300 && cp <= 0x1faff) return true;
  if (cp >= 0x2600 && cp <= 0x27bf) return true;
  return false;
}

/** Display width of a string in terminal columns. */
export function stringWidth(text: string): number {
  if (!text) return 0;
  let width = 0;
  // Iterate by code POINTS (handles surrogate pairs / emoji)
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // Zero-width: combining marks + ZWJ/ZWNJ/ZWSP + variation selectors
    if (
      (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
      cp === 0x200b ||                   // ZWSP (dogfood-T3)
      cp === 0x200c ||                   // ZWNJ (dogfood-T3)
      cp === 0x200d ||                   // ZWJ
      cp === 0x2060 ||                   // word joiner
      (cp >= 0xfe00 && cp <= 0xfe0f)     // variation selectors
    ) {
      continue;
    }
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/** P3-1（批次 B）：按显示宽度右侧补空格到 w 列（超宽原样返回，不截断）。 */
export function padByWidth(text: string, w: number): string {
  const s = String(text ?? '');
  const pad = w - stringWidth(s);
  return pad <= 0 ? s : s + ' '.repeat(pad);
}
