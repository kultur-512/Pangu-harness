// src/cli/repl/Repl.ts
import type { CommandContext, OutputRenderer, InputReader, ModelProvider } from './types.js';
import { CommandRegistry } from './CommandRegistry.js';
import { Session } from './Session.js';
import { createOutputRenderer } from './OutputRenderer.js';
import { createInputReader } from './InputReader.js';
import { SessionStore } from './SessionStore.js';
import { Completer } from './Completer.js';
import { KeyHandler } from './KeyHandler.js';
import { MultilineBuffer } from './MultilineBuffer.js';
import { PromptBuilder } from './PromptBuilder.js';
import { TierRegistry } from '../../tiers/TierConfig.js';
import { classifyTaskIntent } from '../taskIntent.js';
import { createCliApprovalBridge } from '../../tools/approval.js';
import { resolveWindowTokens } from './tokenEstimate.js';

// Import all commands
import HelpCommand from './commands/HelpCommand.js';
import ExitCommand from './commands/ExitCommand.js';
import ClearCommand from './commands/ClearCommand.js';
import StatusCommand from './commands/StatusCommand.js';
import TierCommand from './commands/TierCommand.js';
import WorkspaceCommand from './commands/WorkspaceCommand.js';
import ModelCommand from './commands/ModelCommand.js';
import HistoryCommand from './commands/HistoryCommand.js';
import RunCommand from './commands/RunCommand.js';
import TaskCommand from './commands/TaskCommand.js';
import SimulateCommand from './commands/SimulateCommand.js';
import ReviewCommand from './commands/ReviewCommand.js';
import MemoryCommand from './commands/MemoryCommand.js';
import TraceCommand from './commands/TraceCommand.js';
import ConfigCommand from './commands/ConfigCommand.js';
import SessionCommand from './commands/SessionCommand.js';
import InitCommand from './commands/InitCommand.js';
import ServeCommand from './commands/ServeCommand.js';
import ApprovalsCommand from './commands/ApprovalsCommand.js';
import UndoCommand from './commands/UndoCommand.js';
import CompactCommand from './commands/CompactCommand.js';
import UsageCommand from './commands/UsageCommand.js';
import ResumeCommand from './commands/ResumeCommand.js';
import RewindCommand from './commands/RewindCommand.js';
import AgentsCommand from './commands/AgentsCommand.js';
import FeatureCommand from './commands/FeatureCommand.js';
import TreeCommand from './commands/TreeCommand.js';
import { AgentTree } from './AgentTree.js';
import { extractChangedFiles, extractVerifyCommands, mapOutcome } from '../../loop/trajectory.js';
import { finalizeTaskMemory } from '../../server/runAgentTask.js';

export class Repl {
  private registry = new CommandRegistry();
  private renderer: OutputRenderer;
  private input: InputReader;
  public session: Session;
  private store: SessionStore;
  private running = false;

  private completer: Completer;
  private keyHandler: KeyHandler;
  private multilineBuffer = new MultilineBuffer();
  private currentAbort: (() => void) | null = null;
  private taskAborted = false;
  private taskAbortController: AbortController | null = null;
  /** Sub-agent rollout tree (public for /agents). */
  public agentTree!: AgentTree;

  // Ink UI (Path B) - active bridge when rich TTY mode is running
  private inkBridge: any = null;
  private getPromptBuilder(): PromptBuilder {
    const tierConfig = TierRegistry.get(this.session.tier);
    return new PromptBuilder(this.session, tierConfig);
  }

  constructor(opts: { session?: Session; provider?: ModelProvider } = {}) {
    this.session = opts.session ?? new Session();
    if (opts.provider) {
      this.session.provider = opts.provider;
    }
    this.renderer = createOutputRenderer();
    this.store = new SessionStore();

    // Register ALL commands first (needed for completer)
    this.registry.register(HelpCommand);
    this.registry.register(ExitCommand);
    this.registry.register(ClearCommand);
    this.registry.register(StatusCommand);
    this.registry.register(TierCommand);
    this.registry.register(WorkspaceCommand);
    this.registry.register(ModelCommand);
    this.registry.register(HistoryCommand);
    this.registry.register(RunCommand);
    this.registry.register(TaskCommand);
    this.registry.register(SimulateCommand);
    this.registry.register(ReviewCommand);
    this.registry.register(MemoryCommand);
    this.registry.register(TraceCommand);
    this.registry.register(ConfigCommand);
    this.registry.register(SessionCommand);
    this.registry.register(InitCommand);
    this.registry.register(ServeCommand);
    this.registry.register(ApprovalsCommand);
    this.registry.register(UndoCommand);
    this.registry.register(CompactCommand);
    this.registry.register(UsageCommand);
    this.registry.register(ResumeCommand);
    this.registry.register(RewindCommand);
    this.registry.register(AgentsCommand);
    this.registry.register(FeatureCommand);
    this.registry.register(TreeCommand);

    // per-session agent tree (fed by the interactive layer's onEvent)
    this.agentTree = new AgentTree();

    // Completer + Input with Tab support
    this.completer = new Completer(this.registry, () => this.session.workspace);
    this.input = createInputReader((line: string) => this.completer.complete(line));

    // Key handling (Ctrl+C, Esc+Enter multiline, Tab)
    this.keyHandler = new KeyHandler(this.input);
    this.keyHandler.setMultilineHandlers(
      () => {
        this.multilineBuffer.cancel();
        (this.input as any).exitMultiline?.();
        this.renderer.warn('多行输入已取消');
      },
      () => {
        const full = this.multilineBuffer.submit();
        (this.input as any).exitMultiline?.();
        // Feed the accumulated input back into the loop
        setImmediate(() => this.handleInput(full));
      }
    );
    this.keyHandler.setInterruptHandler(() => {
      if (this.currentAbort) {
        this.currentAbort();
      } else {
        // No running task: treat as exit request
        this.running = false;
      }
    });

    // Belt-and-suspenders: also listen to real SIGINT.
    // During a long task, if keypress doesn't fire (due to pause or terminal quirks),
    // SIGINT will still let us abort the task and return the prompt immediately.
    process.on('SIGINT', () => {
      if (this.currentAbort) {
        this.currentAbort();
      } else {
        this.running = false;
      }
    });

    process.on('exit', () => this.saveSession());
  }

  private saveSession() {
    try { this.store.save(this.session); } catch {}
  }

  /**
   * B4 (review defect): /session load must swap the session the Repl actually
   * runs on — buildContext() reads this.session on every command, so mutating
   * ctx.session alone was a no-op. Persist the outgoing session, adopt the
   * loaded one, and refresh the provider reference.
   */
  setSession(next: Session): void {
    try { this.store.save(this.session); } catch {}
    this.session = next;
    if (next.provider) this.session.provider = next.provider;
  }

  private buildContext(): CommandContext {
    const base: any = {
      session: this.session,
      registry: this.registry,
      renderer: this.renderer,
      input: this.input,
      repl: this,
      provider: this.session.provider,
      // /run 等 registry 命令在 classic 路径下也能走
      // 真审批桥（懒创建——仅在引擎发出审批请求时才打开 readline）。
      // signal 无法在此注入：AbortController 属于 executeTask 的单任务生命周期。
      approvalBridge: createCliApprovalBridge(),
    };
    if (this.inkBridge) {
      base.inkBridge = this.inkBridge;
    }
    return base;
  }

  async start(): Promise<void> {
    this.running = true;
    this.renderer.clearScreen();

    // Path B (ink UI): attempt rich TTY UI first.
    // On ANY failure (module missing, !TTY, !caps, render error), we MUST fall through
    // to the classic line-mode REPL. startInkUI is guaranteed to be silent on fallback.
    let inkStarted = false;
    try {
      const { tryStartInkUI } = await import('./ui/startInkUI.js');
      if (tryStartInkUI) {
        const res = await tryStartInkUI(this.session, this.renderer, this);
        if (res && res.started) {
          this.inkBridge = (this as any).inkBridge || (this as any)._inkBridge || null;
          inkStarted = true;
        }
      }
    } catch {
      // Never let ink attempt break the legacy path.
    }

    if (inkStarted) {
      // Ink owns the terminal event loop. Do not start classic REPL.
      return;
    }

    // Explicit legacy / classic line-mode REPL path.
    // This is the only way we reach here:
    // - non-TTY
    // - ink/react not installed or failed to load
    // - insufficient terminal capabilities
    // - any runtime error during ink bootstrap
    await this.startLegacy();
  }

  /**
   * Classic line-mode REPL (the original behavior).
   * This is the guaranteed fallback when ink mode cannot/should not start.
   */
  private async startLegacy(): Promise<void> {
    this.printWelcome();

    while (this.running) {
      try {
        const line = await this.readInput();
        await this.handleInput(line.trim());
      } catch (err: any) {
        this.renderer.error(String(err?.message || err));
      }
    }
    this.shutdown();
  }

  private async readInput(): Promise<string> {
    const prompt = this.buildPrompt();
    let line = await this.input.read(prompt);

    // ":" triggers multiline collection (simple, reliable)
    if (line.trim() === ':' || line.trim() === '::') {
      this.renderer.info('多行输入模式：每行输入内容，空行提交，Ctrl+C 取消');
      const lines: string[] = [];
      while (true) {
        const more = await this.input.read('  ... ');
        if (!more.trim()) break;
        lines.push(more);
      }
      return lines.join('\n');
    }

    return line;
  }

  private buildPrompt(): string {
    const tier = String(this.session.tier).toUpperCase();
    const ws = this.session.workspace.replace(process.env.HOME || '', '~');
    return this.renderer.color(`Zhulong [${tier}] · ${ws}\n  ▸ `, 'cyan');
  }

  private printWelcome() {
    // 外部产品名：烛龙（Zhulong）。内部代号：盘沙拉克 Panshalach（不展示在启动文案）
    this.renderer.writeLine(this.renderer.color('烛龙（Zhulong） Interactive Shell', 'bold'));
    this.renderer.writeLine('基于 openPangu 的通用智能体 — 软件工程、知识问答、日常对话皆为所长。');
    this.renderer.writeLine(`默认档位: ${this.session.tier} · 工作区: ${this.session.workspace}`);
    this.renderer.writeLine('输入 /help 查看命令，/exit 退出\n');
  }

  async handleInput(input: string): Promise<void> {
    if (!input) return;

    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(/\s+/);
      const result = await this.registry.execute(this.buildContext(), cmd, args);
      if (result.message) this.renderer.writeLine(result.message);
      if (result.clearScreen) this.renderer.clearScreen();
      if (result.exit) this.running = false;
      return;
    }

    // Natural language shortcuts
    if (input.startsWith('run ') || input.startsWith('r ')) {
      const task = input.replace(/^r(un)?\s+/, '').replace(/^["']|["']$/g, '');
      await this.executeTask(task);
      return;
    }
    if (input.startsWith('simulate ') || input.startsWith('s ')) {
      const task = input.replace(/^s(imulate)?\s+/, '').replace(/^["']|["']$/g, '');
      await this.executeTask(task, true);
      return;
    }

    // Safety guard for common mistakes:
    // If the user types something that looks like a shell command or node/npm invocation
    // directly at the prompt, do NOT silently treat it as a long-running agent task.
    // This is the most common way people "误输入进去".
    const looksLikeShell =
      /^(node|npm|npx|yarn|pnpm|cd |ls|dir |cat |type |echo |powershell|cmd|git |tsc |eslint |prettier |python |py )/i.test(input) ||
      /\bnode\s+dist\/cli\.js\b/i.test(input);

    if (looksLikeShell) {
      this.renderer.warn('检测到看起来像 shell / 命令行的输入。');
      this.renderer.writeLine('在 ▸ 提示符下直接输入会被当成“任务”让 Agent 执行。');
      this.renderer.writeLine('如果你是想测试构建，请在**另一个** PowerShell 窗口执行：');
      // was a hard-coded developer path — derive from the actual cwd.
      this.renderer.writeLine('    cd ' + process.cwd());
      this.renderer.writeLine('    node dist/cli.js');
      this.renderer.writeLine('');
      this.renderer.writeLine('要让 Agent 执行，请明确用：');
      this.renderer.writeLine('    run "你的任务描述"');
      this.renderer.writeLine('或先用 /model 选好模型后再输入自然语言任务。');
      this.renderer.writeLine('');
      this.renderer.writeLine('如果你确实想让 Agent 去“执行 node ...”，请用： run "node dist/cli.js"');
      return;
    }

    await this.executeTask(input);
  }

  private async executeTask(issue: string, simulate = false) {
    // Resolve a real client via provider; never pass null to PanshalachChaser
    const provider = this.session.provider as (import('./types.js').ModelProvider | undefined);
    const client = this.resolveClient();
    if (!client) {
      this.renderer.error('未配置可用的模型客户端。使用 /model <name> 或检查配置。');
      const models = provider?.listModels?.() ?? [];
      if (models.length) {
        this.renderer.info('可用模型: ' + models.join(', '));
      } else {
        this.renderer.info('当前未注册任何模型。');
      }
      this.input.resume();
      this.currentAbort = null;
      return;
    }

    // Consume model context length from provider (persisted or cache).
    // 收口到共享 resolveWindowTokens：unknown/哨兵 → 32768 保守值（旧回落
    // 256000 会把未知窗口谎报成"上下文 256K"）；与 loop 裁剪预算同源。
    const modelName = this.session.model || 'default';
    const effectiveModel = (provider && typeof (provider as any).getEffectiveModel === 'function')
      ? (provider as any).getEffectiveModel(modelName)
      : modelName;
    const contextLen: number = resolveWindowTokens(provider, modelName);

    const { PanshalachChaser } = await import('../../PanshalachChaser.js');
    const chaser = new PanshalachChaser(client, this.session.tier);

    // Prepare richer prompt/context from REPL side (session history + tier rules + memory cards)
    const pb = this.getPromptBuilder();
    // 意图分类前移——对【原始输入】分类（富化文本必含执行词，
    // 在其上分类会使 chat/search 恒不可达）。gate 语义由 classifyTaskIntent 内部保持。
    const intent = classifyTaskIntent(issue);
    let enriched = await pb.buildForTask(issue, intent);

    // 捕获注入的记忆卡 ID（供 finalizeTaskMemory 消费——R2 markVerified 交集判定）
    const injectedCardIds: string[] = pb.lastBuildMeta?.injectedCardIds ?? [];

    // Inject context length hint so the model is aware of its own window
    if (contextLen > 0) {
      const ctxK = Math.round(contextLen / 1000);
      enriched += `\n\n【当前模型上下文】模型 "${effectiveModel}" 的上下文上限约为 ${ctxK}K tokens。请在此范围内合理规划输出与思考深度。`;
    }

    this.renderer.info(`${simulate ? '[SIMULATE] ' : ''}开始: ${issue}`);
    if (this.session.turns.length > 0) {
      this.renderer.writeLine(this.renderer.color(`(上下文: 最近 ${Math.min(3, this.session.turns.length)} 轮 + 档位规则已注入)`, 'gray'));
    }

    // Also push to ink bridge if active
    if (this.inkBridge && typeof this.inkBridge.pushFeed === 'function') {
      this.inkBridge.pushFeed({ type: 'text', text: `${simulate ? '[SIMULATE] ' : ''}开始: ${issue}`, level: 'info' });
      if (this.session.turns.length > 0) {
        this.inkBridge.pushFeed({
          type: 'text',
          text: `(上下文: 最近 ${Math.min(3, this.session.turns.length)} 轮 + 档位规则已注入)`,
          level: 'info',
        });
      }
    }

    this.taskAborted = false;

    // Support immediate Ctrl+C abort:
    // We race the long-running chaser.solveIssue against an abort promise.
    // When user presses Ctrl+C, we reject the abort promise so the await unblocks
    // right away and we can return the prompt to the user.
    let abortReject: ((reason?: any) => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });

    // classic 路径自己的 AbortController——Ctrl+C 时
    // race 仍 reject（提示符立即返回），同时 signal 贯穿 solveIssue → loop →
    // 模型 fetch / 工具执行，让引擎真正停下（不再假中止）。
    const taskAbortController = new AbortController();

    this.currentAbort = () => {
      this.taskAborted = true;
      this.renderer.warn('任务已中断 (Ctrl+C)');
      // Resume input as soon as possible so the user gets the prompt back.
      try { this.input.resume(); } catch {}
      try { taskAbortController.abort(); } catch {}
      if (abortReject) {
        const err: any = new Error('TASK_ABORTED');
        err.code = 'ABORTED';
        abortReject(err);
      }
      // Clear so subsequent Ctrl+C in the "no task" state can exit cleanly.
      this.currentAbort = null;
    };

    // Pause interactive input while task runs (keeps keypress for Ctrl+C)
    this.input.pause();

    // Drive ink UI running state (if active). Safe no-op otherwise.
    if (this.inkBridge && typeof this.inkBridge.setRunning === 'function') {
      try { this.inkBridge.setRunning(true); } catch {}
    }

    const start = Date.now();
    let result: any = null;

    // Race the long-running solveIssue against the abort promise.
    // When the user presses Ctrl+C, currentAbort rejects abortPromise,
    // which unblocks this await immediately and lets us return the prompt.
    const taskWork = chaser.solveIssue(enriched, this.session.workspace, {
      tier: this.session.tier as any,
      yes: true,
      dryRun: simulate,
      memoryPreInjected: true,
      intent, // 入口前移的意图显式传入
      // loop 70% 窗口预算裁剪的依据（此前只有 server/headless 路径传入，
      // 交互模式长任务在溢出前没有任何主动裁剪）。
      windowTokens: resolveWindowTokens(provider, modelName),
      // C5（0.8.2 审查）：溢出 → 宿主应急压缩接线——onContextOverflow 首次
      // 触发时对会话跑一次同步压缩（loop 的 overflowNotified 保证每任务至多
      // 一次；绕 0.85 阈值的 force 语义由 compactSession 的轮次门槛自然承担），
      // 会话级自愈而非只靠 loop 内截断。best-effort：失败不阻断任务。
      onContextOverflow: async () => {
        try {
          const { compactSession } = await import('./compactService.js');
          const r = await compactSession(this.session, client);
          if (r.ok) this.renderer.warn(`溢出应急压缩：${r.message}`);
        } catch { /* 记忆/压缩失败不阻断任务 */ }
      },
      // classic 路径与 SSE 主路径共享同一审批/中断语义。
      approvalMode: this.session.approvalMode,
      sessionAllowlist: this.session.sessionApprovalAllowlist,
      approvalBridge: createCliApprovalBridge(),
      signal: taskAbortController.signal,
      onStep: (event: any) => {
        if (this.taskAborted) {
          return;
        }

        // protocol-v2 streaming deltas are consumed by the SSE/rich path;
        // the classic REPL keeps step-granular output and must not render them
        // (the final else-branch would otherwise pushFeed raw delta objects).
        if (
          event &&
          event.version === 2 &&
          (event.type === 'thinking.start' || event.type === 'message.start' ||
           event.type === 'thinking.delta' || event.type === 'message.delta')
        ) {
          return;
        }

        // Always drive classic renderer
        if (event.type === 'step') {
          this.renderer.writeLine(`[Step ${event.stepNumber}] ${event.thinking || event.plan || ''}`);
        }
        if (event.type === 'softLimit' || event.type === 'budget') {
          const ratio = typeof event.usedRatio === 'number' ? event.usedRatio : 0;
          this.renderer.writeLine(this.renderer.color(`[budget ${(ratio * 100).toFixed(0)}%]`, 'cyan'));
        }

        // Rich ink UI bridge
        if (this.inkBridge) {
          if (event.type === 'step') {
            if (typeof this.inkBridge.pushStep === 'function') this.inkBridge.pushStep(event);
            // Also surface tool calls as cards
            if (Array.isArray(event.toolCalls) && typeof this.inkBridge.pushTool === 'function') {
              for (const tc of event.toolCalls) {
                this.inkBridge.pushTool({
                  tool: tc?.name || tc?.tool || 'tool',
                  target: tc?.path || tc?.file || tc?.target,
                  argsSummary: tc?.args ? JSON.stringify(tc.args).slice(0, 80) : '',
                  status: 'running',
                });
              }
            }
          } else if (event.type === 'critique' && typeof this.inkBridge.pushCritique === 'function') {
            this.inkBridge.pushCritique(event);
          } else if (event.type === 'softLimit' && typeof this.inkBridge.pushBudget === 'function') {
            this.inkBridge.pushBudget(event.usedRatio || 0);
          } else if (typeof this.inkBridge.pushFeed === 'function') {
            this.inkBridge.pushFeed(event);
          }
        }
      },
    });

    try {
      result = await Promise.race([taskWork, abortPromise]);

      const duration = Date.now() - start;

      if (this.taskAborted) {
        // signal 已贯穿底层，等待真正 settle（通常 abort 后立即返回）
        let settled: any = null;
        try { settled = await taskWork; } catch {}
        this.recordAbortedTurn(issue, duration, settled?.bestTrajectory?.partialText);
        this.renderer.warn('任务已中断');
        this.input.resume();
        this.currentAbort = null;
        return;
      }

      // 记忆落定（单一落定点）——仅 completed（真实验证通过）触发
      // refine→save 产卡 + 注入卡∩写集 markVerified。best-effort：记忆失败绝不
      // 影响任务成功返回。
      try {
        await finalizeTaskMemory(this.session, result, injectedCardIds, (event: any) => {
          if (event.type === 'memory.finalized') {
            this.renderer.writeLine(this.renderer.color(
              `[记忆] 提炼 ${event.cards ?? 0} 张卡，验证 ${event.verified ?? 0} 张`,
              'gray'
            ));
          }
        });
      } catch {}

      // 对话事实记忆（chat 直答沉淀）——与 runAgentTask server 路径同款：
      // answered 正文 + chat 意图才落卡。classic 行模式 REPL 此前静默零沉淀
      // （对抗审查 F16）。best-effort：记忆沉淀失败绝不影响对话返回。
      if ((result as any)?.bestTrajectory?.stopReason === 'answered' && this.session.workspace) {
        try {
          const ansTraj = (result as any).bestTrajectory;
          const chatAnswer = String(ansTraj?.steps?.[ansTraj.steps.length - 1]?.result ?? '');
          if (chatAnswer.trim() && classifyTaskIntent(issue) === 'chat') {
            const { recordChatFact } = await import('../../memory/chatFactMemory.js');
            await recordChatFact(this.session.workspace, issue, chatAnswer);
          }
        } catch { /* 记忆沉淀失败不影响对话 */ }
      }

      // 四态文案：completed→已通过验证；answered→已回复；error→执行失败；其余→未通过验证
      const stopReason = (result as any)?.bestTrajectory?.stopReason;
      const summary = stopReason === 'completed' ? '已通过验证'
        : stopReason === 'answered' ? '已回复'
        : stopReason === 'error' ? '任务执行失败'
        : result.success ? '已通过验证' : '未通过验证';
      if (stopReason === 'error') {
        this.renderer.error(`完成 (${duration}ms) · ${summary}${result?.bestTrajectory?.lastError ? ' · ' + String(result.bestTrajectory.lastError).split('\n')[0].slice(0, 120) : ''}`);
      } else {
        this.renderer.success(`完成 (${duration}ms) · ${summary}`);
      }

      // answered 时把模型正文呈现给用户
      if (stopReason === 'answered') {
        const traj = (result as any)?.bestTrajectory;
        const answerText = traj?.steps?.[traj.steps.length - 1]?.result || '';
        if (answerText) {
          const preview = answerText.length > 600 ? answerText.slice(0, 597) + '…' : answerText;
          this.renderer.writeLine(preview);
        }
      }

      const bestTraj = (result as any)?.bestTrajectory;
      const trajSteps = bestTraj?.steps ?? [];
      this.session.addTurn({
        id: Date.now().toString(36),
        timestamp: Date.now(),
        userInput: issue,
        userInputType: 'task',
        tier: this.session.tier,
        durationMs: duration,
        result: {
          success: result.success,
          summary,
          budgetReport: result.budgetReport,
          stopReason,
          goal: issue,
          changedFiles: extractChangedFiles(trajSteps),
          verifyCmd: extractVerifyCommands(trajSteps),
          outcome: mapOutcome(stopReason),
        },
      });
      this.saveSession();
    } catch (err: any) {
      if (this.taskAborted || (err && (err.code === 'ABORTED' || err.message === 'TASK_ABORTED'))) {
        // abort 竞速先 reject 的路径同样落 aborted turn（等底层
        // signal 触发后 settle，通常立即返回）。
        let settled: any = null;
        try { settled = await taskWork; } catch {}
        this.recordAbortedTurn(issue, Date.now() - start, settled?.bestTrajectory?.partialText);
        this.renderer.warn('任务已中断');
      } else {
        this.renderer.error('失败: ' + (err?.message || err));
      }
    } finally {
      this.input.resume();
      this.currentAbort = null;
      if (this.inkBridge && typeof this.inkBridge.setRunning === 'function') {
        try { this.inkBridge.setRunning(false); } catch {}
      }
    }
  }

  /**
   * 中断现场落盘：classic 路径的 aborted 回合同样写 turn——
   * 与 sseInteractive 的 aborted 分支同语义：stopReason='aborted' + partialText
   * （已流出正文，可能为空）。session 落账后持久化。
   */
  private recordAbortedTurn(issue: string, durationMs: number, partialText?: string): void {
    try {
      this.session.addTurn({
        id: Date.now().toString(36),
        timestamp: Date.now(),
        userInput: issue,
        userInputType: 'task',
        tier: this.session.tier,
        durationMs,
        ...(partialText ? { partialText } : {}),
        result: { success: false, summary: '已中断', stopReason: 'aborted', goal: issue, changedFiles: [], verifyCmd: [], outcome: 'aborted' },
      });
      this.saveSession();
    } catch {}
  }

  /**
   * Resolve a usable ModelClient from session.provider.
   * Tries session.model first, then provider's default.
   * Returns null if no usable client (caller must not create PanshalachChaser(null)).
   */
  private resolveClient(): import('./types.js').ModelClient | null {
    const provider = this.session.provider;
    if (!provider) return null;
    // Prefer current session.model
    const byName = provider.createClient(this.session.model);
    if (byName) return byName;
    // Fallback to provider default
    return provider.createDefaultClient();
  }

  async runOneShot(args: string[]): Promise<void> {
    const cmd = args[0] || 'help';
    const rest = args.slice(1);
    const result = await this.registry.execute(this.buildContext(), cmd, rest);
    if (result.message) this.renderer.writeLine(result.message);
    this.saveSession();
  }

  private shutdown() {
    this.input.close();
    this.saveSession();
    this.renderer.writeLine('\n再见。');
  }
}
