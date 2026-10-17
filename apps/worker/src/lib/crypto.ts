// Password hashing via WebCrypto PBKDF2-SHA256
// Format: "v1:{base64salt}:{base64hash}"

// L4: OWASP recommends 600k iterations for PBKDF2-SHA256; 100k is the practical
// limit under Cloudflare Workers CPU budget. The "v1:" prefix supports migrating
// to a higher iteration count in the future without a forced password reset.
const ITERATIONS = 100_000;
const KEY_LENGTH = 256;
const HASH_ALG = 'SHA-256';

// LOW-5: Loop instead of spread to avoid RangeError on large buffers (V8 limit ~65k args)
function b64encode(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(str: string): Uint8Array {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: ITERATIONS,
      hash: HASH_ALG,
    },
    keyMaterial,
    KEY_LENGTH,
  );
  return `v1:${b64encode(salt.buffer as ArrayBuffer)}:${b64encode(bits)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const saltB64 = parts[1];
  const expectedHash = parts[2];
  if (!saltB64 || !expectedHash) return false;
  const salt = b64decode(saltB64);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: ITERATIONS,
      hash: HASH_ALG,
    },
    keyMaterial,
    KEY_LENGTH,
  );
  const storedHashBytes = b64decode(expectedHash);
  // M9: Constant-time comparison via XOR loop prevents timing attacks
  const a = new Uint8Array(bits);
  const b = storedHashBytes;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// SHA-256 hash (for OTP codes, etc.)
export async function sha256(data: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Constant-time string comparison — for secrets whose value must not leak
// through timing (e.g. the setup secret in a header). Always loops over the
// longer of the two inputs so the duration does not depend on the inputs.
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

// AES-256-GCM encrypt (for TOTP secrets)
// S-3: Cache the imported CryptoKey per keyHex to avoid paying importKey overhead on every call.
//      Workers isolate memory per-request in some configurations, but within a single request
//      (e.g. setup + confirm) the cache prevents double importKey.
const aesKeyCache = new Map<string, CryptoKey>();

async function getAesKey(
  keyHex: string,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const cacheKey = `${keyHex}:${usage}`;
  const cached = aesKeyCache.get(cacheKey);
  if (cached) return cached;
  const keyBytes = hexToBytes(keyHex);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    [usage],
  );
  aesKeyCache.set(cacheKey, key);
  return key;
}

export async function aesEncrypt(
  plaintext: string,
  keyHex: string,
): Promise<string> {
  // LOW-4: Validate key length eagerly for a clear error over an opaque DOMException
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      'TOTP_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes for AES-256-GCM)',
    );
  }
  const cryptoKey = await getAesKey(keyHex, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  );
  return `${b64encode(iv.buffer as ArrayBuffer)}:${b64encode(enc)}`;
}

export async function aesDecrypt(
  ciphertext: string,
  keyHex: string,
): Promise<string> {
  // LOW-4: Validate key length eagerly
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      'TOTP_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes for AES-256-GCM)',
    );
  }
  const [ivB64, dataB64] = ciphertext.split(':');
  if (!ivB64 || !dataB64) throw new Error('Invalid ciphertext format');
  const cryptoKey = await getAesKey(keyHex, 'decrypt');
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(ivB64).buffer as ArrayBuffer },
    cryptoKey,
    b64decode(dataB64).buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(dec);
}

// Generate cryptographically random OTP (rejection sampling for uniform distribution)
export function generateOtp(digits = 6): string {
  const max = 10 ** digits;
  // Rejection sampling: discard values above the largest multiple of max that fits in Uint32
  const limit = Math.floor(2 ** 32 / max) * max;
  let val: number;
  do {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    val = bytes[0] ?? 0;
  } while (val >= limit);
  return (val % max).toString().padStart(digits, '0');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
