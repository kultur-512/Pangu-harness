// src/services/calcService.ts
// 计算服务层——调用 math.ts 的 add 函数
// 至少 3 处 add() 调用点

import { add, multiply, divide } from '../utils/math.js';

/**
 * 两个数字相加（number 场景）
 */
export function addNumbers(a: number, b: number): number {
  return add(a, b); // 调用点 1
}

/**
 * 两个大整数相加（bigint 场景——待 T2 重构后启用）
 * 当前先用 Number() 包装，重构后直接传 bigint
 */
export function addBigInts(a: bigint, b: bigint): bigint {
  // 调用点 2：重构前 Number(a) + Number(b) 可能精度丢失
  return add(Number(a), Number(b)) as unknown as bigint;
}

/**
 * 数组求和（遍历调用 add）
 */
export function sum(arr: number[]): number {
  let total = 0;
  for (const n of arr) {
    total = add(total, n); // 调用点 3
  }
  return total;
}

/**
 * 加权求和
 */
export function weightedSum(values: number[], weights: number[]): number {
  if (values.length !== weights.length) {
    throw new Error('values and weights must have same length');
  }
  let result = 0;
  for (let i = 0; i < values.length; i++) {
    const weighted = multiply(values[i], weights[i]);
    result = add(result, weighted); // 调用点 4
  }
  return divide(result, values.length);
}