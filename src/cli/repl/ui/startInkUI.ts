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
    const appMod: any = await import('./ZorgeApp.js');
    const ZorgeApp = appMod && (appMod.ZorgeApp || appMod.default);

    // Stash runtime React & ink so ZorgeApp can pick them up without top-level imports
    (globalThis as any).__ZORGE_INK__ = ink;
    (globalThis as any).__ZORGE_INK_REACT__ = React;

    // Pass the bridge down. ZorgeApp is responsible for useReducer + layout.
    render(
      React.createElement(ZorgeApp, {
        bridge,
        initialSession: {
          tier: session.tier,
          model: session.model || 'default',
          workspace: session.workspace || process.cwd(),
        },
      })
    );

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
