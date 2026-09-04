// src/cli/repl/ConfigManager.ts
// Simple config manager for ZIS (project + user level)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { PanshalachConfig, ProviderConfig } from './types.js';
import type { Tier } from '../../tiers/TierConfig.js';

const USER_CONFIG_DIR = join(homedir(), '.panshalach');
const USER_CONFIG_PATH = join(USER_CONFIG_DIR, 'config.json');

/**
 * 深度合并
 * - 嵌套对象递归合并
 * - 数组：替换（不 concat）
 * - 后者覆盖前者（undefined 不覆盖）
 */
export function deepMerge<T>(base: T, override: T): T {
  if (override === undefined || override === null) return base;
  if (base === undefined || base === null) return override as T;

  // 数组类型：替换
  if (Array.isArray(override)) {
    return override as any;
  }

  // 对象类型：深度合并
  if (typeof override === 'object' && typeof base === 'object' && !Array.isArray(base)) {
    const result: any = { ...(base as any) };
    for (const key of Object.keys(override as any)) {
      const ov = (override as any)[key];
      if (ov !== undefined) {
        result[key] = deepMerge((base as any)[key], ov);
      }
    }
    return result;
  }

  // 其他（primitive / 数组已在上面处理）：override 胜出
  return override as T;
}

export class ConfigManager {
  private config: PanshalachConfig = {};

  constructor(private workspaceRoot: string = process.cwd()) {
    this.load();
  }

  private load() {
    this.config = {};

    // 加载顺序：项目级 .panshalach.json → 用户级 ~/.panshalach/config.json → CLI 参数（CLI 由调用方在 getAll 后叠加）
    const projectPath = join(this.workspaceRoot, '.panshalach.json');
    this.mergeProjectConfig(projectPath);

    if (existsSync(USER_CONFIG_PATH)) {
      try {
        const user = JSON.parse(readFileSync(USER_CONFIG_PATH, 'utf-8'));
        this.config = deepMerge(this.config, user);
      } catch {}
    }
  }

  /**
   * v2 新增：显式合并项目级配置（深度合并）
   * 缺失文件或解析失败时静默跳过（不报错）
   */
  mergeProjectConfig(projectPath: string): void {
    if (!projectPath || !existsSync(projectPath)) return;
    try {
      let text = readFileSync(projectPath, 'utf-8');
      // Strip UTF-8 BOM if present (very common when users save JSON from editors)
      if (text.charCodeAt(0) === 0xFEFF) {
        text = text.slice(1);
      }
      // Also trim any leading/trailing whitespace that could break JSON.parse
      text = text.trim();
      const proj = JSON.parse(text);
      this.config = deepMerge(this.config, proj);
    } catch {
      // 静默：缺失或损坏的项目配置不应中断启动
    }
  }

  get<K extends keyof PanshalachConfig>(key: K): PanshalachConfig[K] {
    return this.config[key];
  }

  set<K extends keyof PanshalachConfig>(key: K, value: PanshalachConfig[K]) {
    (this.config as any)[key] = value;
  }

  save() {
    // Save to user config for simplicity
    if (!existsSync(USER_CONFIG_DIR)) {
      mkdirSync(USER_CONFIG_DIR, { recursive: true });
    }
    writeFileSync(USER_CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  getAll(): PanshalachConfig {
    return { ...this.config };
  }
}
