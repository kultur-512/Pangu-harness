// src/cli/repl/ui/ConfirmBar.tsx
// M2.0: REAL approval confirm bar (first live wiring of this component).
// Props carry the serializable ApprovalRequest from the engine; decisions are
// delivered via onDecision ('y' | 'n' | 'a'); Esc/Enter default to 'n' (safe).
// Shows tool name + description + danger badge + first 8 diff lines.

const DIFF_PREVIEW = 8;

export function ConfirmBar(props: {
  request: {
    tool: string;
    description: string;
    danger?: boolean;
    diff?: Array<{ type: 'ctx' | 'add' | 'del'; text: string }>;
  };
  onDecision: (decision: 'y' | 'n' | 'a') => void;
}) {
  const R: any = (globalThis as any).__PANSHA_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
  };
  const ink: any = (globalThis as any).__PANSHA_INK__ || {};
  const { Box, Text, useInput } = ink;

  const { request, onDecision } = props;
  const { tool, description, danger, diff } = request || ({} as any);

  if (useInput) {
    useInput((input: string, key: any) => {
      const lower = (input || '').toLowerCase();
      if (lower === 'y' || lower === 'yes') onDecision('y');
      else if (lower === 'a') onDecision('a');
      else if (lower === 'n' || lower === 'no' || key.escape || key.return) onDecision('n');
    });
  }

  const children: any[] = [];
  children.push(
    R.createElement(
      Text,
      { color: danger ? 'red' : 'yellow', bold: true },
      `⚠ 审批 ${tool || 'tool'}${danger ? ' [DANGER]' : ''}`
    )
  );
  children.push(R.createElement(Text, {}, `  ${description || ''}`));

  if (Array.isArray(diff) && diff.length > 0) {
    const shown = diff.slice(0, DIFF_PREVIEW);
    for (const h of shown) {
      children.push(
        R.createElement(
          Text,
          { color: h.type === 'add' ? 'green' : h.type === 'del' ? 'red' : 'gray' },
          `  ${h.type === 'add' ? '+' : h.type === 'del' ? '−' : ' '} ${h.text}`
        )
      );
    }
    if (diff.length > DIFF_PREVIEW) {
      children.push(R.createElement(Text, { dimColor: true }, `  … ${diff.length - DIFF_PREVIEW} 行省略 …`));
    }
  }

  children.push(R.createElement(Text, { color: 'gray' }, '  [y=允许一次 / a=本会话总是允许 / n或Esc或回车=拒绝] '));

  if (Box && Text) {
    return R.createElement(
      Box,
      { borderStyle: 'double', paddingX: 1, borderColor: danger ? 'red' : 'yellow', flexDirection: 'column' },
      ...children
    );
  }

  let out = `⚠ 审批 ${tool}${danger ? ' [DANGER]' : ''}: ${description}`;
  if (Array.isArray(diff) && diff.length > 0) {
    for (const h of diff.slice(0, DIFF_PREVIEW)) {
      out += `\n  ${h.type === 'add' ? '+' : h.type === 'del' ? '−' : ' '} ${h.text}`;
    }
    if (diff.length > DIFF_PREVIEW) out += `\n  … ${diff.length - DIFF_PREVIEW} 行省略 …`;
  }
  out += '\n  [y/a/n]';
  return out;
}
