import { useEffect, useState } from 'react';
import type { SetupResult } from '@/api/client';
import { setupApi } from '@/api/client';
import { SetupMigrationsResult } from '@/components/setup-migrations';
import { AuthCard } from '@/components/ui/auth-card';
import { Button } from '@/components/ui/button';
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import type { SetupErrorMsg } from '@/lib/setup';
import { formatSetupError, resolveSetupError } from '@/lib/setup';

export default function SetupPage() {
  const { t } = useTranslation();
  const [stateLoading, setStateLoading] = useState(true);
  const [stateError, setStateError] = useState<SetupErrorMsg | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [secret, setSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [runError, setRunError] = useState<SetupErrorMsg | null>(null);

  useEffect(() => {
    let cancelled = false;
    setupApi
      .state()
      .then((s) => {
        if (!cancelled) setEnabled(s.enabled);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStateError(resolveSetupError(err));
      })
      .finally(() => {
        if (!cancelled) setStateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setRunError(null);
    setResult(null);
    try {
      setResult(await setupApi.run(secret));
    } catch (err) {
      setRunError(resolveSetupError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard>
      <CardHeader>
        <CardTitle className="text-2xl">{t('setup.title')}</CardTitle>
        <CardDescription>{t('setup.titleDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stateLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : stateError ? (
          <p className="text-sm text-destructive" role="alert">
            {formatSetupError(stateError, t)}
          </p>
        ) : !enabled ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('setup.disabledTitle')}</p>
            <p className="text-sm text-muted-foreground">
              {t('setup.disabledDesc')}
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="setup-secret">{t('setup.secretLabel')}</Label>
              <Input
                id="setup-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={t('setup.secretPlaceholder')}
                required
                autoComplete="off"
              />
            </div>
            <Button type="submit" className="w-full" loading={submitting}>
              {submitting ? t('setup.submitting') : t('setup.submit')}
            </Button>
          </form>
        )}

        {runError && (
          <p className="text-sm text-destructive" role="alert">
            {formatSetupError(runError, t)}
          </p>
        )}

        {result && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('setup.migrationsTitle')}</p>
            <SetupMigrationsResult migrations={result.migrations} />
          </div>
        )}
      </CardContent>
    </AuthCard>
  );
}
