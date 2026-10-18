import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  expiresAtSeconds,
  expiryParts,
  isExpired,
  safeNextPath,
} from './utils.ts';

// FE-C5: expiry rendering must survive both second and millisecond timestamps,
// and report minutes (not "0h") for the last hour before expiry.

const NOW = Math.floor(Date.now() / 1000);

describe('expiresAtSeconds', () => {
  test('keeps second timestamps and converts millisecond ones', () => {
    assert.equal(expiresAtSeconds(1_700_000_000), 1_700_000_000);
    assert.equal(expiresAtSeconds(1_700_000_000_000), 1_700_000_000);
    assert.equal(expiresAtSeconds(null), null);
    assert.equal(expiresAtSeconds(0), null);
  });
});

describe('expiryParts', () => {
  test('reports minutes under an hour', () => {
    assert.deepEqual(expiryParts(NOW + 30 * 60), {
      kind: 'minutes',
      value: 30,
    });
  });

  test('never shows 0m for a link that has not expired', () => {
    assert.deepEqual(expiryParts(NOW + 5), { kind: 'minutes', value: 1 });
  });

  test('reports whole hours and days above an hour', () => {
    assert.deepEqual(expiryParts(NOW + 2 * 3600), { kind: 'hours', value: 2 });
    assert.deepEqual(expiryParts(NOW + 3 * 86400), { kind: 'days', value: 3 });
  });

  test('marks past deadlines as expired', () => {
    assert.deepEqual(expiryParts(NOW - 10), { kind: 'expired' });
  });

  test('treats a millisecond deadline the same as its second value', () => {
    const deadline = NOW + 30 * 60;
    assert.deepEqual(expiryParts(deadline * 1000), expiryParts(deadline));
  });

  test('isExpired accepts both units', () => {
    assert.equal(isExpired(NOW - 10), true);
    assert.equal(isExpired((NOW - 10) * 1000), true);
    assert.equal(isExpired(NOW + 600), false);
  });
});

describe('safeNextPath (FE-R5)', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    }
  });

  function withOrigin(origin: string) {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin } },
    });
  }

  test('accepts same-origin relative paths', () => {
    withOrigin('https://app.example');
    assert.equal(
      safeNextPath('/dashboard/analytics?linkId=1'),
      '/dashboard/analytics?linkId=1',
    );
  });

  test('rejects absolute, protocol-relative and backslash paths', () => {
    withOrigin('https://app.example');
    assert.equal(safeNextPath('https://evil.example/x'), null);
    assert.equal(safeNextPath('//evil.example'), null);
    assert.equal(safeNextPath('/\\evil.example'), null);
    assert.equal(safeNextPath('dashboard'), null);
    assert.equal(safeNextPath(null), null);
  });

  test('never returns the login page itself', () => {
    withOrigin('https://app.example');
    assert.equal(safeNextPath('/login'), null);
    assert.equal(safeNextPath('/login?next=/dashboard'), null);
  });
});
