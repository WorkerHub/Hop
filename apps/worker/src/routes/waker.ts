// HTTP side of the waker integration: mount the SDK's receiver at /_waker.
//
// The signing key is the **only** switch — there is no mode variable and no
// second gate:
//   - `WAKER_SIGNING_KEY` bound (GitHub Secret → `--secrets-file`) → the SDK
//     verifies the HMAC signature, then runs the very same cleanup as
//     `scheduled()` (src/services/waker.ts);
//   - no key → the SDK fails closed with 500 `signing_key_missing`; it never
//     runs a job it could not verify.
//
// Everything under /_waker answers JSON, never the SPA's 200 HTML: wrangler.toml
// serves the SPA with `not_found_handling = "single-page-application"`, and
// waker treats any 2xx as "execution succeeded" — a fall-through would report a
// nightly cleanup that never ran. The receiver answers the protocol errors
// itself; a path it does not route becomes a JSON 404 (host app's notFound).

import { Hono } from 'hono';
import { apiError } from '../lib/errors.js';
import { createWakerCallbackReceiver } from '../services/waker.js';
import type { Env, Variables } from '../types.js';
import { CALLBACK_MOUNT_PATH } from '../waker/index.js';

type AppEnv = { Bindings: Env; Variables: Variables };

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
  // Unrouted paths inside the mount must still answer JSON (404), so /_waker
  // can never fall through to the SPA fallback below it in src/index.ts.
  host.notFound((c) => apiError(c, 404, 'NOT_FOUND', 'Not found'));
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
    return logRejection(await forwardToReceiver(c.req.raw, c.env));
  });

  return routes;
}
