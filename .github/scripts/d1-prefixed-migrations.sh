#!/usr/bin/env bash
# Applies the setup-route migrations (apps/worker/src/lib/migrations.ts) to a
# D1 database whose tables carry TABLE_PREFIX. Runs before the new code is
# deployed, so migrations must stay additive (expand → deploy → contract).
# Applied migrations are recorded in `_<prefix>_schema_migrations`, exactly
# like POST /setup does, so both paths stay interchangeable.
# Run from apps/worker (needs wrangler.toml with real IDs injected).
#
# The production database is shared with other applications, hence:
#   - d1-migrations.mjs rejects any statement that is not additive or that
#     targets a table without this app's prefix;
#   - every deployed Worker version must use the same TABLE_PREFIX, so a
#     mistyped GitHub variable can't migrate another app's tables;
#   - prefixed tables without a migration history are never touched.
#
# When the deployed Worker can't be read (it may not exist at all, e.g. after it
# was deleted), `_<prefix>_schema_migrations` itself proves that the prefixed
# tables belong to this app, so the run continues; prefix tables without that
# ledger keep failing.
#
# D1_LOCATION=local targets the local D1 database instead (for testing this
# script); the deployed-Worker check is skipped then.
set -euo pipefail

prefix="${TABLE_PREFIX:-}"
location="${D1_LOCATION:-remote}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! [[ "$prefix" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "::error::TABLE_PREFIX must be set and may only contain letters, digits and underscores (got '$prefix')."
  exit 1
fi
if [[ "$location" != remote && "$location" != local ]]; then
  echo "::error::D1_LOCATION must be 'remote' or 'local', got '$location'"
  exit 1
fi

d1_query() {
  pnpm exec wrangler d1 execute DB "--$location" --json --command "$1" |
    jq -r '.[0].results[] | .name'
}

# Fails (and so aborts the deploy) if any migration is not additive or touches
# a table outside this app's prefix.
plan="$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$here/d1-migrations.mjs" "$prefix")"
history="$(jq -r '.historyTable' <<<"$plan")"
known=()
while IFS= read -r name; do
  known+=("$name")
done < <(jq -r '.migrations[].name' <<<"$plan")

tables="$(d1_query "SELECT name FROM sqlite_master WHERE type = 'table'")"

# This app's Wrangler migration file names (apps/worker/migrations/*.sql),
# enumerated on the spot so the list can never drift from the directory.
app_migration_files="$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$here/d1-migration-files.mjs")"

# True when Wrangler's `d1_migrations` ledger records at least one of THIS app's
# migration files. The table alone is no signal: it is a database-wide
# singleton, so any other app on the shared D1 database that ever ran
# `wrangler d1 migrations apply` leaves it behind with that app's file names.
has_app_migration_history() {
  grep -qx d1_migrations <<<"$tables" || return 1
  local applied name
  applied="$(d1_query "SELECT name FROM d1_migrations")"
  while IFS= read -r name; do
    if grep -qxF "$name" <<<"$applied"; then
      return 0
    fi
  done <<<"$app_migration_files"
  return 1
}

# SQLite identifiers are case-insensitive, so match the prefix the same way.
own_tables="$(grep -i "^${prefix}_" <<<"$tables" || true)"
has_history=false
if grep -qixF "$history" <<<"$tables"; then
  has_history=true
fi

if [[ "$location" == remote ]]; then
  err="$(mktemp)"
  trap 'rm -f "$err"' EXIT
  if status="$(pnpm exec wrangler deployments status --json 2>"$err")"; then
    versions="$(jq -er '.versions | select(length > 0) | .[].version_id | strings | select(length > 0)' <<<"$status")"
    if [[ -z "$versions" ]]; then
      echo "::error::No active Worker versions returned; refusing to migrate."
      exit 1
    fi
    for version in $versions; do
      live="$(bash "$here/worker-table-prefix.sh" "$version")"
      live="${live//[^A-Za-z0-9_]/}"
      if [[ "$live" != "$prefix" ]]; then
        echo "::error::Deployed Worker version $version uses TABLE_PREFIX='$live', but the GitHub variable is '$prefix'. Make them match before deploying; refusing to migrate."
        exit 1
      fi
    done
    echo "Deployed Worker uses TABLE_PREFIX=$prefix (version(s): $(tr '\n' ' ' <<<"$versions"))."
  elif [[ "$has_history" == true ]]; then
    cat "$err" >&2
    echo "::warning::Could not read the deployed Worker (it may not exist yet, e.g. after it was deleted). $history exists, so the ${prefix}_ tables belong to this app; continuing with the idempotent migration run."
  elif [[ -z "$own_tables" ]]; then
    cat "$err" >&2
    echo "::warning::Could not read the deployed Worker (first deploy?). The database has no ${prefix}_ tables yet, so creating them is safe."
  else
    cat "$err" >&2
    echo "::error::Could not read the deployed Worker's TABLE_PREFIX to confirm which tables belong to this app; refusing to migrate existing ${prefix}_ tables."
    exit 1
  fi
fi

if [[ "$has_history" == true ]]; then
  applied="$(d1_query "SELECT name FROM $history ORDER BY applied_at, name")"
elif [[ -n "$own_tables" ]]; then
  echo "::error::Found ${prefix}_ tables but no $history table: $(tr '\n' ' ' <<<"$own_tables")"
  echo "::error::They may belong to another application or predate the migration history; refusing to migrate. Record the applied migrations in $history first."
  exit 1
else
  # Silent-switch guard: an unprefixed schema of this app (history with schema_v1,
  # or Wrangler's `d1_migrations` holding this app's own migration files) exists
  # → abort rather than silently initialising a new prefixed schema. A bare
  # `users` table alone is not a signal — the shared D1 database can carry other
  # apps' tables, and so does a `d1_migrations` ledger written by another app.
  if has_app_migration_history || (grep -qx _schema_migrations <<<"$tables" && d1_query "SELECT name FROM _schema_migrations" | grep -qx schema_v1); then
    echo "::error::The database contains an unprefixed schema (_schema_migrations / d1_migrations), but TABLE_PREFIX resolves to '$prefix'. Refusing to initialise a new '$prefix'-prefixed schema. To keep the existing unprefixed schema, set TABLE_PREFIX='' (or TABLE_PREFIX=none in CI)."
    exit 1
  fi
  applied=""
  echo "No ${prefix}_ tables yet — fresh install."
fi

# Don't guess a baseline for existing tables, even if the history table exists
# but is empty. Replaying v1 could silently record a partial or foreign schema.
if [[ -n "$own_tables" ]] && ! grep -qxF schema_v1 <<<"$applied"; then
  echo "::error::Existing ${prefix}_ tables have no schema_v1 record in $history; refusing to baseline or replay migrations."
  exit 1
fi

pending=()
for name in "${known[@]}"; do
  if ! grep -qxF "$name" <<<"$applied"; then
    pending+=("$name")
  fi
done
while IFS= read -r name; do
  if [[ -n "$name" ]] && ! printf '%s\n' "${known[@]}" | grep -qxF "$name"; then
    echo "::warning::$history records '$name', which this commit does not know (deploying older code?). Ignoring it."
  fi
done <<<"$applied"

echo "Migration history ($history, $location): $(tr '\n' ' ' <<<"${applied:-<none>}")"
if [[ ${#pending[@]} -eq 0 ]]; then
  echo "Planned migrations: none — schema is up to date."
  exit 0
fi
echo "Planned migrations: ${pending[*]}"

for name in "${pending[@]}"; do
  sql="$(jq -r --arg n "$name" '.migrations[] | select(.name == $n) | .sql' <<<"$plan")"
  echo "::group::$name"
  echo "$sql"
  echo "::endgroup::"
  echo "Applying ${name}..."
  pnpm exec wrangler d1 execute DB "--$location" --command "$sql"
done

recorded="$(d1_query "SELECT name FROM $history")"
for name in "${known[@]}"; do
  if ! grep -qxF "$name" <<<"$recorded"; then
    echo "::error::$name is not recorded in $history after applying migrations."
    exit 1
  fi
done
echo "Applied: ${pending[*]}"
