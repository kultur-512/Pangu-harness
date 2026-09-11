// src/memory/trajectoryFiles.ts
// 共享的"轨迹写集提取器"——从 trajectory steps[].action 提取本次写入/编辑的
// 文件路径。此前 runAgentTask（已验证正确版）与 RefinedMemoryStore（只认旧
// {name/tool,args} 形状、对真实 {toolName,params:[{name,value}]} 恒提取空）
// 各持一份实现，导致 refine 产卡 referencedFiles 恒空 → 引用过滤与
// markVerified 全断。现收敛为单一实现，refine 与 finalizeTaskMemory 共用
// （S 级缺陷修复：卡片 referencedFiles 断链）。
//
// action 实际是 ToolCall[]（{ toolName, params: [{name,value}] }，见
// src/types/toolCall.ts + PanshalachChaser 的 traj.steps 映射）；兼容旧
// {name/tool, args/parameters} 形状与 bash 重定向/tee，保证交集判定不因形状漏文件。

/**
 * 从轨迹 steps[].action 提取 write/edit 类工具的目标文件路径。
 * （原 runAgentTask.extractWrittenFilePaths，行为契约见
 * tests/server/Resilience073.test.ts 的"写集提取修正则"一节。）
 */
export function extractWrittenFilePaths(traj: any): string[] {
  const out = new Set<string>();
  for (const step of traj?.steps ?? []) {
    const actions: any[] = Array.isArray(step?.action) ? step.action : (step?.action ? [step.action] : []);
    for (const act of actions) {
      if (!act) continue;
      const name = String(act.toolName ?? act.name ?? act.tool ?? act.type ?? '').toLowerCase();
      let args: any = act.args ?? act.parameters;
      if (!args && Array.isArray(act.params)) {
        args = Object.fromEntries(
          act.params.filter((p: any) => p && p.name).map((p: any) => [p.name, p.value])
        );
      }
      args = args ?? {};
      if (name.includes('write') || name.includes('edit') || name.includes('multiedit')) {
        const fp = args.file_path ?? args.path ?? args.filePath ?? args.target_file ?? args.target ?? args.file;
        if (typeof fp === 'string' && fp) out.add(fp);
      }
      // bash 重定向（> / >>）与 tee 也算写入
      if (name.includes('bash') || name.includes('command') || name === 'run') {
        const cmd = String(args.command ?? args.cmd ?? '');
        for (const t of extractShellWriteTargets(cmd)) out.add(t);
      }
    }
  }
  return Array.from(out);
}

/**
 * 从 shell 命令提取写目标（重定向 + tee）。覆盖三个历史漏判/误判：
 *   1) 引号内空格：`> "my file.txt"` 旧正则截成 `my` → 现按引号对整体捕获；
 *   2) Windows 盘符：`> C:\dir\a.txt` 目标 token 排除集不含 `:` `\` `/`，整体保留
 *      （不再被截成 `C:` 一类的碎片）；
 *   3) tee / tee -a：旧正则完全不识别 → 现按管道段解析 tee 的文件参数。
 * fd 前缀（2> / 2>>）一并处理；`2>&1` 因目标含 `&` 被排除集挡下，不会误收。
 * best-effort：漏判比误判更伤记忆交集，排除集从严（空白/引号/&|;()<>）。
 */
export function extractShellWriteTargets(cmd: string): string[] {
  const out = new Set<string>();
  const unquote = (t: string): string => {
    const m = t.match(/^"([^"]*)"$/) || t.match(/^'([^']*)'$/);
    return m ? m[1] : t;
  };

  // 重定向目标：`>` / `>>`（允许 fd 前缀如 2>）。目标 = 双引号串 | 单引号串 | 裸 token。
  const reRedirect = /\d??>{1,2}\s*("[^"]*"|'[^']*'|[^\s"'&|;()<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = reRedirect.exec(cmd)) !== null) {
    const t = unquote(m[1]);
    if (t && t !== '/dev/null') out.add(t);
  }

  // tee：按管道/分号切段，段首为 `tee`（可带 flag，如 -a）→ 后续非 flag token 都是写目标
  for (const seg of cmd.split(/[|;&\n]/)) {
    const segTrim = seg.replace(/^\s*!?\s*(?:sudo\s+)?/i, '');
    if (!/^tee(\s|$)/i.test(segTrim)) continue;
    const tokens = segTrim.replace(/^tee\b\s*/i, '').match(/"[^"]*"|'[^']*'|[^\s"]+/g) ?? [];
    for (const tok of tokens) {
      if (/^-/.test(tok)) continue; // flags：-a / --append
      const t = unquote(tok);
      if (t && t !== '/dev/null') out.add(t);
    }
  }
  return Array.from(out);
}

/** 写集/引用交集统一归一（\→/、去 ./ 前缀、小写），保证可比。（原
 * runAgentTask.normalizeRelPath 与 RefinedMemoryStore.normPath 的共享版。） */
export function normalizeRelPath(p: string): string {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
}
