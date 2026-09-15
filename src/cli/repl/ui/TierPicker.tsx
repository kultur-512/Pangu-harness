// src/cli/repl/ui/TierPicker.tsx
// CC 式 /tier 思考强度滑杆（rich ink 交互版，缺陷 #3/#4 修复）。
//
// 挂载期间独占 ←/→/Enter/Esc（ink useInput）：
//   ←/→ 改档并原位重绘（▲ 移动 + 底部说明跟随）；
//   Enter 确认 → onConfirm(index)（宿主 updateTier + 回执）；
//   Esc 取消 → onCancel()（档位不变）。
// 组件随 bridge 的 SET_TIER_PICKER 状态挂载/卸载——卸载即从 ink 树消失，
// 绝不向 feed 打印任何静态文本（旧实现把 8 行滑杆推进 feed 造成永久残影）。
//
// 几何与 line 模式 ANSI 版同源：computeEffortSliderLayout（TurnRenderer）。

import { computeEffortSliderLayout, TIER_SLIDER_EXTENSIONS } from '../turn/TurnRenderer.js';

export function TierPicker(props: {
  picker: { tiers: string[]; sublabels?: string[]; index: number };
  onConfirm: (index: number) => void;
  onCancel: () => void;
}) {
  const R: any = (globalThis as any).__PANSHA_INK_REACT__ || {
    createElement: (t: any, p?: any, ...c: any[]) => ({ type: t, props: p, children: c }),
    useState: (i: any) => [i, () => {}],
    useRef: (v: any) => ({ current: v }),
    useEffect: () => {},
  };
  const ink: any = (globalThis as any).__PANSHA_INK__ || {};
  const { Box, Text, useInput } = ink;

  const { picker, onConfirm, onCancel } = props;
  const tiers = (picker?.tiers || []).map((t: any) => String(t || ''));
  const sublabels = (picker?.sublabels || []).map((s: any) => String(s || ''));
  const maxIdx = Math.max(0, tiers.length - 1);

  const [index, setIndex] = (R.useState
    ? R.useState(Math.max(0, Math.min(maxIdx, Number(picker?.index) || 0)))
    : [Math.max(0, Math.min(maxIdx, Number(picker?.index) || 0)), (_v: any) => {}]) as [number, (n: number) => void];

  // render-synced ref（与 InputBar 同纪律）：useInput 回调永远读到最新 index
  const idxRef = R.useRef ? R.useRef(index) : { current: index };
  idxRef.current = index;
  if (R.useEffect) {
    R.useEffect(() => { idxRef.current = index; });
  }

  // hooks 必须无条件调用；ink 缺席（降级/测试桩）时自然无按键路由
  if (typeof useInput === 'function') {
    useInput((input: string, key: any) => {
      if (!key) return;
      if (key.leftArrow) {
        setIndex(Math.max(0, idxRef.current - 1));
        return;
      }
      if (key.rightArrow) {
        setIndex(Math.min(maxIdx, idxRef.current + 1));
        return;
      }
      if (key.return || key.enter) {
        onConfirm(idxRef.current);
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.ctrl && (input === 'c' || input === 'C')) {
        // 与 line 模式语义一致：Ctrl+C 关闭选择态（放行给全局中断链）
        onCancel();
      }
    });
  }

  if (!Box || !Text) {
    // 无 ink（理论上不会挂载到树）——纯文本兜底，仍不残留（调用方卸载即消失）
    return tiers.map((t, i) => (i === index ? `▲ ${t}` : `  ${t}`)).join(' | ');
  }

  const L = computeEffortSliderLayout({ tiers, index });
  const seg = (text: string, extra?: any) => R.createElement(Text, extra ? { ...extra } : {}, text);

  // 行 3：端标签（更快 ←→ 更强；更强=扩展方向，品红）
  const wFaster = '更快'.length * 2;
  const wSmarter = '更强'.length * 2;
  const padL = Math.max(0, L.trackStart - wFaster);
  const padM = Math.max(0, L.trackWidth - wFaster - wSmarter);
  const endLabelsRow = R.createElement(
    Box, { flexDirection: 'row' },
    seg(' '.repeat(padL), { dimColor: true }),
    seg('更快', { dimColor: true }),
    seg(' '.repeat(padM), { dimColor: true }),
    seg('更强', { color: 'magenta' }),
  );

  // 行 4：轨道线（─ dim · ┊ 扩展区边界 · ▲ 当前档列中心青色）
  const trackChars: string[] = new Array(Math.max(0, L.trackWidth)).fill('─');
  if (L.firstExt > 0) {
    const b = L.colStarts[L.firstExt] - 1;
    if (b >= 0 && b < trackChars.length) trackChars[b] = '┊';
  }
  const cur = tiers[index] || '';
  const sub = sublabels[index] || '';
  const trackRow = (() => {
    const cc = Math.max(0, Math.min(trackChars.length - 1, L.cursorCol));
    const lead = ' '.repeat(L.trackStart) + trackChars.slice(0, cc).join('');
    const tail = trackChars.slice(cc + 1).join('');
    return R.createElement(
      Box, { flexDirection: 'row' },
      seg(lead, { dimColor: true }),
      seg('▲', { color: 'cyan' }),
      seg(tail, { dimColor: true }),
    );
  })();

  // 行 5：档名行（当前档亮白、其余 dim、扩展档品红）
  const namesRow = R.createElement(
    Box, { flexDirection: 'row' },
    seg(' '.repeat(L.trackStart)),
    ...tiers.map((t, i) => {
      const cell = t + ' '.repeat(Math.max(0, L.colWidths[i] - t.length));
      const isExt = TIER_SLIDER_EXTENSIONS.has(t);
      if (i === index) return seg(cell, { bold: true });
      return seg(cell, isExt ? { color: 'magenta' } : { dimColor: true });
    }),
  );

  // 行 6：副标注（▲ <当前档> · <副标注>）
  const currentRow = R.createElement(
    Box, { flexDirection: 'row' },
    seg('▲ ', { color: 'cyan' }),
    seg(cur, { bold: true }),
    sub ? seg(` · ${sub}`, { dimColor: true }) : null,
  );

  return R.createElement(
    Box,
    { flexDirection: 'column', marginTop: 1, marginBottom: 1 },
    seg('思考强度', { bold: true }),
    seg(' '),
    endLabelsRow,
    trackRow,
    namesRow,
    currentRow,
    seg(' '),
    seg('←/→ 调节 · Enter 确认 · Esc 取消', { dimColor: true }),
  );
}
