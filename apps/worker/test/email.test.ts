// BE-R2: send-email failures must be redacted before they are logged or
// thrown — the upstream Resend response body (which can echo credential/config
// details) must never appear in the error message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendEmail } from '../src/lib/email.ts';
import { makeEnv } from './helpers/app.ts';

const SECRET = 'SUPER-SECRET-UPSTREAM-BODY';

test('sendEmail: Resend 失败不把响应正文带进错误信息 (BE-R2)', async (t) => {
  const ctx = makeEnv();
  ctx.db
    .prepare("UPDATE settings SET value = ?1 WHERE key = 'resend_api_key'")
    .bind('test-api-key')
    .run();
  ctx.db
    .prepare("UPDATE settings SET value = ?1 WHERE key = 'email_from_domain'")
    .bind('example.com')
    .run();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: SECRET }), { status: 500 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () =>
      sendEmail(ctx.env, {
        to: 'user@example.com',
        subject: 'hi',
        html: '<p>hi</p>',
      }),
    (err: Error) => {
      assert.ok(!err.message.includes(SECRET), '错误信息泄露了上游响应正文');
      return true;
    },
  );
});
