#!/usr/bin/env bash
# Prepares the remote D1 database for `wrangler d1 migrations apply --remote`.
# Run from apps/worker (needs wrangler.toml with real IDs injected).
#
# Production databases may have been bootstrapped through the HTTP setup route
# (routes/setup.ts), which records applied migrations as `schema_vN` in its own
# `_schema_migrations` table instead of wrangler's `d1_migrations`. Running
# wrangler against such a database would re-run 0001_init.sql and fail on
# "table already exists". This script baselines `d1_migrations` from
# `_schema_migrations`, by the convention:
#
#   setup.ts migration `schema_vN`  <=>  migrations/NNNN_*.sql  (N zero-padded)
#
# Writes `mode=apply`, `mode=prefixed` or `mode=skip` to $GITHUB_OUTPUT
# (stdout if unset).
#   apply    — wrangler migrations can run safely
#   prefixed — TABLE_PREFIX is in use; migrations/*.sql are not prefix-aware,
#              so d1-prefixed-migrations.sh applies the setup-route migrations
#   skip     — prefixed tables found but TABLE_PREFIX is not set here; the
#              schema must keep being managed through the setup route
#
# D1_LOCATION=local runs the queries against the local D1 database instead of
# the remote one (for testing this script).
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
location="${D1_LOCATION:-remote}"
if [[ "$location" != remote && "$location" != local ]]; then
  echo "::error::D1_LOCATION must be 'remote' or 'local', got '$location'"
  exit 1
fi

if [[ -n "${TABLE_PREFIX:-}" ]]; then
  if ! [[ "$TABLE_PREFIX" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "::error::TABLE_PREFIX '$TABLE_PREFIX' may only contain letters, digits and underscores."
    exit 1
  fi
  echo "TABLE_PREFIX=$TABLE_PREFIX — prefixed setup-route migrations will be applied instead of wrangler's."
  echo "mode=prefixed" >>"$out"
  exit 0
fi

d1_query() {
  pnpm exec wrangler d1 execute DB "--$location" --json --command "$1" |
    jq -r '.[0].results[] | .name'
}

tables="$(d1_query "SELECT name FROM sqlite_master WHERE type = 'table'")"
has_table() { grep -qx "$1" <<<"$tables"; }

if has_table d1_migrations; then
  echo "d1_migrations present — database is already tracked by wrangler."
  echo "mode=apply" >>"$out"
  exit 0
fi

if ! has_table users; then
  if grep -Eq '^(_[A-Za-z0-9_]+_schema_migrations|[A-Za-z0-9_]+_users)$' <<<"$tables"; then
    echo "::warning::Found prefixed tables but no unprefixed schema; looks like TABLE_PREFIX is in use. Set the TABLE_PREFIX variable on the production environment so deploys apply prefixed migrations. Skipping D1 migrations."
    echo "mode=skip" >>"$out"
    exit 0
  fi
  echo "Empty database — wrangler will apply all migrations."
  echo "mode=apply" >>"$out"
  exit 0
fi

# Unprefixed schema created by the setup route: baseline d1_migrations.
applied=""
if has_table _schema_migrations; then
  applied="$(d1_query "SELECT name FROM _schema_migrations")"
fi
if [[ -z "$applied" ]]; then
  # No history: only assume schema_v1 if the full 0001_init.sql schema is
  # really there, rather than marking it applied on a partial/drifted schema.
  for t in users passkeys links click_logs verifications settings audit_logs totp_used; do
    if ! has_table "$t"; then
      echo "::error::Tables exist but no migration history was found, and table '$t' from 0001_init.sql is missing; refusing to baseline."
      exit 1
    fi
  done
  if ! d1_query "SELECT name FROM pragma_table_info('links')" | grep -qx user_seq; then
    echo "::error::Tables exist but no migration history was found, and links.user_seq from 0001_init.sql is missing; refusing to baseline."
    exit 1
  fi
  echo "::warning::Tables exist but no migration history was found; the 0001_init.sql schema is present, baselining it as schema_v1."
  applied="schema_v1"
fi

values=()
for file in migrations/*.sql; do
  name="$(basename "$file")"
  num="${name%%_*}"
  [[ "$num" =~ ^[0-9]+$ ]] || continue
  if grep -qx "schema_v$((10#$num))" <<<"$applied"; then
    values+=("('$name')")
  fi
done

if [[ ${#values[@]} -eq 0 ]]; then
  echo "::error::Could not map any applied setup-route migration to migrations/*.sql; refusing to baseline."
  exit 1
fi

echo "Baselining d1_migrations with: ${values[*]}"
pnpm exec wrangler d1 execute DB "--$location" --command "
  CREATE TABLE IF NOT EXISTS d1_migrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  INSERT OR IGNORE INTO d1_migrations (name) VALUES $(IFS=,; echo "${values[*]}");
"
echo "mode=apply" >>"$out"
