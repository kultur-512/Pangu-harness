// src/utils/math.ts
// 基础数学工具函数
// T2 任务：将 add 签名从 number 扩展为 number | bigint

export function add(a: number | bigint, b: number | bigint): number | bigint {
  if (typeof a !== typeof b) {
    throw new TypeError('Cannot mix number and bigint operands');
  }
  return (a as any) + (b as any);
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero');
  return a / b;
}
