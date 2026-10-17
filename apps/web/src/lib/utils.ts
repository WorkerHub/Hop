import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function isExpired(expiresAt: number | null): boolean {
  const seconds = expiresAtSeconds(expiresAt);
  if (!seconds) return false;
  return seconds * 1000 < Date.now();
}

// FE-C5: `expires_at` is a Unix timestamp in seconds, but a millisecond value
// (>= 1e12, i.e. any date after 2001 expressed in ms) mixed in would silently
// shift every comparison by three orders of magnitude. Normalize at the edge so
// both units render correctly instead of producing a date in the year 50000.
export function expiresAtSeconds(value: number | null): number | null {
  if (!value || !Number.isFinite(value)) return null;
  return value >= 1e12 ? Math.floor(value / 1000) : value;
}

export type ExpiryParts =
  | { kind: 'never' }
  | { kind: 'expired' }
  | { kind: 'minutes'; value: number }
  | { kind: 'hours'; value: number }
  | { kind: 'days'; value: number };

// FE-C5: under an hour, whole hours round down to "0h remaining" — report
// minutes instead, and never show "0m" for a link that has not expired yet.
export function expiryParts(expiresAt: number | null): ExpiryParts {
  const seconds = expiresAtSeconds(expiresAt);
  if (!seconds) return { kind: 'never' };
  const diff = seconds - Math.floor(Date.now() / 1000);
  if (diff <= 0) return { kind: 'expired' };
  if (diff < 3600)
    return { kind: 'minutes', value: Math.max(1, Math.ceil(diff / 60)) };
  if (diff < 86400) return { kind: 'hours', value: Math.floor(diff / 3600) };
  return { kind: 'days', value: Math.floor(diff / 86400) };
}

// FE-C2: <input type="datetime-local"> shows and parses wall-clock time in the
// browser's local time zone, so its value must be formatted locally too —
// toISOString() is UTC and shifted the expiry by the UTC offset on every edit.
export function toDatetimeLocalValue(ts: number | null): string {
  const seconds = expiresAtSeconds(ts);
  if (!seconds) return '';
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Inverse of toDatetimeLocalValue: a local "YYYY-MM-DDTHH:mm" string to a Unix
// timestamp in seconds, or null when empty/invalid.
export function fromDatetimeLocalValue(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export async function copyToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard API unavailable');
  }
  await navigator.clipboard.writeText(text);
}

// FE-R5: after signing in again, return to the page the session ended on. Only
// same-origin relative paths are accepted — `//evil.com` or an absolute URL
// would turn the login page into an open redirect.
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  // Browsers treat a backslash as a slash, so `/\evil.com` would escape too.
  if (next.includes('\\')) return null;
  try {
    const url = new URL(next, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    const path = `${url.pathname}${url.search}${url.hash}`;
    // Never bounce back to the login page itself.
    if (path === '/login' || path.startsWith('/login?')) return null;
    return path;
  } catch {
    return null;
  }
}

export function buildLoginRedirect(pathname: string, search = ''): string {
  return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

// FE-S2: Validate that a URL is safe to render as a clickable <a href>. Only
// http/https are allowed — anything else (javascript:, data:, etc.) is rendered
// as plain text to prevent XSS if backend validation is ever bypassed.
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function buildShortUrl(slug: string): string {
  return `${window.location.origin}/${slug}`;
}
