// Database table name helper — applies TABLE_PREFIX from env. The three-state
// resolution and the default constant live in table-prefix.ts (single source of
// truth); TABLE_PREFIX is read-only at deploy time, so changing it after initial
// setup requires migrating data to the new table names.

import { tbl as applyPrefix, resolveTablePrefix } from './table-prefix.js';

export function tbl(env: { TABLE_PREFIX?: string }, name: string): string {
  return applyPrefix(resolveTablePrefix(env.TABLE_PREFIX), name);
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
