// src/cli/repl/EnvContext.ts
// incremental environment
// context — only CHANGED fields (cwd / git branch / changed files) are
// injected into the prompt; unchanged runs emit nothing (token savings).
// Git-unavailable environments degrade to cwd-only.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface EnvSnapshot {
  cwd: string;
  branch?: string;
  fs?: string[];
}

export interface EnvDelta {
  cwd?: string;
  branch?: string;
  fs?: string[];
  unchanged: boolean;
}

/** Snapshot the environment: cwd + git branch + git status file summary (≤20). */
export function snapshotEnv(workspace: string): EnvSnapshot {
  const cwd = workspace || process.cwd();
  const snap: EnvSnapshot = { cwd };
  try {
    snap.branch = execFileSync('git', ['branch', '--show-current'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    }).trim() || undefined;
  } catch {}
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    });
    const files = status.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => l.slice(3)) // strip XY status codes
      .slice(0, 20);
    if (files.length > 0) snap.fs = files;
  } catch {}
  return snap;
}

/** Diff prev vs now; only present fields are changed. unchanged=true when identical. */
export function buildEnvDelta(prev: EnvSnapshot | null, now: EnvSnapshot): EnvDelta {
  const d: EnvDelta = { unchanged: false };
  if (!prev) {
    // first snapshot: report cwd only (baseline; avoid flooding on first turn)
    d.cwd = now.cwd;
    return d;
  }
  let changed = false;
  if (prev.cwd !== now.cwd) { d.cwd = now.cwd; changed = true; }
  if (prev.branch !== now.branch) { d.branch = now.branch; changed = true; }
  const prevFs = (prev.fs ?? []).join('\n');
  const nowFs = (now.fs ?? []).join('\n');
  if (prevFs !== nowFs) { d.fs = now.fs ?? []; changed = true; }
  d.unchanged = !changed;
  return d;
}

/** Render a delta as the injection block (empty when unchanged). */
export function renderEnvDelta(d: EnvDelta): string {
  if (d.unchanged) return '';
  const parts: string[] = [];
  if (d.cwd !== undefined) parts.push(`cwd: ${d.cwd}`);
  if (d.branch !== undefined) parts.push(`branch: ${d.branch}`);
  if (d.fs !== undefined && d.fs.length > 0) parts.push(`changed: ${d.fs.join(', ')}`);
  return parts.length ? `\n【环境变更】\n${parts.join('\n')}` : '';
}

// ==================== A-T12 (L02): environment self-description ====================
// describeEnvironment probes the workspace runtime (Node/platform/arch, package
// manager, deps, verification commands, lockfiles) and renders a stable
// self-description — the Environment subsystem primitive.

export interface EnvSelfDescription {
  runtime: { node: string; platform: string; arch: string };
  packageManager: string;
  deps: Array<{ name: string; version: string }>;
  devDeps: Array<{ name: string; version: string }>;
  verification: string[];
  lockfiles: string[];
}

/** Probe the workspace: package.json deps + lockfiles + verification scripts. */
export function describeEnvironment(workspace: string): EnvSelfDescription {
  const ws = workspace || process.cwd();
  let pkg: any = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf-8'));
  } catch {}
  const scripts = pkg?.scripts ?? {};
  const probeScript = (names: string[]): string | null => {
    for (const n of names) if (typeof scripts[n] === 'string' && scripts[n].trim()) return scripts[n];
    return null;
  };
  const toList = (obj: any, cap: number) => Object.entries(obj ?? {})
    .slice(0, cap)
    .map(([name, version]) => ({ name, version: String(version) }));
  const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']
    .filter((f) => fs.existsSync(path.join(ws, f)));
  const verification = [
    probeScript(['test', 'test:unit']),
    probeScript(['build']),
    probeScript(['lint', 'typecheck', 'tsc']),
  ].filter(Boolean) as string[];
  return {
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    packageManager: pkg?.packageManager ?? (lockfiles.includes('pnpm-lock.yaml') ? 'pnpm' : lockfiles.includes('yarn.lock') ? 'yarn' : lockfiles.includes('bun.lock') || lockfiles.includes('bun.lockb') ? 'bun' : lockfiles.length > 0 ? 'npm' : '未知'),
    deps: toList(pkg?.dependencies, 15),
    devDeps: toList(pkg?.devDependencies, 10),
    verification,
    lockfiles,
  };
}

/** Render the self-description as a compact ENV.md block. */
export function renderEnvSelfDescription(desc: EnvSelfDescription): string {
  const lines: string[] = [];
  lines.push('# Environment Self-Description (A-T12)');
  lines.push('');
  lines.push(`Node ${desc.runtime.node} · ${desc.runtime.platform}/${desc.runtime.arch} · packageManager: ${desc.packageManager}`);
  if (desc.lockfiles.length > 0) lines.push(`lockfiles: ${desc.lockfiles.join(', ')}`);
  if (desc.deps.length > 0) lines.push(`dependencies: ${desc.deps.map((d) => `${d.name}@${d.version}`).join(', ')}`);
  if (desc.devDeps.length > 0) lines.push(`devDependencies: ${desc.devDeps.map((d) => `${d.name}@${d.version}`).join(', ')}`);
  if (desc.verification.length > 0) lines.push(`verification: ${desc.verification.join(' | ')}`);
  return lines.join('\n') + '\n';
}

/** ≤10-line summary for PromptBuilder injection (first 10 lines after title). */
export function renderEnvSummary(desc: EnvSelfDescription, maxLines = 10): string {
  const full = renderEnvSelfDescription(desc).split('\n');
  const keep = full.slice(0, maxLines);
  if (full.length > maxLines) keep.push('…（详见 .panshalach/ENV.md）');
  return keep.join('\n');
}
