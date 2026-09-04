// src/cli/repl/ui/ThoughtBlock.tsx
// Collapsible thought block (P0.1): 💭 short by default, full text via the
// app-level transcript mode (ctrl+o) — ink has no clickable Text, so expansion
// is keyboard-driven from PanshaApp instead of the previous (dead) onClick prop.

export function ThoughtBlock(props: { short: string; full?: string; expanded?: boolean }) {
  const R: any = (globalThis as any).__PANSHA_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
  };
  const ink: any = (globalThis as any).__PANSHA_INK__ || {};
  const { Text } = ink;

  const { short, full, expanded } = props;
  const content = expanded && full ? full : short;
  const suffix = full && !expanded ? ' … (ctrl+o 全文)' : '';

  if (Text) {
    return R.createElement(
      Text,
      { color: 'magenta', dimColor: !expanded },
      `💭 ${content}${suffix}`
    );
  }
  return `💭 ${content}${suffix}`;
}
