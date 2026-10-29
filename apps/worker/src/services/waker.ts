// Waker callback wiring: the platform's POST /_waker/execute → the very same
// nightly cleanup the native Cron Trigger runs (src/services/cleanup.ts).
//
// Contract (frozen by the waker migration contract, spec v1.0 §2):
//   - one business function for both entries — this file adds no cleanup logic;
//   - the handler awaits the cleanup to completion before returning, so the SDK
//     only answers 2xx after the work really ran (never waitUntil + early OK);
//   - verification, replay window and error codes live in the vendored SDK
//     (src/waker/), never re-implemented here;
//   - `executionId` deduplication uses hop's own D1 table
//     `{prefix}waker_executions` (schema_v3), derived through tbl() so
//     TABLE_PREFIX stays the single source of truth.

import { tbl } from '../lib/db.js';
import type { Env } from '../types.js';
import {
  createD1ExecutionLedger,
  createWakerReceiver,
} from '../waker/index.js';
import { runCleanup } from './cleanup.js';

/**
 * The job name registered in the waker management UI. It must match **exactly**
 * — the receiver dispatches by name and answers 404 `unknown_job` otherwise.
 */
export const WAKER_JOB_NIGHTLY_CLEANUP = 'nightly-cleanup';

/**
 * The declarative cron expression of the nightly cleanup — the only schedule hop
 * has left. The job is created by hand in the waker UI with this value (CF cron
 * dialect, UTC), so it is also what the README's job table freezes; nothing in
 * hop rewrites it. wrangler.toml declares `[triggers] crons = []`, which removes
 * the native Cron Trigger on every deploy — waker is the only scheduler.
 */
export const WAKER_JOB_CRON = '0 3 * * *';

/** Suffix of the SDK's executionId ledger table; the prefix comes from tbl(). */
export const WAKER_EXECUTIONS_TABLE = 'waker_executions';

/**
 * Build a receiver bound to this request's env.
 *
 * The signing key is read by the SDK from `env.WAKER_SIGNING_KEY` (secrets
 * only) and is the integration's only switch: present → verify then run this
 * handler; absent → the SDK fails closed with 500 `signing_key_missing`, so it
 * never runs a job that could not be verified.
 *
 * Built per request because the ledger table name depends on TABLE_PREFIX and
 * the key on the bindings, both only known at request time. Construction does
 * no I/O and callbacks arrive once a day, so this costs nothing measurable.
 */
export function createWakerCallbackReceiver(env: Env) {
  return createWakerReceiver({
    jobs: {
      [WAKER_JOB_NIGHTLY_CLEANUP]: async (context) => {
        const result = await runCleanup(env);
        // Structured, credential-free observability: counts + duration.
        console.info(
          JSON.stringify({
            level: 'info',
            event: 'nightly_cleanup',
            source: 'waker',
            jobName: context.jobName,
            executionId: context.executionId,
            attempt: context.attempt,
            ...result,
          }),
        );
        return { cleanup: result };
      },
    },
    ledger: createD1ExecutionLedger(env.DB, {
      table: tbl(env, WAKER_EXECUTIONS_TABLE),
    }),
    // The SDK releases the ledger claim and answers 5xx so the platform retries
    // with the same executionId; log why it failed instead of swallowing it.
    onJobError: (error, context) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'nightly_cleanup_failed',
          source: 'waker',
          jobName: context.jobName,
          executionId: context.executionId,
          attempt: context.attempt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });
}
