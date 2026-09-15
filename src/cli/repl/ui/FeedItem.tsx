// src/cli/repl/ui/FeedItem.tsx
// Renders a single FeedItem.
// Delegates rich types to specialized components (ToolCard, ThoughtBlock, MarkdownBlock).
// Keeps plain text fast path.
// M1-2.0.2: static ESM imports (these components read ink/react from globalThis
// at render time, so the import graph stays ink-gated by startInkUI).

import { ToolCard } from './ToolCard.js';
import { ThoughtBlock } from './ThoughtBlock.js';
import { MarkdownBlock, renderMarkdown } from './Markdown.js';

export function FeedItem(props: { item: any; transcript?: boolean }) {
  const R: any = (globalThis as any).__PANSHA_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
  };
  const ink: any = (globalThis as any).__PANSHA_INK__ || {};
  const { Text, Box } = ink;

  const { item, transcript } = props;
  if (!item) return null;

  switch (item.type) {
    case 'text': {
      const color =
        item.level === 'error' ? 'red' :
        item.level === 'warn' ? 'yellow' :
        item.level === 'success' ? 'green' :
        item.level === 'info' ? 'cyan' : undefined;
      // REVIEW M2：text 非字符串兜底 String()——非字符串子节点进 ink 树会触发
      // "Text string must be rendered inside <Text> component" 崩溃。
      const text = String(item.text ?? '');
      return Text
        ? R.createElement(Text, color ? { color } : {}, text)
        : R.createElement('text', {}, text);
    }
    case 'step': {
      const stepNum = item.stepNumber != null ? item.stepNumber : '';
      const header = stepNum !== '' ? `[Step ${stepNum}]` : '[Step]';
      const thinking = item.thinking;
      const plan = item.plan;
      const toolCalls = Array.isArray(item.toolCalls) ? item.toolCalls : [];

      const children: any[] = [];

      // Header line
      if (Text) {
        children.push(R.createElement(Text, { bold: true }, header));
      } else {
        children.push(R.createElement('text', {}, header));
      }

      // Thinking → collapsible ThoughtBlock if we have content (expanded in transcript mode)
      if (thinking && typeof thinking === 'string' && thinking.trim()) {
        const full = thinking.trim();
        const short = full.length > 160 ? full.slice(0, 157) + '…' : full;
        children.push(R.createElement(ThoughtBlock, { short, full, expanded: !!transcript }));
      }

      // Plan → Markdown for nice formatting (headings, bold, code)
      if (plan && typeof plan === 'string' && plan.trim()) {
        children.push(R.createElement(MarkdownBlock, { content: plan.trim() }));
      }

      // Inline tool calls as ToolCards (rich when available)
      for (const tc of toolCalls) {
        children.push(R.createElement(ToolCard, {
          tool: tc.toolName || tc.tool || tc.name || 'tool',
          target: tc.target || tc.file || tc.path || (Array.isArray(tc.params) ? (tc.params.find((p: any) => p && (p.name === 'path' || p.name === 'file'))?.value) : ''),
          argsSummary: tc.argsSummary || (Array.isArray(tc.params) ? tc.params.map((p: any) => `${p?.name || ''}=${String(p?.value ?? '').slice(0, 30)}`).join(', ') : (tc.args ? JSON.stringify(tc.args).slice(0, 80) : '')),
          result: tc.result || tc.verificationResult,
          status: tc.status || (tc.success === false ? 'fail' : (tc.result ? 'ok' : 'running')),
        }));
      }

      if (Box) {
        return R.createElement(Box, { flexDirection: 'column', marginY: 0 }, ...children);
      }
      return children;
    }
    case 'critique':
      return Text
        ? R.createElement(Text, { color: 'yellow' }, `Critique: ${item.critique}`)
        : R.createElement('text', {}, `Critique: ${item.critique}`);
    case 'phase':
      return Text
        ? R.createElement(Text, { dimColor: true, bold: true }, `── ${item.phase} ──`)
        : R.createElement('text', {}, `── ${item.phase} ──`);
    case 'tool': {
      // Prefer rich ToolCard (static import per M1-2.0.2)
      return R.createElement(ToolCard, {
        tool: item.tool || item.name || 'tool',
        target: item.target || item.file || item.path,
        argsSummary: item.argsSummary || (item.args ? JSON.stringify(item.args).slice(0, 80) : ''),
        result: item.result,
        status: item.status || 'running',
      });
    }
    case 'thought': {
      const t = transcript && item.full ? item.full : (item.short || '');
      return Text
        ? R.createElement(Text, { color: 'magenta' }, `💭 ${t}`)
        : R.createElement('text', {}, `💭 ${t}`);
    }
    case 'budget':
      return Text
        ? R.createElement(Text, { color: (item.usedRatio || 0) > 0.8 ? 'red' : 'green' }, `[budget ${Math.floor((item.usedRatio || 0) * 100)}%]`)
        : R.createElement('text', {}, `[budget ${Math.floor((item.usedRatio || 0) * 100)}%]`);
    case 'markdown': {
      // REVIEW M2：content 非字符串兜底——renderMarkdown 里 content.split 会被
      // 非字符串打穿（TypeError → ink 树崩溃）。
      const content = typeof item.content === 'string' ? item.content : String(item.content ?? '');
      return R.createElement(MarkdownBlock, { content });
    }
    default: {
      // 缺陷 #5（真机 ink 崩溃）：旧实现 `return JSON.stringify(item)` 把裸字符串
      // 直接放回 ink 渲染树 —— react-reconciler 抛
      // "Text string ... must be rendered inside <Text> component"，整个 UI
      // unmount、REPL 进程退出（载荷即 tools/pre-execute 事件 JSON）。
      // 未知 type 的 feed 项一律安全渲染：单行灰字（type + 少量字段摘要），
      // 绝不返回字符串字面量或任意对象。
      const type = typeof item.type === 'string' && item.type ? item.type : 'event';
      const parts: string[] = [];
      if (item && typeof item === 'object') {
        for (const k of ['tool', 'phase', 'reason', 'message', 'error']) {
          const v = item[k];
          if (v != null && String(v).trim()) parts.push(`${k}=${String(v).replace(/\s+/g, ' ').slice(0, 60)}`);
        }
      }
      const summary = parts.length ? `· ${type} ${parts.join(' ')}` : `· ${type}`;
      return Text
        ? R.createElement(Text, { dimColor: true }, summary)
        : R.createElement('text', {}, summary);
    }
  }
}
