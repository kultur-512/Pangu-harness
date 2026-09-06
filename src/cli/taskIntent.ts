// src/cli/taskIntent.ts
// 入口轻量意图分类（0.7）：在提交任务前判断"这是工程执行任务，还是纯对话，
// 还是只读搜索，还是本地元命令"。分类只影响 prompt 组装与执行路径——
// chat 走单次 complete 直接回答（不进 agent 循环），search 走受限只读搜索
// （搜不到就询问用户具体用意），execution 走完整验证循环。
//
// 纯函数、无 IO；PANSHA_INTENT_GATE=0 逃生门关闭分类（全部按 execution 兜底）。

export type TaskIntent = 'execution' | 'search' | 'chat' | 'meta';

/** 强工程执行动词/工具/命令触发词（命中即 execution）。 */
const EXECUTION_WORDS =
  /(read_file|write_file|edit_file|\bbash\b|\bglob\b|\bgrep\b|\bgit\b|\bnpm\b|\bnpx\b|\bnode\b|\btsc\b|\bpython\b|\bpytest\b|\bcargo\b|\bgo\b|\bmake\b)/i;

const EXECUTION_VERBS =
  /(创建|修改|删除|修复|重构|实现|添加|新增|优化|测试|构建|编译|安装|部署|生成|运行|读取|写入|执行|改|写|建|加|删|跑|测|build|test|compile|install|deploy|generate|refactor|implement|create|fix|add|delete|remove|run|write|read|edit|change|update)/i;

/** 文件后缀 token（无执行动词时触发 search）。 */
const FILE_EXT_RE = /\b[A-Za-z0-9_.\-/\\]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|cpp|c|h|txt|yaml|yml|toml|sh|css|html|sql)\b/i;

/** @path 引用（视为执行/搜索素材）。 */
const AT_PATH_RE = /@[^\s"'`]+/;

/** 常见问候/纯对话/情绪/无宾语输入——显式排除出执行/搜索。 */
const CHAT_GREETING =
  /^(你好|您好|嗨|hi|hello|hey|在吗|谢谢|thanks?|早上好|晚上好|再见|拜拜)[\s!！。.,，]*$/i;

const CHAT_SELF_QUESTION =
  /(你是谁|你是谁啊|你叫什么|介绍一下你自己|what are you|who are you|自我介绍)/i;

/** 本地元命令前缀（斜杠命令/run/simulate 前缀，理论上入口已预处理，这里兜底）。 */
function isMeta(input: string): boolean {
  const t = input.trim();
  if (t.startsWith('/')) return true;
  if (/^r(un)?\s+/i.test(t)) return true;
  if (/^s(imulate)?\s+/i.test(t)) return true;
  return false;
}

/**
 * 分类任务意图。
 * 顺序：meta → execution（强动词/工具/命令/@path）→ search（文件后缀无动词）→ chat。
 */
export function classifyTaskIntent(input: string): TaskIntent {
  if (process.env.PANSHA_INTENT_GATE === '0') return 'execution';

  const t = String(input ?? '').trim();
  if (!t) return 'chat';

  if (isMeta(t)) return 'meta';

  // 纯问候 / 自我询问 → chat（优先级最高，避免"你好，回答我你是谁"误判）
  if (CHAT_GREETING.test(t)) return 'chat';
  if (CHAT_SELF_QUESTION.test(t)) return 'chat';

  // 强工程触发词 → execution
  if (EXECUTION_WORDS.test(t)) return 'execution';
  if (AT_PATH_RE.test(t)) return 'execution';

  // 有明确操作动词 → execution
  if (EXECUTION_VERBS.test(t)) return 'execution';

  // 无动词但含文件后缀/path token → search（先搜索，搜不到询问）
  if (FILE_EXT_RE.test(t)) return 'search';

  return 'chat';
}
