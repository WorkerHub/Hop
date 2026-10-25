// Prints the project default TABLE_PREFIX from the single source of truth
// (apps/worker/src/lib/table-prefix.ts), so bash scripts never hardcode it.
import { DEFAULT_TABLE_PREFIX } from '../../apps/worker/src/lib/table-prefix.ts';

process.stdout.write(DEFAULT_TABLE_PREFIX);
