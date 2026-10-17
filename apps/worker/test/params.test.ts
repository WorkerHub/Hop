import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PAGE, parseIntParam, parsePagination } from '../src/lib/params.ts';

test('parseIntParam falls back on missing or non-numeric input (BE-C1)', () => {
  assert.equal(parseIntParam(undefined, 30, 1, 365), 30);
  assert.equal(parseIntParam('', 30, 1, 365), 30);
  assert.equal(parseIntParam('abc', 30, 1, 365), 30);
  assert.equal(parseIntParam('NaN', 30, 1, 365), 30);
  assert.equal(parseIntParam('Infinity', 30, 1, 365), 30);
});

test('parseIntParam clamps numeric input to [min, max]', () => {
  assert.equal(parseIntParam('7', 30, 1, 365), 7);
  assert.equal(parseIntParam('0', 30, 1, 365), 1);
  assert.equal(parseIntParam('-5', 30, 1, 365), 1);
  assert.equal(parseIntParam('1000', 30, 1, 365), 365);
  assert.equal(parseIntParam('99999999999999999999999', 30, 1, 365), 365);
});

test('parsePagination never yields NaN and keeps offset a safe integer', () => {
  assert.deepEqual(parsePagination(undefined, undefined, 50), {
    page: 1,
    limit: 20,
    offset: 0,
  });
  assert.deepEqual(parsePagination('abc', 'xyz', 50), {
    page: 1,
    limit: 20,
    offset: 0,
  });
  assert.deepEqual(parsePagination('3', '10', 50), {
    page: 3,
    limit: 10,
    offset: 20,
  });
  assert.deepEqual(parsePagination('2', '500', 100), {
    page: 2,
    limit: 100,
    offset: 100,
  });

  const huge = parsePagination('1e400', '1e400', 100);
  assert.equal(huge.page, 1); // parseInt stops at 'e'
  const big = parsePagination('9'.repeat(30), '100', 100);
  assert.equal(big.page, MAX_PAGE);
  assert.ok(Number.isSafeInteger(big.offset));
});
