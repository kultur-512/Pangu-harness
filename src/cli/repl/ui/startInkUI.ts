// src/cli/repl/ui/startInkUI.ts
// THE critical downgrade gate for Path B (ink).
// Rules (non-negotiable):
// - Only dynamic imports of ink + react.
// - Silent return { started: false } on any failure or insufficient TTY/caps.
// - Never prints warnings when falling back.
// - Only activates when TTY + rich capabilities are present.

import type { Session } from '../Session.js';
import type { OutputRenderer } from '../types.js';
import type { InkStartResult, UiBridge } from '../types.js';

export async function tryStartInkUI(
  session: Session,
  renderer: OutputRenderer,
  replContext: any
): Promise<InkStartResult> {
  // 1. Basic TTY check
  const isTTY =
    typeof process !== 'undefined' &&
    !!process.stdout &&
    !!process.stdout.isTTY &&
    !!process.stdin &&
    !!process.stdin.isTTY;

  if (!isTTY) {
    return { started: false };
  }

  // 2. Capability check (reuse existing detection)
  let caps: { multiline?: boolean; color?: boolean } = {};
  try {
    const { getTerminalCapabilities } = await import('../TerminalCapabilities.js');
    caps = getTerminalCapabilities();
  } catch {
    // If we can't even read capabilities, be conservative and fall back.
    return { started: false };
  }

  // We require at least multiline capability for a good bottom-bar experience.
  // You can relax this later if you want ink on weaker TTYs.
  if (!caps.multiline) {
    return { started: false };
  }

  // 3. Dynamic import of ink + react (this is the only place they are imported)
  let ink: any;
  let React: any;

  try {
    // Use 'as any' to avoid hard module resolution errors when ink/react are not installed
    // (they are optionalDependencies).
    // @ts-ignore - optional at runtime
    const inkMod = await import('ink' as any);
    ink = inkMod && (inkMod.default || inkMod);

    // @ts-ignore - optional at runtime
    const reactMod = await import('react' as any);
    React = reactMod && (reactMod.default || reactMod);
  } catch {
    // Any failure (not installed, resolution error, etc.) → silent fallback
    return { started: false };
  }

  // 4. Create bridge (lightweight event adapter between engine and UI)
  let bridge: UiBridge | null = null;
  try {
    const bridgeMod = await import('./bridge.js');
    bridge = bridgeMod.createBridge(session, renderer, replContext);
  } catch {
    // Bridge creation failure → fall back silently
    return { started: false };
  }

  if (!bridge) {
    return { started: false };
  }

  // 5. Render the root app
  try {
    const { render } = ink;

    // Dynamically import the root app (TSX). We do this after we already have React at runtime.
    const appMod: any = await import('./PanshaApp.js');
    const PanshaApp = appMod && (appMod.PanshaApp || appMod.default);

    // Stash runtime React & ink so PanshaApp can pick them up without top-level imports
    (globalThis as any).__PANSHA_INK__ = ink;
    (globalThis as any).__PANSHA_INK_REACT__ = React;

    // Pass the bridge down. PanshaApp is responsible for useReducer + layout.
    // Ctrl+C（真机实测缺陷）：exitOnCtrlC 默认 true 时任务运行中按 Ctrl+C 会
    // 直接卸载整个 ink UI → 进程随之退出（回 PowerShell）。改为组件层接管：
    // PanshaApp 全局 useInput 收 Ctrl+C → bridge.handleCtrlC（宿主接线）——
    // 任务运行中 = 中断当前任务（AbortSignal → stopReason='aborted' 收尾落盘），
    // 空闲 = 二次确认退出（与 line 模式 handleSigint 同语义）。
    const inkInstance = render(
      React.createElement(PanshaApp, {
        bridge,
        initialSession: {
          tier: session.tier,
          model: session.model || 'default',
          workspace: session.workspace || process.cwd(),
        },
      }),
      { exitOnCtrlC: false }
    );

    // /exit 干净退出缝：保存 render instance——卸载时 ink 会还原终端状态
    // （alternate screen / raw mode），避免退出后终端残留错乱。
    try {
      (globalThis as any).__PANSHA_INK_INSTANCE__ = inkInstance;
      (replContext as any).__inkInstance = inkInstance;
    } catch {}

    // Expose bridge back to the Repl instance for rich event forwarding
    try {
      (replContext as any).inkBridge = bridge;
      (replContext as any)._inkBridge = bridge;
    } catch {}

    // Optional: tell the renderer that a feed sink is active
    if (typeof (renderer as any).setFeedSink === 'function') {
      (renderer as any).setFeedSink((item: any) => {
        try {
          bridge.pushFeed(item);
        } catch {}
      });
    }

    return { started: true };
  } catch {
    // Any render-time failure → silent fallback
    return { started: false };
  }
}
