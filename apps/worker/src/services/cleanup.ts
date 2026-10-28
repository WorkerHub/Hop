// The nightly cleanup's business logic, written once and shared by both
// trigger paths: the native CF Cron Trigger (`scheduled()` in src/index.ts) and
// the waker callback (`/_waker/execute`, src/services/waker.ts).
//
// Both deletes stay exactly as they were before the waker migration: same
// tables (derived through tbl(), so TABLE_PREFIX still decides the names), same
// predicates, one D1 batch. This module only adds the counters the callback
// response and the logs need — it does not change what the cleanup does.

import { tbl } from '../lib/db.js';
import type { Env } from '../types.js';

export interface CleanupResult {
  /** Rows deleted from `{prefix}verifications` (expired verification codes). */
  verifications: number;
  /** Rows deleted from `{prefix}totp_used` (codes older than the 90s replay window). */
  totpUsed: number;
  /** Wall-clock duration of the batch, in milliseconds. */
  durationMs: number;
}

/**
 * L-2: delete expired verification rows and TOTP codes no longer needed for
 * replay protection.
 *
 * Predicates (frozen by the waker migration contract):
 *   - `{prefix}verifications`: `expires_at < unixepoch()`
 *   - `{prefix}totp_used`:     `used_at < unixepoch() - 90`  (90 **seconds**)
 *
 * No waitUntil and no try/catch on purpose: a failed batch rejects, so the cron
 * invocation fails and the waker callback answers 5xx (the platform retries)
 * instead of reporting a success that never happened.
 */
export async function runCleanup(
  env: Pick<Env, 'DB' | 'TABLE_PREFIX'>,
): Promise<CleanupResult> {
  const startedAt = Date.now();
  const [verifications, totpUsed] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM ${tbl(env, 'verifications')} WHERE expires_at < unixepoch()`,
    ),
    env.DB.prepare(
      `DELETE FROM ${tbl(env, 'totp_used')} WHERE used_at < unixepoch() - 90`,
    ),
  ]);
  return {
    verifications: verifications?.meta?.changes ?? 0,
    totpUsed: totpUsed?.meta?.changes ?? 0,
    durationMs: Date.now() - startedAt,
  };
}
