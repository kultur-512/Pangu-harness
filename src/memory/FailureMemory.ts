// FailureMemory - 会话内失败信号记忆
// 针对结构化模型的常见弱点进行记忆和反注入（建设性、工程化口吻）
// 支持多任务风格（swe / terminal / automation），用于日常高强度工程任务。

export type FailureCategory =
  | 'HALLUCINATED_FILE'
  | 'HALLUCINATED_FUNCTION'
  | 'HALLUCINATED_BEHAVIOR'
  | 'TOOL_FORMAT_ERROR'
  | 'LOOSE_FORMAT_USED'
  | 'READ_BEFORE_WRITE_VIOLATION'   // 工程纪律规则核心
  | 'WEAK_VERIFICATION'
  | 'NO_VERIFICATION_BEFORE_CLAIM'
  | 'OVERCONFIDENCE'
  | 'SKIPPED_PLAN'
  | 'SKIPPED_READ'
  | 'CONTEXT_LOSS'
  | 'BAD_CRITIQUE'
  // === 多任务风格新增失败类别 ===
  | 'COMMAND_FAILED'                  // Terminal 风格: 命令执行失败但未正确处理
  | 'STATE_MISMATCH'                  // Terminal / Automation: 预期状态与实际不符
  | 'WORKFLOW_STEP_ERROR'             // Automation 风格: 工作流某步失败
  | 'DATA_TRANSFORM_ERROR'            // Automation 风格: 数据转换/映射错误
  | 'TERMINAL_NO_CHECK_AFTER_COMMAND' // Terminal 风格: 关键命令后未检查输出/状态
  | 'AUTOMATION_NO_EFFECT_VERIFICATION' // Automation 风格: 执行动作后未验证业务效果
  | 'OTHER';

export class FailureMemory {
  private memory = new Map<FailureCategory, string[]>();
  private maxPerCategory = 8;           // 更强的记忆容量

  // 高权重失败类别（这些失败需要重点关注）
  private highWeightCategories: FailureCategory[] = [
    'TOOL_FORMAT_ERROR',
    'LOOSE_FORMAT_USED',
    'READ_BEFORE_WRITE_VIOLATION',   // 新增：工程纪律规则核心
    'HALLUCINATED_FILE',
    'WEAK_VERIFICATION',
    'NO_VERIFICATION_BEFORE_CLAIM',
  ];

  record(category: FailureCategory, description: string, weight: number = 1) {
    if (!this.memory.has(category)) this.memory.set(category, []);
    const arr = this.memory.get(category)!;

    // 高权重类别重复记忆更久
    const effectiveDesc = this.highWeightCategories.includes(category)
      ? `[HIGH] ${description}`
      : description;

    arr.push(effectiveDesc);
    if (arr.length > this.maxPerCategory) arr.shift();
  }

  getRelevant(currentContext: string): string[] {
    const results: string[] = [];
    const lower = currentContext.toLowerCase();

    for (const [cat, items] of this.memory.entries()) {
      const isRelevant =
        lower.includes(cat.toLowerCase().replace(/_/g, ' ')) ||
        lower.includes('error') ||
        lower.includes('fail') ||
        lower.includes('格式') ||
        lower.includes('幻觉') ||
        lower.includes('验证');

      if (isRelevant) {
        // 高权重类别多取一点
        const take = this.highWeightCategories.includes(cat) ? 3 : 2;
        results.push(...items.slice(-take));
      }
    }
    return results;
  }

  /**
   * 极致版本的 prompt 注入
   * 高权重失败模式提示
   */
  toPromptInjection(): string {
    if (this.memory.size === 0) return '';

    // P0-3 修复：软化惩罚性语言
    // 旧措辞："致命失败记忆"、"100% 避免"、"强制要求"等会加重模型负担，违背建设性原则
    // 新措辞：建设性、工程化口吻，强调"重要教训 / 建议重点避免"
    let out = '\n【历史任务的重要教训】\n';
    out += '以下是从历史项目经验中提炼的建议，请在本次任务中留意：\n';

    for (const cat of this.highWeightCategories) {
      const items = this.memory.get(cat);
      if (items && items.length > 0) {
        out += `\n【${cat}】（建议重点关注）：\n`;
        items.slice(-3).forEach(item => (out += `  - ${item}\n`));
      }
    }

    // 其他类别也注入，但权重低一些
    for (const [cat, items] of this.memory.entries()) {
      if (this.highWeightCategories.includes(cat)) continue;
      if (items.length > 0) {
        out += `\n${cat}:\n`;
        items.slice(-2).forEach(item => (out += `  - ${item}\n`));
      }
    }

    out += '\n以上是历史经验中的注意事项，可作为质量参考。\n';
    return out;
  }

  /**
   * 自动失败信号提取
   */
  autoExtractFromTrajectory(steps: any[]): void {
    for (const step of steps) {
      const result = (step.result || '').toLowerCase();
      const critique = (step.critique || '').toLowerCase();
      const reasoning = (step.reasoning?.thinking || step.thought || '').toLowerCase();
      const toolCalls = step.toolCalls || step.action || [];

      // === 格式类===
      if (critique.includes('格式') || critique.includes('loose') || critique.includes('invoke tool')) {
        this.record('TOOL_FORMAT_ERROR', '工具调用格式不标准（未使用严格 <> 格式）');
      }

      // 检测到松散格式
      if (toolCalls.length > 0) {
        const hasLoose = toolCalls.some((t: any) =>
          (t.format && String(t.format).includes('loose')) ||
          (t.rawBlock && /read\(|write\(|bash\(/i.test(String(t.rawBlock)))
        );
        if (hasLoose) {
          this.record('LOOSE_FORMAT_USED', '本次使用了松散格式（Read(file_path=...) 等），而非标准 <> 格式');
        }
      }

      // === 幻觉类 ===
      if (result.includes('no such file') || result.includes('not found') ||
          critique.includes('幻觉') || critique.includes('不存在') || critique.includes('编造')) {
        this.record('HALLUCINATED_FILE', '引用了不存在的文件或路径');
      }
      if (critique.includes('函数') && (critique.includes('不存在') || critique.includes('幻觉'))) {
        this.record('HALLUCINATED_FUNCTION', '引用了不存在的函数或方法');
      }

      // === 验证类===
      if ((critique.includes('验证') || critique.includes('verify')) &&
          (result.includes('fail') || critique.includes('没有验证') || critique.includes('未验证'))) {
        this.record('WEAK_VERIFICATION', '在没有充分验证的情况下就认为问题已解决');
      }
      if (critique.includes('宣称') && (critique.includes('成功') || critique.includes('完成')) &&
          !result.includes('pass') && !result.includes('all_tests_passed')) {
        this.record('NO_VERIFICATION_BEFORE_CLAIM', '在实际验证通过前就宣称任务完成');
      }

      // === 计划与执行脱节 ===
      if (critique.includes('跳过') || critique.includes('直接写') || critique.includes('没读')) {
        this.record('SKIPPED_PLAN', '跳过了计划的步骤（尤其是 Read/验证 步骤）');
      }
      if (critique.includes('没读') || reasoning.includes('没读文件') || reasoning.includes('直接修改')) {
        this.record('SKIPPED_READ', '没有先读取文件就直接进行修改');
      }

      // === 自我批评质量 ===
      if (critique && critique.length < 80 && step.stepNumber > 2) {
        this.record('BAD_CRITIQUE', '自我批评过于简短敷衍');
      }

      // === 过度自信 ===
      if (critique.includes('过度自信') || critique.includes('太确定') || critique.includes('没证据')) {
        this.record('OVERCONFIDENCE', '在证据不足时过度自信');
      }
    }
  }

  /**
   * 把记忆注入到任意 prompt（高纪律模式下每轮调用）
   */
  injectIntoPrompt(basePrompt: string): string {
    const injection = this.toPromptInjection();
    if (!injection) return basePrompt;
    return basePrompt + '\n' + injection;
  }

  clear() {
    this.memory.clear();
  }

  /**
   * 返回当前记忆的卡片总数（用于 UI/确认面板展示）。
   */
  getCardCount(): number {
    let n = 0;
    for (const arr of this.memory.values()) n += arr.length;
    return n;
  }
}

export class GenerativeTestEngine {
  /**
   * Ask model to generate targeted tests for the current change.
   */
  static async generateTests(modelClient: any, changeDescription: string, context: string): Promise<string[]> {
    const prompt = `作为顶级测试工程师，请为以下修改生成 1-3 个高质量、针对性强的测试用例。

修改描述：
${changeDescription}

相关代码上下文：
${context.slice(0, 6000)}

要求：
- 测试必须能真正发现 bug
- 优先边界条件和异常情况
- 只输出测试代码，使用三个反引号包裹（例如 \`\`\` ... \`\`\`）

请生成：`;

    const raw = await modelClient.complete(prompt);
    return raw
      .split('```')
      .filter((_: string, i: number) => i % 2 === 1)
      .map((s: string) => s.trim())
      .slice(0, 3);
  }

  static async runSelfTests(testCodes: string[], verificationEngine: any): Promise<{ passed: boolean; details: string }> {
    for (const test of testCodes) {
      const result = await verificationEngine.runInlineTest?.(test) ?? { passed: false, output: 'no executor' };
      if (!result.passed) {
        return { passed: false, details: result.output || 'Test failed' };
      }
    }
    return { passed: true, details: 'All generated tests passed' };
  }
}

