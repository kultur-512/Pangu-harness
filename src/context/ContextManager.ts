// 1M Context + Anchor Manager (30-Round Extreme Polished)
// Designed for maximum signal retention under large context windows (GLM-5.3 1M advantage)

export interface AnchorEntry {
  path: string;
  content: string;
  priority: number;
  version: number;
}

export class ContextManager {
  private anchors = new Map<string, AnchorEntry>();
  private history: Array<{ text: string; importance: number; timestamp: number }> = [];
  private tokenBudget: number;

  constructor(tokenBudgetApprox = 180_000) {
    this.tokenBudget = tokenBudgetApprox;
  }

  registerAnchor(path: string, content: string, priority = 100) {
    const existing = this.anchors.get(path);
    const version = existing ? existing.version + 1 : 1;
    this.anchors.set(path, { path, content, priority, version });
  }

  addHistory(entry: string, importance = 50) {
    this.history.push({ text: entry, importance, timestamp: Date.now() });
    // Keep only highest importance recent entries
    this.history.sort((a, b) => b.importance - a.importance);
    if (this.history.length > 40) this.history.length = 40;
  }

  /**
   * Build final context for the model, respecting token budget approximately.
   * Prioritizes anchors > high-importance history > recent critique.
   */
  buildContext(): string {
    let out = '';
    let currentChars = 0;

    // 1. Anchors (highest priority)
    const sortedAnchors = Array.from(this.anchors.values())
      .sort((a, b) => b.priority - a.priority);

    for (const a of sortedAnchors) {
      const block = `\n=== ANCHOR [v${a.version}]: ${a.path} ===\n${a.content.slice(0, 10000)}\n`;
      if (currentChars + block.length > this.tokenBudget * 4) break; // rough char→token
      out += block;
      currentChars += block.length;
    }

    // 2. High importance recent history + critiques
    const recent = this.history
      .slice(0, 15)
      .map(h => h.text)
      .join('\n---\n');

    const histBlock = `\n=== RECENT CRITICAL HISTORY ===\n${recent}\n`;
    if (currentChars + histBlock.length < this.tokenBudget * 4) {
      out += histBlock;
    }

    return out;
  }

  getAnchorCount(): number {
    return this.anchors.size;
  }

  /**
   * 长上下文分层提示：把锚点内容格式化为可注入的字符串
   * 优先级排序：priority desc + content length 控制
   */
  toPromptContext(maxChars: number = 25000): string {
    if (this.anchors.size === 0) return '';
    const sorted = Array.from(this.anchors.values()).sort((a, b) => b.priority - a.priority);
    let out = '【高优先级锚点文件 - 整个任务必须始终记住】\n';
    let used = 0;
    for (const a of sorted) {
      const block = `\n=== ${a.path} (priority: ${a.priority}) ===\n${a.content.slice(0, 6000)}\n`;
      if (used + block.length > maxChars) break;
      out += block;
      used += block.length;
    }
    return out;
  }
}

