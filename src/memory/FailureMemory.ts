// FailureMemory - 失败信号分类类型（会话内失败信号记忆的类别定义）
// 失败记忆轨道（FailureMemory 类 / GenerativeTestEngine）已摘除归档
// （archive/2026-09-05-removals/）；此处仅保留 FailureCategory 类型，
// 供 MemoryCommand / RefinedMemoryCard / RefinedMemoryStore 引用。

export type FailureCategory =
  | 'HALLUCINATED_FILE'
  | 'HALLUCINATED_FUNCTION'
  | 'HALLUCINATED_BEHAVIOR'
  | 'TOOL_FORMAT_ERROR'
  | 'LOOSE_FORMAT_USED'
  | 'READ_BEFORE_WRITE_VIOLATION'
  | 'WEAK_VERIFICATION'
  | 'NO_VERIFICATION_BEFORE_CLAIM'
  | 'OVERCONFIDENCE'
  | 'SKIPPED_PLAN'
  | 'SKIPPED_READ'
  | 'CONTEXT_LOSS'
  | 'BAD_CRITIQUE'
  | 'COMMAND_FAILED'
  | 'STATE_MISMATCH'
  | 'WORKFLOW_STEP_ERROR'
  | 'DATA_TRANSFORM_ERROR'
  | 'TERMINAL_NO_CHECK_AFTER_COMMAND'
  | 'AUTOMATION_NO_EFFECT_VERIFICATION'
  | 'OTHER';
