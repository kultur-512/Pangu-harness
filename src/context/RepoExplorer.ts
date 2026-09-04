// RepoExplorer + Anchor Memory (GLM-5.x Strong Engineering Agent)
// 针对 GLM 长上下文优势进行激进探索和锚点选择
// 目标：让 GLM 能“记住”整个仓库的关键结构，最大化 pre-exploration 收益
// 在强力模式下探索更深、锚点更多，以支撑高强度工程任务。

import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, extname, basename, relative } from 'path';

export interface RepoMapEntry {
  path: string;
  type: 'file' | 'dir';
  importance: number;
  size?: number;
}

export interface AnchorFile {
  path: string;
  content: string;
  reason: string;
  lastUpdated: number;
  importance: number;
}

export class RepoExplorer {
  /**
   * GLM 强化版探索：
   * - 递归扫描（深度优先但带深度限制）
   * - 更激进的重要性打分
   * - 优先保留对 GLM 有帮助的“锚点”文件
   * - 特别照顾测试、入口、配置、核心逻辑
   */
  static async explore(workspaceRoot: string, options: {
    maxDepth?: number;
    maxFiles?: number;
    glmBias?: boolean;   // GLM 模式下更激进保留锚点
    tier?: string;       // 六档体系：根据档位调整策略
    taskStyle?: string;  // 任务风格：swe | terminal | automation
  } = {}): Promise<{
    repoMap: RepoMapEntry[];
    recommendedAnchors: string[];
    testCommand?: string;
    totalFilesScanned: number;
  }> {
    const {
      maxDepth = 6,
      maxFiles = 200,
      glmBias = true,
      tier = 'standard',
      taskStyle = 'swe',
    } = options;

    const repoMap: RepoMapEntry[] = [];
    const recommended: string[] = [];
    let testCommand = 'npm test';
    let totalFiles = 0;

    if (!existsSync(workspaceRoot)) {
      return { repoMap, recommendedAnchors: recommended, testCommand, totalFilesScanned: 0 };
    }

    const ignoreDirs = new Set([
      'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
      '__pycache__', '.venv', 'venv', 'target', 'out'
    ]);

    const importantExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h']);

    // Panshalach 六档体系：根据档位调整探索深度
    const tierAdjustedDepth = (() => {
      switch (tier) {
        case 'quick': return Math.min(maxDepth, 3);
        case 'standard': return Math.min(maxDepth, 4);
        case 'high': return Math.min(maxDepth, 5);
        case 'max': return Math.min(maxDepth, 6);
        case 'ex': return Math.min(maxDepth, 7);
        case 'pangu': return Math.min(maxDepth, 8);
        default: return maxDepth;
      }
    })();

    // 任务风格：不同风格有不同优先级
    const stylePriority = (filePath: string, base: string): number => {
      const lower = filePath.toLowerCase();
      if (taskStyle === 'terminal') {
        if (base === 'package.json') return 95;
        if (lower.includes('script') || lower.includes('cli') || lower.includes('bin')) return 90;
        if (lower.includes('test') || lower.includes('spec')) return 85;
        if (lower.includes('config') || lower.includes('rc') || base === 'tsconfig.json') return 70;
        return 30;
      }
      if (taskStyle === 'automation') {
        if (lower.includes('workflow') || lower.includes('automation') || lower.includes('pipeline')) return 95;
        if (lower.includes('api') || lower.includes('integration')) return 90;
        if (base === 'package.json') return 80;
        return 35;
      }
      // swe 默认
      if (base === 'package.json') return 95;
      if (lower.includes('/src/') && (base.includes('app') || base.includes('server') || base.includes('index'))) return 90;
      if (lower.includes('test') || lower.includes('spec')) return 88;
      return 40;
    };

    function scoreFile(filePath: string, content: string = ''): number {
      const lower = filePath.toLowerCase();
      const base = basename(filePath).toLowerCase();
      let score = 20;

      // 测试相关（GLM 验证非常依赖）
      if (lower.includes('test') || lower.includes('spec') || lower.includes('__tests__')) score = 98;
      if (base.startsWith('test') || base.includes('.test.') || base.includes('.spec.')) score = 97;

      // 关键配置
      if (base === 'package.json') score = 95;
      if (base === 'tsconfig.json' || base === 'pyproject.toml' || base === 'cargo.toml') score = 85;
      if (base === 'jest.config' || base.includes('vitest') || base.includes('pytest')) score = 80;

      // 入口与核心
      if (base === 'index.ts' || base === 'index.js' || base === 'main.ts' || base === 'main.py') score = 88;
      if (lower.includes('/src/') && (base.includes('app') || base.includes('server') || base.includes('index'))) score = 82;

      // 核心业务逻辑文件
      if (lower.includes('calculator') || lower.includes('core') || lower.includes('engine') || lower.includes('service')) {
        score = Math.max(score, 78);
      }

      // 任务风格优先级加权
      const styleBonus = stylePriority(filePath, base);
      score = Math.max(score, styleBonus);

      // 扩展名加分
      const ext = extname(filePath);
      if (importantExtensions.has(ext)) score += 8;

      // 文件大小适中加分（太大的文件 GLM 可能记不住）
      const size = content.length;
      if (size > 200 && size < 8000) score += 6;
      if (size > 15000) score -= 10; // 过大文件降权

      // GLM 偏置：额外奖励可能被反复读写的文件
      if (glmBias) {
        if (lower.includes('src') && !lower.includes('node_modules')) score += 5;
        if (lower.includes('lib')) score += 4;
      }

      return Math.min(100, Math.max(10, score));
    }

    function walk(dir: string, depth: number) {
      if (depth > tierAdjustedDepth || totalFiles > maxFiles) return;

      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (totalFiles > maxFiles) break;

        const full = join(dir, entry);
        if (ignoreDirs.has(entry)) continue;

        let stat;
        try { stat = statSync(full); } catch { continue; }

        const relPath = relative(workspaceRoot, full);

        if (stat.isDirectory()) {
          repoMap.push({ path: relPath, type: 'dir', importance: 15 });
          walk(full, depth + 1);
        } else {
          totalFiles++;
          let content = '';
          try {
            // 只读小文件用于打分
            if (stat.size < 20000) {
              content = readFileSync(full, 'utf8');
            }
          } catch {}

          const importance = scoreFile(relPath, content);
          repoMap.push({ path: relPath, type: 'file', importance, size: stat.size });

          if (importance >= 75) {
            recommended.push(relPath);
          }

          // 提取测试命令
          if (basename(full).toLowerCase() === 'package.json') {
            try {
              const pkg = JSON.parse(content || readFileSync(full, 'utf8'));
              if (pkg.scripts?.test) testCommand = 'npm test';
              if (pkg.scripts?.['test:unit']) testCommand = 'npm run test:unit';
            } catch {}
          }
        }
      }
    }

    walk(workspaceRoot, 0);

    // GLM 模式下强制多保留几个关键锚点
    if (glmBias && recommended.length < 6) {
      const mustHave = ['package.json', 'src', 'tsconfig.json', 'README.md'];
      for (const m of mustHave) {
        if (!recommended.includes(m) && existsSync(join(workspaceRoot, m))) {
          recommended.push(m);
        }
      }
    }

    if (recommended.length === 0) {
      recommended.push('package.json', 'src');
    }

    // Panshalach 六档体系：按档位决定推荐的锚点数量
    const tierMaxAnchors = (() => {
      switch (tier) {
        case 'quick': return 4;
        case 'standard': return 6;
        case 'high': return 8;
        case 'max': return 10;
        case 'ex': return 12;
        case 'pangu': return 15;
        default: return glmBias ? 12 : 8;
      }
    })();

    return {
      repoMap: repoMap.sort((a, b) => b.importance - a.importance),
      recommendedAnchors: [...new Set(recommended)].slice(0, tierMaxAnchors),
      testCommand,
      totalFilesScanned: totalFiles,
    };
  }
}

export class AnchorMemory {
  private anchors = new Map<string, AnchorFile>();

  add(path: string, content: string, reason: string, importance = 80) {
    this.anchors.set(path, {
      path,
      content,
      reason,
      lastUpdated: Date.now(),
      importance,
    });
  }

  get(path: string): AnchorFile | undefined {
    return this.anchors.get(path);
  }

  getAll(): AnchorFile[] {
    return Array.from(this.anchors.values()).sort((a, b) => b.importance - a.importance);
  }

  toPromptContext(maxChars = 25000): string {
    const anchors = this.getAll();
    if (anchors.length === 0) return '';

    let out = '【高优先级锚点文件 - 整个任务必须始终记住】\n';
    let used = 0;
    for (const a of anchors) {
      const block = `\n=== ${a.path} (${a.reason}) ===\n${a.content.slice(0, 6000)}\n`;
      if (used + block.length > maxChars) break;
      out += block;
      used += block.length;
    }
    return out;
  }
}

