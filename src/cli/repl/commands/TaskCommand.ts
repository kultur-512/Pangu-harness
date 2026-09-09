// src/cli/repl/commands/TaskCommand.ts
// R5 赵天昂 own 端:`/task` 命令入口。
// 数据源:TaskStateStore.get(taskId),不读 R3、不读 session.turns(王佐 9/7 回复)。
// 纪律:decide 严格走 update,不构造 AgentEvent、不调 applyEvents
// (applyEvents 仅用于 AgentEvent 流折叠;用户决策不是 AgentEvent)。
// 见 [[r5-taskstate-contract]] 的 "decide 走 update,不要走 applyEvents" 纪律。
//
// 子命令:
//   status  — 纯读,formatTaskStatus(389e43a)
//   risks   — 纯读,formatTaskRisks(9/9 新增)
//   next    — 纯读 + 5 档推导,formatTaskNext + deriveNext(9/9 新增)
//   decide  — 写,store.update(9/9 新增;不走 applyEvents)

import type { Command, CommandContext, CommandResult } from '../types.js';
import {
  formatTaskStatus,
  formatTaskRisks,
  formatTaskNext,
  deriveNext,
} from './TaskCommand.format.js';

const command: Command = {
  name: 'task',
  description: '任务台账控制面:status / risks / next / decide',
  category: 'task',
  usage: '/task <status|risks|next|decide> [taskId|"决策内容" ["why"]]',

  async execute(ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const sub = (args[0] ?? '').toLowerCase();
    const rest = args.slice(1);

    // 默认 taskId 解析:CLI 参数 > session.currentTaskId。
    // store 走动态 import,与 PromptBuilder.ts:387 同款(避免冷启动 + 循环依赖)。
    const { TaskStateStore } = await import('../../../memory/taskState.js');
    const workspace = ctx.session?.workspace ?? process.cwd();
    const store = new TaskStateStore(workspace);

    // --- status ---
    if (sub === 'status') {
      const taskId = rest[0] ?? ctx.session?.currentTaskId;
      if (!taskId) {
        ctx.renderer.warn('未指定 taskId 且 session 未绑定当前任务。');
        ctx.renderer.info('用法: /task status [taskId]');
        ctx.renderer.info('提示: 先用 /task orig "<需求>" 创建台账,或显式传入 taskId。');
        return { message: '无可展示的任务' };
      }
      const state = store.get(taskId);
      if (!state) {
        ctx.renderer.warn(`task 台账不存在: ${taskId}`);
        ctx.renderer.info('提示: 用 /task orig "<需求>" 创建台账。');
        return { message: 'task 未找到' };
      }
      for (const ln of formatTaskStatus(state)) ctx.renderer.writeLine(ln);
      return { data: state };
    }

    // --- risks(纯读)---
    if (sub === 'risks') {
      const taskId = rest[0] ?? ctx.session?.currentTaskId;
      if (!taskId) {
        ctx.renderer.warn('未指定 taskId 且 session 未绑定当前任务。');
        ctx.renderer.info('用法: /task risks [taskId]');
        return { message: '无可展示的风险' };
      }
      const state = store.get(taskId);
      if (!state) {
        ctx.renderer.warn(`task 台账不存在: ${taskId}`);
        ctx.renderer.info('提示: 用 /task orig "<需求>" 创建台账。');
        return { message: 'task 未找到' };
      }
      for (const ln of formatTaskRisks(state)) ctx.renderer.writeLine(ln);
      return { data: { taskId, risks: state.risks } };
    }

    // --- next(纯读 + 5 档推导)---
    if (sub === 'next') {
      const taskId = rest[0] ?? ctx.session?.currentTaskId;
      if (!taskId) {
        ctx.renderer.warn('未指定 taskId 且 session 未绑定当前任务。');
        ctx.renderer.info('用法: /task next [taskId]');
        return { message: '无可推断的任务' };
      }
      const state = store.get(taskId);
      if (!state) {
        ctx.renderer.warn(`task 台账不存在: ${taskId}`);
        ctx.renderer.info('提示: 用 /task orig "<需求>" 创建台账。');
        return { message: 'task 未找到' };
      }
      const derived = deriveNext(state);
      for (const ln of formatTaskNext(state, derived ?? undefined)) ctx.renderer.writeLine(ln);
      if (!state.nextStep && !derived) {
        // UNKNOWN 态额外走 info 通道让提示更显眼(测试也用 info 断言)
        ctx.renderer.info('提示: 用 /task decide "<下一步>" 显式设定。');
      }
      return { data: { taskId, nextStep: state.nextStep, derived: derived ?? null } };
    }

    // --- decide(写,严格走 update)---
    // R5 契约纪律:decide 走 update 不走 applyEvents。
    // applyEvents 仅用于 AgentEvent 流折叠;用户决策不是 AgentEvent,无需走折叠路径。
    if (sub === 'decide') {
      // 入参解析(仿 RunCommand shell-token):先按 session.currentTaskId 兜底成 taskId,
      // 再探测 rest[0] 是否实际是 taskId(已在 store 里),不是则视为 what。
      const fallbackTaskId = ctx.session?.currentTaskId;
      let taskId: string | undefined = fallbackTaskId;
      let what: string | undefined;
      let why: string | undefined;

      if (fallbackTaskId && rest.length === 0) {
        // 只有 taskId,没有内容 → 拒绝
        ctx.renderer.warn('用法: /task decide "<what>" ["why"]');
        ctx.renderer.info('提示: 必须传入决策内容(what)。why 可选。');
        return { message: '决策内容为空' };
      }

      if (rest.length >= 1) {
        // 探测:rest[0] 是否为已知 taskId
        const probe = store.get(rest[0]);
        if (probe) {
          // 形态 A:taskId what [why]
          taskId = rest[0];
          what = rest[1];
          why = rest[2];
        } else {
          // 形态 B:what [why](taskId 走 session 兜底)
          what = rest[0];
          why = rest[1];
        }
      }

      if (!taskId) {
        ctx.renderer.warn('未指定 taskId 且 session 未绑定当前任务。');
        ctx.renderer.info('用法: /task decide "<what>" ["why"]');
        ctx.renderer.info('       /task decide <taskId> "<what>" ["why"]');
        return { message: 'taskId 未指定' };
      }

      if (!what || what.trim().length === 0) {
        ctx.renderer.warn('决策内容不能为空。');
        ctx.renderer.info('用法: /task decide "<what>" ["why"]');
        return { message: '决策内容为空' };
      }

      const state = store.get(taskId);
      if (!state) {
        ctx.renderer.warn(`task 台账不存在: ${taskId}`);
        ctx.renderer.info('提示: 用 /task orig "<需求>" 创建台账。');
        return { message: 'task 未找到' };
      }

      // 写盘:严格走 update(不调 applyEvents)
      const decisionWhat = what.trim();
      const decisionWhy = why?.trim() || undefined;
      const beforeVersion = state.version;
      const updated = store.update(taskId, (cur) => ({
        ...cur,
        decisions: [
          ...cur.decisions,
          {
            ts: Date.now(),
            what: decisionWhat,
            ...(decisionWhy ? { why: decisionWhy } : {}),
          },
        ],
      }));

      // 行内确认
      ctx.renderer.success(
        `decision 已写入 ${taskId} (version ${beforeVersion} → ${updated.version}):`,
      );
      const latest = updated.decisions[updated.decisions.length - 1];
      const whySuffix = latest.why ? ` · why=${latest.why}` : '';
      // 时间戳复用 fmtTs 直接走 renderer 风格——保持与 status/risks 一致
      const pad = (n: number) => String(n).padStart(2, '0');
      const d = new Date(latest.ts);
      const tsStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      ctx.renderer.writeLine(`  - [${tsStr}] ${latest.what}${whySuffix}`);
      ctx.renderer.info('提示: 用 /task status 查看完整台账。');

      return { data: updated };
    }

    // 未知子命令 / 空入参:打 usage。
    ctx.renderer.writeLine('用法: ' + command.usage);
    return { message: '未知子命令' };
  },
};

export default command;