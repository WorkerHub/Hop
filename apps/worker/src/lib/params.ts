// Query-string number parsing shared by the list/analytics routes.
// This module has no imports so it can be unit-tested directly under Node.

// BE-C1: parseInt('abc') is NaN and Math.max/min propagate it, so a malformed
// ?page= or ?limit= used to reach D1's LIMIT/OFFSET and turn into a 500.
// Missing or non-numeric input falls back to the default; numeric input is
// clamped to [min, max].
export function parseIntParam(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Upper bound for ?page= so (page - 1) * limit always stays a safe integer.
export const MAX_PAGE = 1_000_000;

export function parsePagination(
  rawPage: string | undefined,
  rawLimit: string | undefined,
  maxLimit: number,
  defaultLimit = 20,
): { page: number; limit: number; offset: number } {
  const page = parseIntParam(rawPage, 1, 1, MAX_PAGE);
  const limit = parseIntParam(rawLimit, defaultLimit, 1, maxLimit);
  return { page, limit, offset: (page - 1) * limit };
}
