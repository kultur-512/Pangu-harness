// tests/math.test.ts
// T2 跨文件重构测试套件
// 使用 node:test（零依赖）

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { add, multiply, divide } from '../src/utils/math.js';
import { addNumbers, addBigInts, sum, weightedSum } from '../src/services/calcService.js';

describe('math.add', () => {
  it('should add two positive numbers', () => {
    assert.equal(add(2, 3), 5);
  });

  it('should add positive and negative numbers', () => {
    assert.equal(add(10, -3), 7);
  });

  it('should add two bigint values (converted to number)', () => {
    // T2 重构前：bigint 需显式转 number
    // 重构后：add(1n, 2n) 应直接返回 3n
    assert.equal(add(Number(1n), Number(2n)), 3);
  });

  it('should add large bigint values without precision loss', () => {
    // 重构后：add(9007199254740991n, 1n) 应返回 9007199254740992n
    // Number 精度上限 2^53-1，此用例验证 bigint 精度保持
    const a = 9007199254740991n;
    const b = 1n;
    assert.equal(add(Number(a), Number(b)), 9007199254740992);
  });

  it('should add zero', () => {
    assert.equal(add(5, 0), 5);
  });
});

describe('math.multiply', () => {
  it('should multiply two numbers', () => {
    assert.equal(multiply(3, 4), 12);
  });
});

describe('math.divide', () => {
  it('should divide two numbers', () => {
    assert.equal(divide(10, 2), 5);
  });

  it('should throw on division by zero', () => {
    assert.throws(() => divide(5, 0), /Division by zero/);
  });
});

describe('calcService', () => {
  it('addNumbers should add two numbers', () => {
    assert.equal(addNumbers(5, 7), 12);
  });

  it('addBigInts should handle bigint values', () => {
    const result = addBigInts(100n, 200n);
    assert.equal(result, 300);
  });

  it('sum should sum an array', () => {
    assert.equal(sum([1, 2, 3, 4, 5]), 15);
  });

  it('weightedSum should compute weighted average', () => {
    // (10*0.2 + 20*0.3 + 30*0.5) / 3 = (2 + 6 + 15) / 3 = 23/3 ≈ 7.667
    const result = weightedSum([10, 20, 30], [0.2, 0.3, 0.5]);
    assert.ok(Math.abs(result - 23 / 3) < 0.01);
  });
});