import type { Context, Next } from 'hono';
import { tbl } from '../lib/db.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { isJtiDenylisted } from '../lib/kv.js';
import type { Env, Variables } from '../types.js';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// LOW-1: Shared helper eliminates duplication between requireAuth and requireAdmin.
// MED-3: Denylist check happens BEFORE role check so a revoked non-admin token
//        returns 401 (not 403), preventing leaking the token's privilege level.
// BE-S3/S4: Token is re-validated against the DB on every request. The role is
//        taken from the DB (not the JWT claim) and the token_version is compared,
//        so password changes/resets and admin disable/demote revoke all existing
//        tokens immediately — including access tokens still within their TTL.
async function verifyTokenAndSetContext(
  c: AppContext,
): Promise<Response | null> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const token = header.slice(7);
  try {
    const payload = await verifyAccessToken(token, c.env.JWT_SECRET);
    // C4 + MED-3: Denylist check before any role or state checks
    if (await isJtiDenylisted(c.env.LINKS_KV, payload.jti)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    // BE-S3/S4: Confirm the account is still active and its token_version matches.
    const user = await c.env.DB.prepare(
      `SELECT is_active, role, token_version FROM ${tbl(c.env, 'users')} WHERE id = ?1`,
    )
      .bind(payload.sub)
      .first<{
        is_active: number;
        role: 'admin' | 'user';
        token_version: number;
      }>();

    if (!user?.is_active || user.token_version !== payload.tv) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('userId', payload.sub);
    c.set('userRole', user.role);
    c.set('userEmail', payload.email);
    c.set('userJti', payload.jti);
    c.set('userTokenExp', payload.exp);
    return null; // success
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
}

export const requireAuth = async (c: AppContext, next: Next) => {
  const err = await verifyTokenAndSetContext(c);
  if (err) return err;
  await next();
};

export const requireAdmin = async (c: AppContext, next: Next) => {
  const err = await verifyTokenAndSetContext(c);
  if (err) return err;
  if (c.get('userRole') !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
};
