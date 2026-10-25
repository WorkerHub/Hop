// Three-state TABLE_PREFIX resolution (ONE-203 / ONE-205).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tbl } from '../src/lib/db.ts';
import {
  tbl as applyPrefix,
  DEFAULT_TABLE_PREFIX,
  resolveTablePrefix,
} from '../src/lib/table-prefix.ts';

test('默认前缀常量是 sl', () => {
  assert.equal(DEFAULT_TABLE_PREFIX, 'sl');
});

test('三态解析：未配置（undefined）→ 默认 sl', () => {
  assert.equal(resolveTablePrefix(undefined), 'sl');
});

test('三态解析：显式空字符串 → 无前缀', () => {
  assert.equal(resolveTablePrefix(''), '');
});

test('三态解析：自定义值原样保留（含大小写）', () => {
  assert.equal(resolveTablePrefix('SL'), 'SL');
  assert.equal(resolveTablePrefix('sl'), 'sl');
  assert.equal(resolveTablePrefix('ZETA'), 'ZETA');
});

test('三态解析：自定义值仅剔除非法字符，不改大小写', () => {
  assert.equal(resolveTablePrefix('SL-x'), 'SLx');
  assert.equal(resolveTablePrefix('a_b-c'), 'a_bc');
  assert.equal(resolveTablePrefix('x.y_z!'), 'xy_z');
});

test('tbl 在表名前补下划线，无前缀则原样返回', () => {
  assert.equal(applyPrefix('sl', 'users'), 'sl_users');
  assert.equal(applyPrefix('SL', 'users'), 'SL_users');
  assert.equal(applyPrefix('', 'users'), 'users');
  // 即使直接传入未清洗的前缀也保持安全
  assert.equal(applyPrefix('sl-x', 'users'), 'slx_users');
});

test('db.ts 的 tbl(env, name) 走同一三态解析', () => {
  assert.equal(tbl({ TABLE_PREFIX: undefined }, 'users'), 'sl_users');
  assert.equal(tbl({}, 'users'), 'sl_users');
  assert.equal(tbl({ TABLE_PREFIX: '' }, 'users'), 'users');
  assert.equal(tbl({ TABLE_PREFIX: 'SL' }, 'users'), 'SL_users');
});
