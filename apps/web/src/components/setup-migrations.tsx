import type { SetupMigration } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/i18n';
import { MIGRATION_STATUS_VARIANT, migrationStatusLabel } from '@/lib/setup';

// Renders the migration list returned by POST /api/setup and POST /api/admin/setup.
// Shared by the public /setup page and the admin "check & upgrade" action so the
// two stay consistent. The status → label / variant mapping lives in
// lib/setup.ts as pure functions so it can be unit-tested.
export function SetupMigrationsResult({
  migrations,
}: {
  migrations: SetupMigration[];
}) {
  const { t } = useTranslation();

  if (migrations.length === 0) {
    return (
      <p className="text-body text-muted-foreground">
        {t('setup.noMigrations')}
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {migrations.map((m) => (
        <li key={m.name} className="rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-body">{m.name}</span>
            <Badge variant={MIGRATION_STATUS_VARIANT[m.status]}>
              {t(migrationStatusLabel(m.status))}
            </Badge>
          </div>
          {m.status === 'error' && m.error && (
            <p className="mt-1 break-all text-caption text-destructive">
              {m.error}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
