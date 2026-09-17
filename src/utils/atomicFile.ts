// src/utils/atomicFile.ts
// 原子写盘共享实现（包C 缺陷4 修复，2026-09-13）。
//
// 蓝本：src/memory/taskState.ts 的 commitAtomic（R5 落地合同）——同目录 tmp +
// renameSync + 失败清理。rename 在同一目录内是原子的；tmp 名带进程号防并发写
// 串扰。RefinedMemoryStore 的 7 处 writeFileSync（save/markVerified/clear/import/
// forget/refineCompactSignals/mergeSimilarCards）与 taskState 全部经此落盘：
// 写盘中途崩溃绝不留半截文件；rename 失败时清理 tmp 并上抛原始错误——
// 目标文件保持旧内容。
//
// 注：fs 经默认导出对象属性调用（fs.renameSync(...)），使 node:test 的
// mock.method(fs, 'renameSync', ...) 可注入失败（ESM 具名导入绑定不可 mock）。
import fs from 'node:fs';

/** 测试/特殊调用方可注入的底层依赖（缺省 = 真实 fs，utf-8）。 */
export interface AtomicWriteDeps {
  writeFileSync?: (path: string, data: string) => void;
  renameSync?: (from: string, to: string) => void;
  rmSync?: (path: string) => void;
}

export function atomicWriteFileSync(filePath: string, data: string, deps: AtomicWriteDeps = {}): void {
  const doWrite = deps.writeFileSync ?? ((p: string, d: string) => fs.writeFileSync(p, d, 'utf-8'));
  const doRename = deps.renameSync ?? ((from: string, to: string) => fs.renameSync(from, to));
  const doRm = deps.rmSync ?? ((p: string) => fs.rmSync(p, { force: true }));
  // 同目录 tmp（rename 原子性要求同卷；带进程号防并发写串扰）
  const tmp = `${filePath}.${process.pid}.tmp`;
  doWrite(tmp, data);
  try {
    doRename(tmp, filePath);
  } catch (err) {
    // rename 失败：清理 tmp（best-effort），目标文件保持旧内容，原始错误上抛
    try { doRm(tmp); } catch { /* 清理失败不掩盖原始错误 */ }
    throw err;
  }
}
