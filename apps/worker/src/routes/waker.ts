// HTTP side of the optional waker integration: mount the SDK's receiver at
// /_waker and answer an explicit 404 whenever the integration is off.
//
// Why the 404 matters: wrangler.toml serves the SPA with
// `not_found_handling = "single-page-application"`, so an unmounted
// /_waker/execute would fall through to the SPA and answer **200 HTML**.
// waker treats any 2xx as "execution succeeded", so that would silently report
// a nightly cleanup that never ran. Every non-waker state therefore answers a
// JSON 404 (spec v1.0 §2).
//
// "Off" means either WAKER_MODE is unset/`cron`, or WAKER_MODE=waker without
// WAKER_URL — a missing WAKER_URL closes the receiver instead of leaving a
// half-configured endpoint open, and the native trigger keeps working.

import { Hono } from 'hono';
import { apiError } from '../lib/errors.js';
import { createWakerCallbackReceiver } from '../services/waker.js';
import type { Env, Variables } from '../types.js';
import {
  CALLBACK_MOUNT_PATH,
  isWakerEnabled,
  readEnvString,
  WAKER_URL_ENV,
} from '../waker/index.js';

type AppEnv = { Bindings: Env; Variables: Variables };

/** True only when the receiver should answer: waker mode *and* a platform URL. */
function callbackEnabled(env: Env): boolean {
  return (
    isWakerEnabled(envLike(env)) &&
    readEnvString(envLike(env), WAKER_URL_ENV) !== null
  );
}

/**
 * The SDK types the env as `Record<string, unknown>` so it can be used without
 * depending on any downstream binding types. Env is an interface (no index
 * signature), hence the cast — the SDK only reads named string keys.
 */
function envLike(env: Env): Record<string, unknown> {
  return env as unknown as Record<string, unknown>;
}

/**
 * Hand one request to the SDK's receiver.
 *
 * The receiver's routes are relative to its mount prefix (`POST /execute`), so
 * it has to be reached through `app.route(prefix, receiver)`; a throwaway host
 * app does exactly that for this one request. Path stripping, 404s inside the
 * prefix and every protocol detail stay SDK decisions — this is not a
 * hand-written forwarder for the protocol.
 */
function forwardToReceiver(
  request: Request,
  env: Env,
): Response | Promise<Response> {
  const host = new Hono<AppEnv>();
  host.route(
    CALLBACK_MOUNT_PATH,
    createWakerCallbackReceiver(env) as unknown as Hono<AppEnv>,
  );
  return host.fetch(request, env);
}

/**
 * Log a rejected callback without ever touching its body's contents: only the
 * HTTP status and the SDK's stable error code (`invalid_signature`,
 * `stale_timestamp`, `unknown_job`, `signing_key_missing`, …). Verification and
 * registration failures must not disappear silently.
 */
async function logRejection(response: Response): Promise<Response> {
  if (response.status < 400) return response;
  let code: string | null = null;
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    if (typeof body.error?.code === 'string') code = body.error.code;
  } catch {
    // Non-JSON error body: the status alone is still worth logging.
  }
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'waker_callback_rejected',
      status: response.status,
      code,
    }),
  );
  return response;
}

/** `app.route('/_waker', wakerRoutes())`, registered before the SPA fallback. */
export function wakerRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.all('*', async (c) => {
    if (!callbackEnabled(c.env)) {
      if (isWakerEnabled(envLike(c.env))) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'waker_callback_disabled',
            reason: 'missing_url',
            env: WAKER_URL_ENV,
          }),
        );
      }
      return apiError(c, 404, 'waker_disabled', 'Waker callback is disabled');
    }
    return logRejection(await forwardToReceiver(c.req.raw, c.env));
  });

  return routes;
}
