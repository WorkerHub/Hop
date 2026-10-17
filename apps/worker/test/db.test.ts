import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUniqueConstraintError } from '../src/lib/db.ts';

test('isUniqueConstraintError detects D1 UNIQUE violations (BE-C3)', () => {
  assert.equal(
    isUniqueConstraintError(
      new Error(
        'D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT',
      ),
    ),
    true,
  );
  assert.equal(
    isUniqueConstraintError(
      new Error('D1_ERROR', {
        cause: new Error('UNIQUE constraint failed: SL_users.username'),
      }),
    ),
    true,
  );
});

test('isUniqueConstraintError ignores other errors', () => {
  assert.equal(
    isUniqueConstraintError(
      new Error('D1_ERROR: NOT NULL constraint failed: users.password_hash'),
    ),
    false,
  );
  assert.equal(isUniqueConstraintError(new Error('network error')), false);
  assert.equal(isUniqueConstraintError('UNIQUE constraint failed'), false);
  assert.equal(isUniqueConstraintError(null), false);
});
