// src/main.ts
// 主入口——间接调用 calcService

import { addNumbers, addBigInts, sum, weightedSum } from './services/calcService.js';

function main() {
  // 基本加法
  const r1 = addNumbers(10, 20);
  console.log('addNumbers(10, 20) =', r1);

  // 大整数加法（重构前为 number 包装）
  const r2 = addBigInts(100n, 200n);
  console.log('addBigInts(100n, 200n) =', r2);

  // 数组求和
  const r3 = sum([1, 2, 3, 4, 5]);
  console.log('sum([1,2,3,4,5]) =', r3);

  // 加权求和
  const r4 = weightedSum([10, 20, 30], [0.2, 0.3, 0.5]);
  console.log('weightedSum([10,20,30], [0.2,0.3,0.5]) =', r4);
}

main();