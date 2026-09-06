// src/cli/repl/FeatureTracker.ts
// feature_list.json is a harness primitive — the active feature
// and its evidence live in a state FILE, not the chat history.
//
// Rules (harness-creator):
//  - one ACTIVE feature at a time (unless explicit multi-agent boundaries)
//  - marking 'done' REQUIRES evidence
//  - append/update the state file; never depend on conversation

import fs from 'node:fs';
import path from 'node:path';

export type FeatureStatus = 'planned' | 'in-progress' | 'done' | 'blocked';

export interface FeatureItem {
  id: string;
  title: string;
  status: FeatureStatus;
  evidence?: string;   // REQUIRED to mark done
  nextStep?: string;
  updatedAt: number;
}

export interface FeatureList {
  version: 1;
  items: FeatureItem[];
}

export function featureListPath(workspace: string): string {
  return path.join(workspace || process.cwd(), '.panshalach', 'feature_list.json');
}

/** Read the feature list; returns [] when missing/corrupt (never throws). */
export function loadFeatures(workspace: string): FeatureItem[] {
  try {
    const raw = fs.readFileSync(featureListPath(workspace), 'utf-8');
    const parsed = JSON.parse(raw) as FeatureList;
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

/** Write the feature list (creates .panshalach/). Returns true on success. */
export function saveFeatures(workspace: string, items: FeatureItem[]): boolean {
  try {
    const dir = path.dirname(featureListPath(workspace));
    fs.mkdirSync(dir, { recursive: true });
    const list: FeatureList = { version: 1, items };
    fs.writeFileSync(featureListPath(workspace), JSON.stringify(list, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** The single active (in-progress) feature, or null. */
export function activeFeature(items: FeatureItem[]): FeatureItem | null {
  return items.find((f) => f.status === 'in-progress') ?? null;
}

/** Add a new feature; demotes any current in-progress to planned (one active). */
export function addFeature(workspace: string, title: string): FeatureItem | null {
  const items = loadFeatures(workspace);
  for (const f of items) {
    if (f.status === 'in-progress') f.status = 'planned';
  }
  const item: FeatureItem = {
    id: `feature-${items.length + 1}`,
    title,
    status: 'in-progress',
    updatedAt: Date.now(),
  };
  items.push(item);
  if (!saveFeatures(workspace, items)) return null;
  return item;
}

/** Mark done — evidence is REQUIRED. Returns error string or null on success.
 *  C3（ROADMAP-NEXT §3.2）：检查 save 返回值——写失败必须告警，不得静默成功。 */
export function markFeatureDone(workspace: string, id: string, evidence: string): string | null {
  const items = loadFeatures(workspace);
  const f = items.find((x) => x.id === id);
  if (!f) return `未找到特性: ${id}`;
  if (!evidence || !evidence.trim()) return 'evidence 必填（完成证据：测试名/验证输出摘要）';
  f.status = 'done';
  f.evidence = evidence.trim();
  f.updatedAt = Date.now();
  if (!saveFeatures(workspace, items)) {
    return `✗ 警告：特性 ${id} 的 done 状态写入 feature_list.json 失败（磁盘/权限错误）——未持久化，不得视为已完成`;
  }
  return null;
}

/** Set the next step for a feature (also implies it is the active one).
 *  C3：同 markFeatureDone —— save 失败不静默成功。 */
export function setFeatureNext(workspace: string, id: string, nextStep: string): string | null {
  const items = loadFeatures(workspace);
  const f = items.find((x) => x.id === id);
  if (!f) return `未找到特性: ${id}`;
  for (const other of items) {
    if (other.id !== id && other.status === 'in-progress') other.status = 'planned';
  }
  f.status = 'in-progress';
  f.nextStep = nextStep || f.nextStep;
  f.updatedAt = Date.now();
  if (!saveFeatures(workspace, items)) {
    return `✗ 警告：特性 ${id} 的 nextStep 写入 feature_list.json 失败（磁盘/权限错误）——未持久化`;
  }
  return null;
}
