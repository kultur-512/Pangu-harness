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

// T6（openPangu 配合度修复）：补检索/枚举类动词——实证"列出 src 文件"/"搜 TODO"
// 被误判 chat → 零动作记 success（假完成）。疑问/文创否定启发在前，chat 类提问
// （"什么是查找算法"/"how do I find..."）不受影响。
// 英文动词段加 \b 词边界（消除 researching(list⊂)/listening(search⊂) 过捕）；
// 中文段不加（CJK 相邻处无词边界，加了会使"列出文件"失配）。
const EXECUTION_VERBS =
  /(创建|修改|删除|修复|重构|实现|添加|新增|优化|测试|构建|编译|安装|部署|生成|运行|读取|写入|执行|完成|继续|接着|处理|搞定|收尾|补全|列出|列举|搜索|查找|查看|改|写|建|加|删|跑|测)|(\b(?:build|test|compile|install|deploy|generate|refactor|implement|create|fix|add|delete|remove|run|write|read|edit|change|update|continue|finish|resume|list|search|find)\b)/i;

/** 文件后缀 token（无执行动词时触发 search）。 */
const FILE_EXT_RE = /\b[A-Za-z0-9_.\-/\\]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|cpp|c|h|txt|yaml|yml|toml|sh|css|html|sql)\b/i;

/** @path 引用（视为执行/搜索素材）。 */
const AT_PATH_RE = /@[^\s"'`]+/;

/** 常见问候/纯对话/情绪/无宾语输入——显式排除出执行/搜索。 */
const CHAT_GREETING =
  /^(你好|您好|嗨|hi|hello|hey|在吗|谢谢|thanks?|早上好|晚上好|再见|拜拜)[\s!！。.,，]*$/i;

const CHAT_SELF_QUESTION =
  /(你是谁|你是谁啊|你叫什么|介绍一下你自己|what are you|who are you|自我介绍)/i;

/** R7（0.8.2）：英文疑问引导词开头（LongMemEval 接入驱动：英文疑问句大多无
 *  '?' 结尾，旧正则漏判——"What was the first issue I had..." 类提问被
 *  动词启发误判 execution）。疑问词开头 = 提问，除非带明确文件引用。 */
const EN_INTERROGATIVE_RE = /^(what|when|where|who|whom|whose|which|why|how)\b/i;

/** R7（0.8.2）：第一人称经历回忆（中英）——问的是用户自己的历史，
 *  属对话问答（个人化记忆场景），不进执行循环。 */
const FIRST_PERSON_RECALL_RE = /(我(的|曾|有|在|什么时候|哪个|多少|第一次|最近))|\b(did|do|have|has)\s+i\b|\b(my|our)\s+(first|last|new|old|current)\b/i;

/** R5（0.8.1）：文创/文字润饰类宾语——写诗/优化表达等纯文本创作（无文件参照时 → chat 直答）。 */
const TEXT_CRAFT_RE = /(一首|诗|歌词|对联|谜语|故事|小说|散文|作文|文案|表达|措辞|润色)/;

// ==================== 0.8.8 意图分类重做（CC 风格：默认 execution） ====================
// 旧启发式"默认 chat、命中关键词才 execution"漏判严重（"整理本文件夹内容"因
// "整理"不在动词表被判 chat → 模型直答"好的，有什么可以帮您吗？"而不执行）。
// 重做为 CC/Hermes 风格：默认进执行循环（agent 自己决定调不调工具）；疑问豁免
// （什么/怎么/吗等）与执行信号判定保持旧行为不变，只翻转默认值。

/** 疑问/概念提问豁免（旧行为保持）：句中疑问词或句尾"吗"→ 不进执行循环。 */
const QUESTION_MARK_RE = /(什么|怎么|怎样|为何|区别|差异|[?？])|吗[\s?？!！。.]*$/;

/** 日期/时间询问（"今天几号"/"现在几点"）——chat 直答（system 指令已带"今天是 X"）。 */
const DATE_QUESTION_RE = /(?:今天|现在|昨天|明天|当前).*(?:几号|几点|周几|星期几|日期|时间)|(?:几号|几点|周几|星期几)[?？]?$/;

/** 查看目录/文件结构类请求（"看下这个文件夹是什么结构"）——查看动词 +
 *  文件系统对象，是执行请求（glob/ls 看结构），即使含疑问词也不判 chat。 */
const LOOK_AT_FS_RE = /(看下|看看|查看|分析).*(文件夹|目录|文件|项目|工作区|仓库)/;

/** 显式写/续接请求 + 文件参照 = execution（"能在 memo.txt 里加一行吗"仍是写请求）。 */
const EXPLICIT_WRITE_RE = /(写入|添加|改成|创建|新建|加上|加一行|写一行|写两行|补全|完成|继续|接着|搞定|收尾|落盘)/;

/** 纯数字/标点等无信息输入（"1"）——chat 直答，不进执行循环白烧步数。 */
const NOISE_RE = /^[\d\s.!！。.,，]*$/;

/** 语气词结尾的追问/确认（"那第二个呢"/"然后呢"）——chat 直答（带最近对话上下文），
 *  不进执行循环（旧版靠"默认 chat"兜住这类指代型追问，默认翻转后需显式白名单）。 */
const INTERJECTION_TAIL_RE = /[呢吧嘛咯啊呀][?？!！。.]*$/;

/** 本地元命令前缀（斜杠/simulate 前缀，理论上入口已预处理，这里兜底）。
 *  R5（0.8.1）：`^r(un)?\s` 从意图分类移除——"run npm install 会发生什么"这类
 *  疑问句曾被 meta 劫持成实际执行。run 命令别名语义只在交互层本地命令派发
 *  （handleLocalCommand/命令注册表）有意义，不进意图分类。 */
function isMeta(input: string): boolean {
  const t = input.trim();
  if (t.startsWith('/')) return true;
  if (/^s(imulate)?\s+/i.test(t)) return true;
  return false;
}

/**
 * 分类任务意图（0.8.8 重做：默认 execution）。
 * 顺序：meta → chat 白名单（问候/自我询问/英文疑问/第一人称回忆/纯概念提问/
 * 日期询问/文创）→ 执行信号（强工具词/执行动词/@path/显式写+文件/查看目录）→
 * 无执行信号的疑问（句尾确认/句中疑问词）→ 文件后缀 search → **默认 execution**。
 */
export function classifyTaskIntent(input: string): TaskIntent {
  if (process.env.PANSHA_INTENT_GATE === '0') return 'execution';

  const t = String(input ?? '').trim();
  if (!t) return 'chat';

  if (isMeta(t)) return 'meta';

  const hasFileRef = FILE_EXT_RE.test(t);

  // ===== chat 白名单（明确的闲聊/提问/文创，不进执行循环）=====
  // 纯问候 / 自我询问（优先级最高，避免"你好，回答我你是谁"误判）
  if (CHAT_GREETING.test(t)) return 'chat';
  if (CHAT_SELF_QUESTION.test(t)) return 'chat';
  // 英文疑问引导词开头 / 第一人称经历回忆（LongMemEval 记忆问答）——
  // 含文件引用仍走 search 先只读确认
  if (EN_INTERROGATIVE_RE.test(t) || FIRST_PERSON_RECALL_RE.test(t)) {
    return hasFileRef ? 'search' : 'chat';
  }
  // 日期/时间询问
  if (DATE_QUESTION_RE.test(t)) return 'chat';

  // ===== 明确的执行请求（疑问豁免之前——"看文件夹结构"仍是执行）=====
  // 查看目录/文件结构（"看下这个文件夹是什么结构"）
  if (LOOK_AT_FS_RE.test(t)) return 'execution';
  // 显式写/续接请求 + 文件参照（"能在 memo.txt 里加一行吗"仍是写请求）
  if (EXPLICIT_WRITE_RE.test(t) && hasFileRef) return 'execution';

  // ===== 疑问/概念提问豁免（旧行为保持）：句中疑问词/句尾"吗"→ 不进执行 =====
  if (QUESTION_MARK_RE.test(t)) {
    return hasFileRef ? 'search' : 'chat';
  }

  // 文创/文字润饰（无文件参照）
  if (!hasFileRef && TEXT_CRAFT_RE.test(t)) return 'chat';

  // 执行信号（强工具词/执行动词/@path）→ execution
  if (EXECUTION_WORDS.test(t) || EXECUTION_VERBS.test(t) || AT_PATH_RE.test(t)) {
    return 'execution';
  }

  // 无动词但含文件后缀/path token → search（先搜索，搜不到询问）
  if (hasFileRef) return 'search';

  // 纯数字/标点等无信息输入（"1"）→ chat
  if (NOISE_RE.test(t)) return 'chat';

  // 语气词结尾的追问/确认（"那第二个呢"）→ chat（带最近对话上下文直答）
  if (INTERJECTION_TAIL_RE.test(t)) return 'chat';

  // ===== 默认：execution（CC 风格——让 agent 自己决定是否调工具）=====
  return 'execution';
}
