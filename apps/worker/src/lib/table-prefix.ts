// Single source of truth for the project's TABLE_PREFIX semantics.
//
// Three states, distinguished at the call site by whether TABLE_PREFIX is
// `undefined` versus the empty string:
//   undefined → DEFAULT_TABLE_PREFIX ('hop')
//   ''        → '' (no prefix — the deployer accepts the table-collision risk)
//   any other → the value with [^a-zA-Z0-9_] stripped, case preserved
//
// Keep this file free of imports and of TS-only runtime syntax: it is loaded by
// .github/scripts/d1-migrations.mjs (through migrations.ts) via Node's built-in
// TypeScript type stripping.

export const DEFAULT_TABLE_PREFIX = 'hop';

// Three-state resolution of a raw TABLE_PREFIX value.
export function resolveTablePrefix(raw: string | undefined): string {
  const source = raw === undefined ? DEFAULT_TABLE_PREFIX : raw;
  return source.replace(/[^a-zA-Z0-9_]/g, '');
}

// Applies a resolved prefix to a table name, adding the trailing underscore.
// Sanitising here too is idempotent with resolveTablePrefix and keeps table
// names safe even when a raw prefix is passed straight in.
export function tbl(prefix: string, name: string): string {
  const p = prefix.replace(/[^a-zA-Z0-9_]/g, '');
  return p ? `${p}_${name}` : name;
}
