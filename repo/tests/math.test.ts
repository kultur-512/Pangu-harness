// tests/math.test.ts
// T2 跨文件重构测试套件

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

  it('should add two bigint values', () => {
    assert.equal(add(1n, 2n), 3n);
  });

  it('should add large bigint values without precision loss', () => {
    assert.equal(add(9007199254740991n, 1n), 9007199254740992n);
  });

  it('should reject mixed number and bigint operands', () => {
    assert.throws(() => add(1, 2n), TypeError);
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

  it('addBigInts should preserve bigint values', () => {
    assert.equal(addBigInts(100n, 200n), 300n);
  });

  it('sum should sum an array', () => {
    assert.equal(sum([1, 2, 3, 4, 5]), 15);
  });

  it('weightedSum should compute weighted average', () => {
    const result = weightedSum([10, 20, 30], [0.2, 0.3, 0.5]);
    assert.ok(Math.abs(result - 23 / 3) < 0.01);
  });
});
