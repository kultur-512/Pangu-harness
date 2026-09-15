// StructuredReasoner - 结构化推理协议
// 核心目的：强化模型的工程思维能力（分析、规划、验证、纪律）。
// - 高纪律模式（非实用）：高结构、高纪律，适合日常高强度、复杂、关键的编码任务。
// - 实用模式：更简洁温和，控制 token，适合常规日常开发。
// 支持多任务风格（代码、终端、自动化），目的是覆盖真实工作场景，而非功利刷 benchmark。
// 自我批评保持建设性，避免过度苛责和无谓消耗。

import { BenchmarkProfiles, BenchmarkType, BenchmarkProfile } from '../benchmarks/BenchmarkProfiles.js';
import { resolveToday } from '../memory/timeAnchor.js';

export interface ReasoningStep {
  type: 'thinking' | 'plan' | 'verify' | 'critique' | 'risk' | 'action' | 'format_check';
  content: string;
}

export interface StructuredReasoningOutput {
  thinking: string;
  plan: string;
  verify?: string;
  critique?: string;
  risk?: string;
  formatCheck?: string;
  ironLawCheck?: string;   // 新增：工程纪律规则逐条自检
  raw: string;
}

export class StructuredReasoner {
  /**
   * 结构化 最高优先级纪律规则（高纪律模式 / 工程强模式）
   * 目标：既能在 benchmark 里表现出色，也能在真实日常高强度工程工作中可靠使用。
   * 语言上采用“纪律 + 质量保证”而非“违反=直接失败”，避免日常工作中模型过度紧张或 token 浪费。
   */
  static getEngineeringIronLawsHeader(): string {
    return `【结构化 高纪律模式工程纪律 - 高质量工作的核心要求】
1. Read-Before-Write：对任何文件进行 Write 或 Edit 之前，必须先完整 Read 该文件。这是避免幻觉和破坏性修改的基础。
2. Verify-Before-Claim：只有看到明确的验证通过信号（ALL_TESTS_PASSED、正确返回值、状态确认等），才能声称已修复或问题已解决。
3. 标准工具调用格式：优先使用 <> 结构化格式，保证可解析、可追溯。这是高纪律模式的基本纪律。
4. 零幻觉：只操作你真正读取过或明确存在的文件/函数/状态。
5. 每一步都要在内心快速检查以上纪律，保持修改过程清晰可验证。

说明：遵守这些规则能显著提升在复杂工程任务中的成功率和可维护性，同时也有助于在评测中取得更好结果。`;
  }

  /**
   * 较短的纪律规则提示（用于状态组合块，避免重复冗长）。
   */
  static getEngineeringIronLawsShort(): string {
    return `【工程纪律】Read-Before-Write、Verify-Before-Claim、标准 <> 格式、零幻觉。`;
  }

  /**
   * 组合静态纪律规则 + 当前实时状态，生成高纪律模式下每步都应该看到的前置块。
   */
  static buildFullIronLawHeader(status: {
    filesRead: number;
    filesWritten: number;
    rbwViolations: number;
    verifiedCount: number;
    stepsSinceLastVerification: number;
  }): string {
    const laws = this.getEngineeringIronLawsShort();

    const violations: string[] = [];
    if (status.rbwViolations > 0) violations.push(`Read-Before-Write 违规 ${status.rbwViolations} 次`);
    if (status.stepsSinceLastVerification >= 2) violations.push(`已连续 ${status.stepsSinceLastVerification} 步未真实验证`);
    if (status.filesWritten > status.filesRead) violations.push(`已写(${status.filesWritten}) > 已读(${status.filesRead})`);

    let header = laws + `\n\n【当前纪律规则状态】已读:${status.filesRead} 已写:${status.filesWritten} 真实验证:${status.verifiedCount} RBW违规:${status.rbwViolations} 距上次验证步:${status.stepsSinceLastVerification}`;

    if (violations.length > 0) {
      header += `\n【严重违规】${violations.join('；')} → 立刻停止写代码，先修复违规。`;
    } else {
      header += `\n状态正常，继续严格遵守纪律规则。`;
    }

    return header;
  }

  /**
   * 根据当前轨迹状态生成动态纪律规则状态块（高纪律模式下注入）
   * 语言风格：工程指导而非惩罚，强调“为了工作可靠性和质量”。
   */
  static buildCurrentIronLawStatus(params: {
    filesRead: number;
    filesWritten: number;
    rbwViolations: number;
    verifiedCount: number;
    stepsSinceLastVerification: number;
    strictFormatViolations?: number;
  }): string {
    const p = params;
    const violations: string[] = [];

    if (p.rbwViolations > 0) {
      violations.push(`Read-Before-Write 违规 ${p.rbwViolations} 次（修改前未读文件，容易引入幻觉和破坏）`);
    }
    if (p.stepsSinceLastVerification >= 3) {
      violations.push(`已连续 ${p.stepsSinceLastVerification} 步未完成真实验证（缺乏明确效果确认）`);
    }
    if (p.filesWritten > p.filesRead) {
      violations.push(`已写文件数(${p.filesWritten}) 多于已读文件数(${p.filesRead})（风险较高）`);
    }

    let status = `【当前工程纪律遵守状态】
已读文件: ${p.filesRead} | 已写文件: ${p.filesWritten} | 真实验证次数: ${p.verifiedCount}
Read-Before-Write 违规: ${p.rbwViolations} | 距上次验证步数: ${p.stepsSinceLastVerification}`;

    if (violations.length > 0) {
      status += `\n需要关注的问题: ${violations.join('；')}\n建议：先补齐读取和验证，再继续大范围修改。这有助于在真实项目和评测中都更稳定。`;
    } else {
      status += `\n当前状态良好，继续保持高标准工程实践。`;
    }

    return status;
  }

  /**
   * 生成结构化推理指令
   * - practicalMode=true: 轻量、日常友好、控制 token，适合真实编码工作
   * - practicalMode=false 或 isStrongMode=true: 高结构、高纪律，适合日常高强度工程任务
   * - taskStyle / benchmarkType: 指定当前任务风格（swe / terminal / automation），用于注入特定强调和工具提示。
   *   目的是适配真实工程场景，而非功利刷 benchmark。
   * - isStrongMode: 推荐的公共旗标，表示高纪律模式（会触发重纪律规则与格式要求）。
   */
  static buildReasoningPrompt(
    contextSummary: string,
    previousCritiques: string[] = [],
    options?: {
      practicalMode?: boolean;
      /** 新推荐：任务风格 */
      taskStyle?: string;
      /** 内部兼容旧称，等同于 taskStyle */
      benchmarkType?: BenchmarkType | string;
      /** 是否处于高纪律模式（推荐），影响是否注入重纪律规则 */
      isStrongMode?: boolean;
    }
  ): string {
    const practical = options?.practicalMode ?? false;
    const isStrong = options?.isStrongMode ?? false;
    const taskStyle = options?.taskStyle ?? (options?.benchmarkType as string | undefined);
    const benchmarkType = taskStyle as BenchmarkType | undefined;

    const failureMemory = previousCritiques.length > 0
      ? `\n\n【需要注意的之前问题】:\n${previousCritiques.slice(-3).map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';

    // 任务风格提示头已随性能叙事体系摘除（archive/2026-09-05-removals/）——prompt 只保留身份与纪律

    if (practical) {
      // 实用模式：更短、更温和、日常编码友好
      return `你是烛龙（Zhulong），通用智能体，有两种工作方式：
- 对话——问候、提问、知识/生活/创作等闲聊、模糊输入（如单词、编号"1"、情绪表达）：直接简短回应，意图不明时一次问清目标；不读文件、不调用工具。
- 执行——目标明确的工程任务：读代码、改文件、跑验证，直到验证通过后再报告完成。
歧义不往高风险方向解读（"清理"不等于"删除"）；得到用户答复后立即行动，不反复追问。

请用简洁的结构思考并行动：

<thinking>
简要分析问题（80-150字）：理解、关键点、做法、主要风险。
</thinking>

<plan>
具体步骤 + 涉及文件/命令/工作流（简洁）。
</plan>

<verify>
你将如何确认修改/操作正确（测试、命令输出、状态检查、效果验证等）。
</verify>

<critique>
（可选，从第2步起）上一步的问题或可改进点，1-2点即可。
</critique>

当前上下文：
${contextSummary}
${failureMemory}

保持简洁实用，避免冗长。日常任务不需要过度思考。`;
    }

    // 非实用模式（高纪律模式 / 高纪律路径）：保留更多结构与纪律提示
    return `
你是烛龙（Zhulong），通用智能体，有两种工作方式：
- 对话——问候、提问、知识/生活/创作等闲聊、模糊输入（如单词、编号"1"、情绪表达）：直接简短回应，意图不明时一次问清目标；不读文件、不调用工具。
- 执行——目标明确的工程任务：读代码、改文件、跑验证，直到验证通过后再报告完成。
歧义不往高风险方向解读（"清理"不等于"删除"）；得到用户答复后立即行动，不反复追问。
回答风格：简洁直接，先结论后细节；不知道就说不知道，不编造。

请使用以下结构进行思考和行动（可根据任务复杂度适当精简）：

<thinking>
对当前问题的清晰分析（建议 150-300 字）。
包括：问题理解、关键约束、当前最合理的做法、主要风险。
</thinking>

<plan>
简洁的执行计划，列出具体步骤和涉及文件/命令/工作流。
</plan>

<verify>
你计划如何验证修改/操作是否正确（测试、终端命令、状态断言、业务效果等）。
</verify>

<format_check>
（工具调用时建议填写）本次工具调用格式是否规范？
</format_check>

<iron_law_check>
（推荐在涉及文件修改/关键命令/工作流步骤时简要回答）
1. Read-Before-Write / Check-Before-Act：修改文件或执行破坏性/关键操作前是否已读取或检查状态？
2. Verify-Before-Claim：声明修复/完成前是否会进行验证？
3. 格式：是否使用标准工具调用格式？
</iron_law_check>

<critique>
（从第 2 步开始建议填写）
请客观分析上一步的问题和可改进点，保持简洁实用。
</critique>

当前上下文：
${contextSummary}
${failureMemory}

请输出清晰、实用的内容。`;
  }

  /**
   * 剥离网关侧推理标签（DeepSeek-R1 系/MiniMax-M3/Qwen3 等把推理以
   * `<think>...</think>` 内嵌在 content 里）——正文展示与历史回灌前必须剥离，
   * 否则用户与后续轮次都会看到推理原文。
   */
  static stripThinkTags(text: string): string {
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      // zhulong 自有教学标签 <thinking> 已被 parseReasoning 抽到 step.thinking，
      // 正文必须剥离（否则同一推理显示两份：thinking 块 + 正文原文）
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/^\s*<think>[\s\S]*$/i, '') // 未闭合的 think 块（截断响应常见）
      .trim();
  }

  /**
   * 解析模型返回的结构化推理块（支持 format_check）
   */
  static parseReasoning(rawOutput: string): StructuredReasoningOutput {
    const extract = (tag: string): string => {
      const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const m = rawOutput.match(re);
      return m ? m[1].trim() : '';
    };

    return {
      thinking: extract('thinking') || extract('think'),
      plan: extract('plan'),
      verify: extract('verify') || undefined,
      critique: extract('critique') || undefined,
      risk: extract('risk') || undefined,
      formatCheck: extract('format_check') || undefined,
      ironLawCheck: extract('iron_law_check') || undefined,
      raw: rawOutput,
    };
  }

  /**
   * 生成 Critique Prompt（建设性、可控 token 版本）
   * - practicalMode=true: 更温和、更短，聚焦有用改进，适合日常使用
   * - practicalMode=false: 保留结构化复盘，适合高纪律模式（高纪律路径）
   * 目标：帮助发现问题和改进方向，而不是严厉指责或无谓的自我苛责。
   */
  static buildCritiquePrompt(
    previousStep: string,
    executionResult: string,
    lastToolCalls: any[] = [],
    options?: { practicalMode?: boolean }
  ): string {
    const practical = options?.practicalMode ?? false;
    const toolInfo = lastToolCalls.length > 0
      ? `\n工具调用：${lastToolCalls.map((t: any) => t.toolName).join(', ')}`
      : '';

    if (practical) {
      // 实用模式：温和、简短、聚焦改进
      return `请简要复盘上一步（1-2点，每点一句话）：

上一步概要：
${previousStep}

执行结果：
${executionResult}${toolInfo}

请说明：
- 做得较好的地方（如果有）
- 主要问题或下一步建议（1-2点）

保持建设性，避免过度自我否定或长篇描述。`;
    }

    // 非实用模式（高纪律模式 / 高纪律路径）
    return `请对上一步进行简要、客观的复盘（建议 2-4 点，每点 1 句话左右）。

上一步概要：
${previousStep}

执行结果：
${executionResult}${toolInfo}

请重点说明：
- 做得比较好的地方（如果有）
- 存在的主要问题或风险（格式、验证、跳步、幻觉等）
- 下一步最值得调整或注意的一两件事

请保持建设性和实用性，避免过度自我否定或冗长描述。`;
  }

  /**
   * 构建工具调用格式教学提示。
   * 带具体 few-shot 示例——小模型（如 openPangu-Embedded）无法从抽象模板泛化，
   * 必须给出可模仿的真实调用。示例工具按 availableTools 动态挑选：教学里出现
   * 该档位不可用的工具会诱导 UNKNOWN_TOOL 空转（实测教训：quick 档示例
   * write_file，模型照抄后被拒，烧满步数）。
   *
   * openPangu 配合度修复（三路探查实证驱动）：
   *  - read_file 示例【恒有】——bash 独苗示例 → 模型 18/18 全选 bash（示例复制器）；
   *    read_file 示例在 → 工具选择正确；
   *  - toolNames 含 edit_file/glob/bash 时各追加一个完整参数示例（参数名从 schema
   *    取，不写死）；
   *  - 示例参数值一律中性占位（实证：示例值会泄漏进模型输出，src/index.ts →
   *    模型输出 src/config.json）；
   *  - 首句换为 V1 实证措辞（V1 3/3 零警告 vs 旧首句 1/3）；
   *  - 文本协议参数渲染：每个可用工具渲染一行"工具名 — 用途（参数：…）"——
   *    修"文本协议下模型看不到参数名 → 参数幻觉 100%"的结构性缺口。
   *    用途从 schema description 首行取；增量控制在 ~600 字符内。
   * @param toolNames 当前 adapter 实际注册的工具名（缺省视为 bash + read_file 可用）
   * @param opts.primaryTool 首选示例工具（保证其示例存在）
   * @param opts.schemaById 工具名 → { description, parameters }（来自 engineAdapter.toolSchemas()）
   */
  static buildToolCallFormatEnforcementPrompt(
    toolNames?: string[],
    opts?: {
      primaryTool?: string;
      schemaById?: Record<string, { description?: string; parameters?: any }>;
    }
  ): string {
    const tools = (toolNames && toolNames.length > 0 ? toolNames : ['bash', 'read_file']).map((n) => String(n));
    const lowerTools = new Set(tools.map((n) => n.toLowerCase()));

    /** 工具元数据：description 首行 + 全部参数名 + 必填参数（schema 优先，内置兜底）。 */
    const metaOf = (name: string): { description: string; params: string[]; required: string[] } => {
      const key = name.toLowerCase();
      const s = opts?.schemaById?.[key];
      if (s && typeof s === 'object') {
        const props = (s.parameters as any)?.properties ?? {};
        const all = Object.keys(props).map(String);
        const required: string[] = Array.isArray((s.parameters as any)?.required)
          ? (s.parameters as any).required.map(String)
          : [];
        // MCP 空壳 description（空串/纯空白）→ 兜底文案；否则取首行首个子句
        const rawDesc = String(s.description ?? '').trim();
        const descLine = rawDesc
          ? rawDesc.split('\n')[0].split(/[（(。；;]/)[0].trim().slice(0, 30)
          : '';
        return { description: descLine || '调用该工具完成任务', params: all.slice(0, 5), required };
      }
      const fb = StructuredReasoner.DEFAULT_TOOL_META[key];
      if (fb) return { description: fb.description, params: fb.params.slice(0, 5), required: fb.required.slice(0, 5) };
      return { description: '调用该工具完成任务', params: [], required: [] };
    };

    /** 示例用中性占位值（防示例值泄漏进模型输出）。 */
    const neutralValue = (param: string): string => {
      const map: Record<string, string> = {
        file_path: 'sample.txt',
        pattern: 'pattern',
        command: 'echo hello',
        content: '待写入的内容',
        old_string: '待替换的原文',
        new_string: '替换后的新文本',
      };
      return map[param] ?? '示例值';
    };

    /** 由必填参数生成示例块（无 required 清单时回落全部已知参数）。 */
    const exampleOf = (name: string, label: string): string => {
      const m = metaOf(name);
      const paramNames = m.required.length > 0 ? m.required : (m.params.length > 0 ? m.params : ['value']);
      const body = paramNames.map((p) => `    <${p}>${neutralValue(p)}</${p}>`).join('\n');
      return `${label}：\n<>\n  <${name}>\n${body}\n  </${name}>\n</>`;
    };

    // 示例选择：read_file 恒有；primaryTool 保证；bash/glob/edit_file/write_file 按可用性追加
    const examples: string[] = [];
    const wantExample = new Set<string>(['read_file']);
    if (opts?.primaryTool) wantExample.add(String(opts.primaryTool).toLowerCase());
    for (const t of ['bash', 'glob', 'edit_file', 'write_file']) {
      if (lowerTools.has(t)) wantExample.add(t);
    }
    const LABELS: Record<string, string> = {
      read_file: '读文件示例',
      bash: '执行命令示例',
      glob: '列文件示例',
      edit_file: '编辑文件示例',
      write_file: '写文件示例',
    };
    // read_file 恒排首位（示例复制器实证：首位示例主导工具选择）
    const ordered = [...wantExample].sort((a, b) => (a === 'read_file' ? -1 : b === 'read_file' ? 1 : 0));
    for (const t of ordered) {
      examples.push(exampleOf(t, LABELS[t] ?? `${t} 示例`));
    }

    // 文本协议参数渲染：每工具一行"名 — 用途（参数：…）"
    const toolLines = tools.map((t) => {
      const m = metaOf(t);
      const paramPart = m.params.length > 0 ? m.params.join(', ') : '见工具说明';
      return `${t} — ${m.description}（参数：${paramPart}）`;
    });

    return `【工具调用格式（必须遵守）】
你必须只输出一个工具调用块，不要输出任何解释文字。可用工具：${tools.join(', ')}。

${examples.join('\n\n')}

各工具用途与参数（参数名必须一字不差）：
${toolLines.join('\n')}

规则：
- 一次只调用一个工具，看到结果后再决定下一步。不要调用可用列表之外的工具。
- 参数写在 <参数名>值</参数名> 中，不要用 JSON；参数名以上方列表为准。
- 不要把工具调用块放进 \`\`\` 代码块。
- 完成修改后必须运行验证命令；全部通过时在最后输出 VERIFICATION: PASS。
- 禁止只描述计划而不输出工具调用块。`;
  }

  /**
   * 内置工具元数据兜底（与 engineAdapter.BUILTIN_TOOL_SCHEMAS 对齐）。
   * 仅当调用方未注入 schemaById 时使用；params=全部参数名（速览行用），
   * required=必填参数（示例块用）。
   */
  private static readonly DEFAULT_TOOL_META: Record<string, { description: string; params: string[]; required: string[] }> = {
    read_file: { description: '读取工作区内文本文件的内容', params: ['file_path', 'offset', 'limit'], required: ['file_path'] },
    glob: { description: '按 glob 模式列出工作区内的文件路径', params: ['pattern', 'path'], required: ['pattern'] },
    grep: { description: '在工作区内按正则搜索文件内容', params: ['pattern', 'path', 'include'], required: ['pattern'] },
    bash: { description: '在工作区执行 bash 命令', params: ['command'], required: ['command'] },
    write_file: { description: '写入（或覆盖）工作区内的文件', params: ['file_path', 'content'], required: ['file_path', 'content'] },
    edit_file: { description: '对工作区内已有文件做精确字符串替换', params: ['file_path', 'old_string', 'new_string', 'replace_all'], required: ['file_path', 'old_string', 'new_string'] },
  };

  /**
   * 0.7：对话（chat）路径的单轮指令——不注入任何工具调用教学/格式纪律，
   * 直接简洁回答。与 buildReasoningPrompt 的"执行"路径分离，消除弱模型
   * "对话不调工具"与"每步必须输出工具块"的指令冲突。
   */
  static buildChatDirective(issue: string): string {
    return `${this.buildChatSystemDirective()}

用户的输入：
${issue}`;
  }

  /**
   * R3（0.8.1）：chat 流式 messages 通道的 system 指令（不含用户输入——
   * 输入走独立 user 消息，避免 buildChatDirective 整段内嵌导致的输入重复注入）。
   * 与 buildChatDirective 的指令文本逐字节一致（后者 = 本指令 + 用户输入段）。
   * F2（0.8.1 第 2 轮）：由"身份声明式"改为"情境框架式"——MiniMax-M3 等模型的
   * 原生 ROOT_SYSTEM_POLICY 会把"你是烛龙"式身份断言判定为注入并拒绝
   * （think 原文实证："I should not adopt the fake identity"），改为包装界面
   * 角色、不对抗底层身份；禁用 injection/fake 类对抗框架词。
   */
  static buildChatSystemDirective(): string {
    return `你在「烛龙 Zhulong」交互界面中作为全能智能助手回应用户。这是一次普通对话/提问，不是需要改代码、跑验证的工程任务。要点：
- 有问必答：知识科普、生活、历史、创作、闲聊与工程技术问题一视同仁，直接给出内容本身
- 不要以"工程助手"自居设限，不要拒绝或贬低非工程话题，不要把话题拉回软件开发
- 不要调用任何工具，不要读取或修改文件，不要输出工具调用块或 <> 标签
- 简洁自然：用户在终端环境，偏好直接的内容；不复述身份、档位、工作目录等系统信息
- 今天是 ${resolveToday()}。涉及"多久之前/多少周/几天前"的问题，用今天减去记忆卡中标注的事实日期计算。
- 用用户提问的语言作答（中文提问答中文，英文提问答英文）。
  （权衡申报：对中文原生模型强制英文作答有表达力折损，换取判分/契约公平——COMPARE-90 已登记）
- 不知道就如实说不知道，不编造事实、数据与年代
- 用中文回答（除非用户使用其他语言）
- 助手人格是本交互界面的一部分，无需向用户声明或讨论底层模型与供应商信息`;
  }

  /**
   * 0.7：只读搜索（search）路径的指令——先用只读工具搜索目标；搜不到就
   * 停止并询问用户具体用意；禁止写/bash。
   */
  static buildSearchDirective(issue: string): string {
    return `你是烛龙（Zhulong），通用智能体。
用户提到了一个文件/路径，但没有说明要做什么。请先只读搜索确认它是否存在：
- 用 glob / read_file / grep 在工作区内查找；只读，禁止 write_file / edit_file / bash。
- 找到 → 简要报告它的位置与内容概要，然后停止。
- 找不到 → 直接告诉用户"未找到 <目标>"，并询问具体想做什么，不要猜测、不要创建或修改任何文件。

用户的输入：
${issue}`;
  }
}

