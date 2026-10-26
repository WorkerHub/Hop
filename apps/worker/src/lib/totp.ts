import { TOTP } from 'otpauth';
import { aesDecrypt, aesEncrypt } from './crypto.js';

// L1: Single issuer constant used by both buildTotpUri and verifyTotp
const TOTP_ISSUER = 'Hop';

export function generateTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return base32Encode(bytes);
}

export function buildTotpUri(
  secret: string,
  email: string,
  issuer = TOTP_ISSUER,
): string {
  const totp = new TOTP({
    issuer,
    label: email,
    secret,
    digits: 6,
    period: 30,
  });
  return totp.toString();
}

export function verifyTotp(
  secret: string,
  code: string,
  issuer = TOTP_ISSUER,
): boolean {
  const totp = new TOTP({ issuer, secret, digits: 6, period: 30 });
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

export async function encryptTotpSecret(
  secret: string,
  keyHex: string,
): Promise<string> {
  return aesEncrypt(secret, keyHex);
}

export async function decryptTotpSecret(
  encrypted: string,
  keyHex: string,
): Promise<string> {
  return aesDecrypt(encrypted, keyHex);
}

export function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () => generateBackupCode());
}

function generateBackupCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 36 chars
  // M2: Rejection sampling — 252 = floor(256/36)*36 is the last safe threshold
  const threshold = Math.floor(256 / alphabet.length) * alphabet.length;
  const result: string[] = [];
  while (result.length < 10) {
    const bytes = crypto.getRandomValues(
      new Uint8Array((10 - result.length) * 2),
    );
    for (const b of bytes) {
      if (result.length >= 10) break;
      if (b < threshold) result.push(alphabet[b % alphabet.length] as string);
    }
  }
  return result
    .join('')
    .replace(/(.{5})/g, '$1-')
    .slice(0, -1);
}

// RFC 4648 Base32 encode (used by TOTP libraries)
function base32Encode(buf: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}
