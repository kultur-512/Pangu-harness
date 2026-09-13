// src/services/calcService.ts
// 计算服务层——调用 math.ts 的 add 函数

import { add, multiply, divide } from '../utils/math.js';

export function addNumbers(a: number, b: number): number {
  return add(a, b) as number;
}

export function addBigInts(a: bigint, b: bigint): bigint {
  return add(a, b) as bigint;
}

export function sum(arr: number[]): number {
  let total = 0;
  for (const n of arr) {
    total = add(total, n) as number;
  }
  return total;
}

export function weightedSum(values: number[], weights: number[]): number {
  if (values.length !== weights.length) {
    throw new Error('values and weights must have same length');
  }
  let result = 0;
  for (let i = 0; i < values.length; i++) {
    const weighted = multiply(values[i], weights[i]);
    result = add(result, weighted) as number;
  }
  return divide(result, values.length);
}
