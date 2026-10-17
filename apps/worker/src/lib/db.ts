// Database table name helper — applies TABLE_PREFIX from env.
// The prefix is sanitized (alphanumeric + underscore only) to prevent SQL issues.
// TABLE_PREFIX is read-only at deploy time; changing it after initial setup requires
// migrating data to the new table names.

export function tbl(env: { TABLE_PREFIX?: string }, name: string): string {
  const prefix = (env.TABLE_PREFIX ?? '').replace(/[^a-zA-Z0-9_]/g, '');
  return prefix ? `${prefix}_${name}` : name;
}

// BE-C3: True when a D1 error is a UNIQUE constraint violation. D1 surfaces the
// SQLite message (e.g. "D1_ERROR: UNIQUE constraint failed: users.email:
// SQLITE_CONSTRAINT"), sometimes only on a wrapped `cause`, so walk that chain.
export function isUniqueConstraintError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++) {
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/.test(e.message)) {
      return true;
    }
    e = e.cause;
  }
  return false;
}
