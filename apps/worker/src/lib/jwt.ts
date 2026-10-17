import { jwtVerify, SignJWT } from 'jose';
import type {
  AccessTokenPayload,
  PendingTokenPayload,
  RefreshTokenPayload,
} from '../types.js';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';
const PENDING_TOKEN_TTL = '10m';

// S1: exported so callers can compute exact denylist TTLs
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 3600;

function getKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function newJti(): string {
  return crypto.randomUUID();
}

export async function signAccessToken(
  // exp is set by setExpirationTime() and added by jose — exclude from caller's payload
  payload: Omit<AccessTokenPayload, 'purpose' | 'jti' | 'exp'>,
  secret: string,
): Promise<{ token: string; jti: string }> {
  const jti = newJti();
  const token = await new SignJWT({ ...payload, purpose: 'access', jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .setIssuedAt()
    .sign(getKey(secret));
  return { token, jti };
}

export async function signRefreshToken(
  sub: string,
  tv: number,
  secret: string,
): Promise<{ token: string; jti: string }> {
  const jti = newJti();
  const token = await new SignJWT({ sub, tv, purpose: 'refresh', jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(REFRESH_TOKEN_TTL)
    .setIssuedAt()
    .sign(getKey(secret));
  return { token, jti };
}

export async function signPendingToken(
  sub: string,
  methods: string[],
  secret: string,
): Promise<{ token: string; jti: string }> {
  const jti = newJti();
  const token = await new SignJWT({ sub, purpose: '2fa_pending', jti, methods })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(PENDING_TOKEN_TTL)
    .setIssuedAt()
    .sign(getKey(secret));
  return { token, jti };
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload> {
  // MED-6: Pin algorithm to prevent algorithm-confusion attacks
  const { payload } = await jwtVerify(token, getKey(secret), {
    algorithms: ['HS256'],
  });
  if (payload.purpose !== 'access') throw new Error('Invalid token purpose');
  return payload as unknown as AccessTokenPayload;
}

export async function verifyRefreshToken(
  token: string,
  secret: string,
): Promise<RefreshTokenPayload> {
  // MED-6: Pin algorithm to prevent algorithm-confusion attacks
  const { payload } = await jwtVerify(token, getKey(secret), {
    algorithms: ['HS256'],
  });
  if (payload.purpose !== 'refresh') throw new Error('Invalid token purpose');
  return payload as unknown as RefreshTokenPayload;
}

export async function verifyPendingToken(
  token: string,
  secret: string,
): Promise<PendingTokenPayload> {
  // MED-6: Pin algorithm to prevent algorithm-confusion attacks
  const { payload } = await jwtVerify(token, getKey(secret), {
    algorithms: ['HS256'],
  });
  if (payload.purpose !== '2fa_pending')
    throw new Error('Invalid token purpose');
  return payload as unknown as PendingTokenPayload;
}
