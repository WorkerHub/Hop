#!/usr/bin/env bash
# Prints the effective TABLE_PREFIX of a deployed Worker version. When the
# Worker has no TABLE_PREFIX binding, the project default ('sl') is printed —
# matching the runtime three-state resolution in src/lib/table-prefix.ts.
# Run from apps/worker (needs wrangler.toml with real IDs injected).
#
#   bash worker-table-prefix.sh <version-id>
#
# Fails if the lookup fails, or if TABLE_PREFIX is stored as a secret: its
# value can't be read back, so it can't be compared with the GitHub variable.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="${1:?usage: worker-table-prefix.sh <version-id>}"

view="$(pnpm exec wrangler versions view "$version" --json)"
# Don't interpret an unexpected API response as an unset prefix.
jq -e --arg v "$version" '.id == $v and (.resources.bindings | type == "array")' <<<"$view" >/dev/null
binding="$(jq -c '[.resources.bindings[] | select(.name == "TABLE_PREFIX")] | first // empty' <<<"$view")"
if [[ -z "$binding" ]]; then
  # No binding: the runtime resolves this to the project default prefix.
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$here/default-table-prefix.mjs"
  exit 0
fi

type="$(jq -r '.type' <<<"$binding")"
if [[ "$type" != plain_text ]]; then
  echo "::error::TABLE_PREFIX on Worker version $version is a '$type' binding; make it a plain-text variable so the deploy workflow can check it." >&2
  exit 1
fi
jq -r '.text' <<<"$binding"
