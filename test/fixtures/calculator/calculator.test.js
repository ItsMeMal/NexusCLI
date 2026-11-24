import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, subtract, multiply } from './calculator.js';

test('add adds two numbers correctly', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test('subtract subtracts numbers correctly', () => {
  assert.equal(subtract(10, 4), 6);
});

test('multiply multiplies numbers correctly', () => {
  assert.equal(multiply(3, 4), 12);
});
