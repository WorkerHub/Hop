import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { en } from '../i18n/locales/en.ts';
import { zhCN } from '../i18n/locales/zh-CN.ts';
import { API_ERROR_CODES } from './apiErrorCodes.ts';

// Verifies every backend error code the frontend knows maps to a real,
// non-empty string in both locales, so the "backend error → localized toast"
// path can never silently fall back to English for a known code.

function resolve(obj: unknown, path: string): unknown {
  let curr = obj;
  for (const p of path.split('.')) {
    if (curr == null || typeof curr !== 'object') return undefined;
    curr = (curr as Record<string, unknown>)[p];
  }
  return curr;
}

describe('API_ERROR_CODES', () => {
  test('every code maps to a non-empty string in both locales', () => {
    for (const [code, key] of Object.entries(API_ERROR_CODES)) {
      const enValue = resolve(en, key);
      const zhValue = resolve(zhCN, key);
      assert.equal(
        typeof enValue,
        'string',
        `${code} → ${key} must resolve to a string in en`,
      );
      assert.equal(
        typeof zhValue,
        'string',
        `${code} → ${key} must resolve to a string in zh-CN`,
      );
      assert.ok((enValue as string).length > 0, `${key} (en) is empty`);
      assert.ok((zhValue as string).length > 0, `${key} (zh-CN) is empty`);
    }
  });

  test('EMAIL_OR_USERNAME_TAKEN localizes in both languages', () => {
    assert.equal(
      resolve(en, 'errors.emailOrUsernameTaken'),
      'This email or username is already taken.',
    );
    assert.equal(
      resolve(zhCN, 'errors.emailOrUsernameTaken'),
      '该邮箱或用户名已被占用。',
    );
  });

  test('INVALID_CREDENTIALS localizes in both languages', () => {
    assert.equal(
      resolve(en, 'errors.invalidCredentials'),
      'Incorrect email or password.',
    );
    assert.equal(
      resolve(zhCN, 'errors.invalidCredentials'),
      '邮箱或密码不正确。',
    );
  });
});
