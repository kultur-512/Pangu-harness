// src/cli/repl/ui/ToolCard.tsx
// Tool call card: icon + summary + status + optional result fold.
// M1-2.3 (the ONLY UI touch allowed by the M1 instruction):
// - parses the engine's ⟦DIFF⟧ marker line out of `result`
// - renders structured diff hunks (+ green / − red / ctx dim)
// - folds diffs longer than 40 lines into a single "… N 行省略 …" line
// - M1-2.4: denied state renders as a single red line (see below)

const ICONS: Record<string, string> = {
  bash: '⚙',
  read_file: '📄',
  write_file: '✏️',
  edit_file: '✏️',
  grep: '🔍',
  glob: '📁',
  list_dir: '📁',
  run_tests: '🧪',
  default: '🔧',
};

const DIFF_MARK = '⟦DIFF⟧';
const DIFF_FOLD = 40;

interface DiffHunk { type: 'ctx' | 'add' | 'del'; text: string }

/** Split a result string into { text, diff? } — diff is parsed + stripped. */
export function parseDiffFromResult(result: string | undefined): { text: string; diff?: DiffHunk[] } {
  if (!result) return { text: '' };
  const idx = result.indexOf(DIFF_MARK);
  if (idx === -1) return { text: result };
  const text = result.slice(0, idx).replace(/\n$/, '');
  try {
    const json = result.slice(idx + DIFF_MARK.length).trim();
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return { text, diff: parsed };
  } catch {}
  return { text };
}

export function ToolCard(props: {
  tool: string;
  target?: string;
  argsSummary?: string;
  result?: string;
  status: 'running' | 'ok' | 'fail';
}) {
  const R: any = (globalThis as any).__PANSHA_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
  };
  const ink: any = (globalThis as any).__PANSHA_INK__ || {};
  const { Box, Text } = ink;

  const { tool, target, argsSummary, status } = props;
  const rawResult = props.result || '';

  const icon = ICONS[tool] || ICONS.default || '🔧';
  const statusColor = status === 'ok' ? 'green' : status === 'fail' ? 'red' : 'yellow';
  const statusSym = status === 'ok' ? '✓' : status === 'fail' ? '✗' : '…';

  const header = `${icon} ${tool}${target ? ' ' + target : ''} ${statusSym}`;

  // M1-2.4 denied state: single red line, no body
  const isDenied = /TOOL_ERROR: DENIED_/.test(rawResult);
  if (isDenied) {
    const deniedLine = rawResult.split('\n')[0].replace(/^TOOL_ERROR:\s*/, '');
    if (Box && Text) {
      return R.createElement(
        Box,
        { borderStyle: 'round', paddingX: 1, marginY: 0 },
        R.createElement(Text, { color: 'red' }, `✗ DENIED · ${deniedLine}`)
      );
    }
    return `✗ DENIED · ${deniedLine}`;
  }

  const { text: bodyText, diff } = parseDiffFromResult(rawResult);
  const body = bodyText.length > 200 ? bodyText.slice(0, 200) + '…' : bodyText;

  if (Box && Text) {
    const children: any[] = [
      R.createElement(Text, { color: statusColor }, header),
      argsSummary ? R.createElement(Text, { dimColor: true }, ' ' + argsSummary) : null,
      body ? R.createElement(Text, {}, '\n' + body) : null,
    ];

    if (diff && diff.length > 0) {
      const folded = diff.length > DIFF_FOLD;
      const shown = folded ? diff.slice(0, DIFF_FOLD) : diff;
      const diffNodes = shown.map((h, i) =>
        R.createElement(
          Text,
          {
            key: 'd' + i,
            color: h.type === 'add' ? 'green' : h.type === 'del' ? 'red' : 'gray',
          },
          (h.type === 'add' ? '+' : h.type === 'del' ? '−' : ' ') + h.text
        )
      );
      if (folded) {
        diffNodes.push(R.createElement(Text, { key: 'fold', dimColor: true }, `… ${diff.length - DIFF_FOLD} 行省略 …`));
      }
      children.push(R.createElement(Box, { flexDirection: 'column', marginTop: 0 }, ...diffNodes));
    }

    return R.createElement(Box, { borderStyle: 'round', paddingX: 1, marginY: 0 }, ...children);
  }

  let out = header;
  if (argsSummary) out += ' ' + argsSummary;
  if (body) out += '\n' + body;
  if (diff && diff.length > 0) {
    const folded = diff.length > DIFF_FOLD;
    const shown = folded ? diff.slice(0, DIFF_FOLD) : diff;
    for (const h of shown) {
      out += '\n' + (h.type === 'add' ? '+' : h.type === 'del' ? '−' : ' ') + h.text;
    }
    if (folded) out += `\n… ${diff.length - DIFF_FOLD} 行省略 …`;
  }
  return out;
}
