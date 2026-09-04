// src/cli/repl/providerPrefetch.ts
// fix-rich-local-cmds (②A): startup background prefetch of provider model
// lists. Reads the project .panshalach.json, and for every provider whose `models`
// array is empty, fetches the remote model list and writes it BACK into the
// same file — PRESERVING all existing fields (apiKey/baseUrl/type/modelContexts
// etc.). Offline/slow endpoints are skipped silently (retried next launch).
// The rich /model picker then reads models purely locally (no per-keypress
// network wait).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProviderRegistry } from '../../model/ProviderRegistry.js';

const FETCH_TIMEOUT_MS = 10_000;

/** Per-provider fetch with a hard timeout (never hangs startup). */
async function listModelsTimed(reg: ProviderRegistry, name: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), FETCH_TIMEOUT_MS);
    timer.unref(); // M2.0: non-deadline guard — never holds the process
    reg.listModels(name)
      .then((m) => { clearTimeout(timer); resolve(m && m.length ? m : null); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}

/**
 * Fire-and-forget: fill empty provider `models` arrays in .panshalach.json from the
 * remote /models endpoint, preserving every other field. Returns true when the
 * file was updated. Never throws.
 */
export async function prefetchProviderModels(workspace: string): Promise<boolean> {
  const cfgPath = path.join(workspace || process.cwd(), '.panshalach.json');
  if (!fs.existsSync(cfgPath)) return false;

  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch {
    return false; // malformed config — skip silently
  }

  const providers = cfg?.providers;
  if (!providers || typeof providers !== 'object') return false;

  const names = Object.keys(providers).filter((n) => {
    const p = providers[n];
    return p && typeof p === 'object' && Array.isArray(p.models) && p.models.length === 0;
  });
  if (names.length === 0) return false;

  let reg: ProviderRegistry | null = null;
  try { reg = new ProviderRegistry(cfg); } catch { return false; }

  let changed = false;
  await Promise.allSettled(names.map(async (name) => {
    if (!reg) return;
    try {
      const models = await listModelsTimed(reg, name);
      if (models && models.length > 0) {
        providers[name].models = models; // keep apiKey/baseUrl/type/modelContexts intact
        changed = true;
      }
    } catch {}
  }));

  if (!changed) return false;
  try {
    // S5: write-back must be atomic (tmp → rename) and merge over a fresh
    // re-read of the file — the config may have been edited concurrently
    // (e.g. the user saved a new key while the prefetch was in flight).
    // Never clobber concurrent edits, never leave a torn file on crash.
    const merged = mergeCurrentConfig(cfgPath, cfg);
    if (!merged) return false;
    const dir = path.dirname(cfgPath);
    const tmp = path.join(dir, `.panshalach.json.tmp-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    try {
      fs.renameSync(tmp, cfgPath);
    } catch (e: any) {
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * S5: merge the prefetch result over the CURRENT file content. The in-memory
 * `cfg` may be stale (concurrent edit during the fetch); re-read and take the
 * provider `models` arrays from our fetch only where the on-disk provider
 * still exists, preserving every other on-disk field. Returns null on any
 * read/parse failure (caller skips the write — never destroy user data).
 */
function mergeCurrentConfig(cfgPath: string, fetched: any): any | null {
  let current: any;
  try {
    current = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch {
    return null; // file changed/malformed mid-flight — skip the write entirely
  }
  if (!current || typeof current !== 'object') return null;
  if (!current.providers || typeof current.providers !== 'object') return null;
  const fetchedProviders = fetched?.providers ?? {};
  for (const name of Object.keys(fetchedProviders)) {
    const onDisk = current.providers[name];
    if (onDisk && typeof onDisk === 'object' && Array.isArray(fetchedProviders[name]?.models)) {
      // Keep the on-disk provider's own fields; adopt only the fetched models.
      onDisk.models = fetchedProviders[name].models;
    }
  }
  return current;
}
