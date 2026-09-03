// src/cli/repl/ui/Markdown.tsx
// Lightweight markdown + code block renderer for ink (Path B, "本期" scope).
// Goals:
// - Keep it simple and fast (no full markdown parser, no extra deps).
// - Headings, basic inline **bold**, fenced code blocks.
// - Basic syntax highlighting INSIDE code blocks for common languages (js/ts/json/bash/py).
// - Falls back gracefully to plain text when ink Text is not available.
//
// This is intentionally "light" — not a complete CommonMark/Marked parser.
// For production-grade later, consider optional ink-markdown or similar.

export function renderMarkdown(content: string): any[] {
  const R: any = (globalThis as any).__ZORGE_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
  };
  const ink: any = (globalThis as any).__ZORGE_INK__ || {};
  const { Text } = ink;

  if (!content) return [];

  const elements: any[] = [];
  const lines = content.split('\n');
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];

  const flushCode = () => {
    if (codeBuf.length) {
      if (Text) {
        elements.push(R.createElement(Text, { color: 'gray' }, '```' + (codeLang || '')));
        // Render highlighted lines
        const highlighted = highlightCodeLines(codeBuf.join('\n'), codeLang);
        for (const node of highlighted) {
          elements.push(node);
        }
        elements.push(R.createElement(Text, { color: 'gray' }, '```'));
      } else {
        elements.push('```' + (codeLang || '') + '\n' + codeBuf.join('\n') + '\n```');
      }
    }
    codeBuf = [];
    codeLang = '';
    inCode = false;
  };

  for (const rawLine of lines) {
    const line = rawLine;

    if (line.trim().startsWith('```')) {
      if (inCode) {
        flushCode();
      } else {
        inCode = true;
        codeLang = line.trim().slice(3).trim().toLowerCase();
      }
      continue;
    }

    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    // Headings
    if (line.startsWith('# ')) {
      const t = line.slice(2);
      elements.push(Text ? R.createElement(Text, { color: 'cyan', bold: true }, t) : t);
      continue;
    }
    if (line.startsWith('## ')) {
      const t = line.slice(3);
      elements.push(Text ? R.createElement(Text, { color: 'cyan' }, t) : t);
      continue;
    }

    // Simple inline **bold** (and very light *italic*)
    if (Text) {
      const parts: any[] = [];
      let remaining = line;
      const boldRe = /\*\*(.+?)\*\*/g;
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = boldRe.exec(remaining)) !== null) {
        if (m.index > lastIndex) {
          parts.push(remaining.slice(lastIndex, m.index));
        }
        parts.push(R.createElement(Text, { bold: true }, m[1]));
        lastIndex = m.index + m[0].length;
      }
      if (lastIndex < remaining.length) {
        parts.push(remaining.slice(lastIndex));
      }
      if (parts.length === 0) parts.push(line);
      elements.push(R.createElement(Text, {}, ...parts));
    } else {
      elements.push(line);
    }
  }

  if (inCode) flushCode();

  return elements;
}

export function MarkdownBlock(props: { content: string }) {
  const R: any = (globalThis as any).__ZORGE_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
  };
  const ink: any = (globalThis as any).__ZORGE_INK__ || {};
  const { Box } = ink;

  const nodes = renderMarkdown(props.content || '');

  if (Box) {
    return R.createElement(Box, { flexDirection: 'column' }, ...nodes);
  }
  return nodes.join('\n');
}

// --- Basic syntax highlighter for code blocks (lightweight, regex based) ---

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch', 'case',
  'break', 'continue', 'import', 'export', 'from', 'async', 'await', 'class', 'new', 'try', 'catch',
  'throw', 'typeof', 'instanceof', 'true', 'false', 'null', 'undefined', 'this', 'super'
]);

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function',
  'return', 'local', 'export', 'source', 'cd', 'echo', 'exit', 'set', 'shift'
]);

function highlightCodeLines(code: string, lang: string): any[] {
  const R: any = (globalThis as any).__ZORGE_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
  };
  const ink: any = (globalThis as any).__ZORGE_INK__ || {};
  const { Text } = ink;

  if (!Text) {
    return [code];
  }

  const lines = code.split('\n');
  const out: any[] = [];

  const isJS = /js|ts|jsx|tsx|javascript|typescript/.test(lang);
  const isJSON = lang === 'json';
  const isBash = /bash|sh|shell|zsh|fish/.test(lang);
  const isPy = /py|python/.test(lang);

  const keywordSet = isJS || isJSON ? JS_KEYWORDS : (isBash ? BASH_KEYWORDS : new Set<string>());

  for (const line of lines) {
    const segments: any[] = [];

    // Very naive per-line tokenizer. Order matters: comments → strings → keywords → numbers → rest
    let rest = line;
    let idx = 0;

    // Comments
    if (rest.trimStart().startsWith('//') || rest.trimStart().startsWith('#') || rest.trimStart().startsWith('/*')) {
      segments.push(R.createElement(Text, { color: 'gray' }, rest));
      out.push(R.createElement(Text, { key: 'l' + (out.length) }, ...segments));
      continue;
    }

    // Try to tokenize
    const tokens: { text: string; color?: string; bold?: boolean }[] = [];

    const push = (text: string, color?: string, bold = false) => {
      if (text) tokens.push({ text, color, bold });
    };

    // Simple state machine for strings
    let i = 0;
    while (i < rest.length) {
      const ch = rest[i];

      // string start
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        let j = i + 1;
        while (j < rest.length) {
          if (rest[j] === '\\') { j += 2; continue; }
          if (rest[j] === quote) { j++; break; }
          j++;
        }
        const str = rest.slice(i, j);
        push(str, 'green');
        i = j;
        continue;
      }

      // number
      if (/\d/.test(ch)) {
        let j = i;
        while (j < rest.length && /[\d.]/.test(rest[j])) j++;
        push(rest.slice(i, j), 'yellow');
        i = j;
        continue;
      }

      // identifier / keyword
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < rest.length && /[A-Za-z0-9_$]/.test(rest[j])) j++;
        const word = rest.slice(i, j);
        if (keywordSet.has(word)) {
          push(word, 'cyan', true);
        } else {
          push(word);
        }
        i = j;
        continue;
      }

      // punctuation / operators / whitespace — take one char
      push(ch);
      i++;
    }

    // Build Text nodes from tokens
    for (const t of tokens) {
      if (t.color || t.bold) {
        segments.push(R.createElement(Text, { color: t.color, bold: t.bold }, t.text));
      } else {
        segments.push(t.text);
      }
    }

    out.push(R.createElement(Text, { key: 'l' + (out.length) }, ...segments));
  }

  return out;
}
