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
  if (!expiresAt) return false;
  return expiresAt * 1000 < Date.now();
}

export function expiryLabel(expiresAt: number | null): string {
  if (!expiresAt) return 'Never';
  if (isExpired(expiresAt)) return 'Expired';
  const diff = expiresAt - Math.floor(Date.now() / 1000);
  if (diff < 86400) return `${Math.floor(diff / 3600)}h remaining`;
  return `${Math.floor(diff / 86400)}d remaining`;
}

// FE-C2: <input type="datetime-local"> shows and parses wall-clock time in the
// browser's local time zone, so its value must be formatted locally too —
// toISOString() is UTC and shifted the expiry by the UTC offset on every edit.
export function toDatetimeLocalValue(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
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

export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
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
