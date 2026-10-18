import type { SetupMigration } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n';

const STATUS_VARIANT = {
  applied: 'success',
  skipped: 'secondary',
  error: 'destructive',
} as const;

function statusLabel(status: SetupMigration['status']): TranslationKey {
  switch (status) {
    case 'applied':
      return 'setup.statusApplied';
    case 'skipped':
      return 'setup.statusSkipped';
    case 'error':
      return 'setup.statusError';
  }
}

// Renders the migration list returned by POST /api/setup and POST /api/admin/setup.
// Shared by the public /setup page and the admin "check & upgrade" action so the
// two stay consistent.
export function SetupMigrationsResult({
  migrations,
}: {
  migrations: SetupMigration[];
}) {
  const { t } = useTranslation();

  if (migrations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t('setup.noMigrations')}</p>
    );
  }

  return (
    <ul className="space-y-2">
      {migrations.map((m) => (
        <li key={m.name} className="rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm">{m.name}</span>
            <Badge variant={STATUS_VARIANT[m.status]}>
              {t(statusLabel(m.status))}
            </Badge>
          </div>
          {m.status === 'error' && m.error && (
            <p className="mt-1 break-all text-xs text-destructive">{m.error}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
