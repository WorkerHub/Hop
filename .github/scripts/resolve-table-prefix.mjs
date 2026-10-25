// CI three-state TABLE_PREFIX resolution (the "none" convention).
//
// GitHub Actions `vars.TABLE_PREFIX` cannot distinguish "unset" from "empty",
// so the deploy workflow uses a reserved word to preserve the three runtime
// states:
//   unset / empty → DEFAULT_TABLE_PREFIX ('sl')
//   'none'        → '' (explicit no prefix; the deployer accepts the
//                    table-collision risk)
//   anything else → as-is
//
// The default constant comes from the single source of truth
// (apps/worker/src/lib/table-prefix.ts), loaded via Node type stripping.
// Reads the raw value from the TABLE_PREFIX environment variable and prints the
// resolved value to stdout.
import { DEFAULT_TABLE_PREFIX } from '../../apps/worker/src/lib/table-prefix.ts';

const raw = process.env.TABLE_PREFIX;

let resolved;
if (raw === undefined || raw === '') {
  resolved = DEFAULT_TABLE_PREFIX;
} else if (raw === 'none') {
  resolved = '';
} else {
  resolved = raw;
}
process.stdout.write(resolved);
