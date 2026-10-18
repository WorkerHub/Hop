import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { adminApi } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAppConfig } from '@/contexts/AppConfigContext';
import { useTranslation } from '@/i18n';
import { toastApiError } from '@/lib/toast';

export default function AdminSettingsPage() {
  const { t } = useTranslation();
  const { reload: reloadAppConfig } = useAppConfig();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: adminApi.getSettings,
  });

  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [requireEmailVerification, setRequireEmailVerification] =
    useState(false);
  const [appName, setAppName] = useState('');
  const [savingAppName, setSavingAppName] = useState(false);

  // Email settings
  const [emailProvider, setEmailProvider] = useState<'resend' | 'smtp'>(
    'resend',
  );
  // Resend
  const [resendApiKey, setResendApiKey] = useState('');
  const [emailFromDomain, setEmailFromDomain] = useState('');
  const [emailFromName, setEmailFromName] = useState('');
  // SMTP
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  // FE-S3: Backend masks secrets; track whether one is already configured so the
  // UI can show "leave blank to keep" and avoid submitting an empty value.
  const [resendKeyIsSet, setResendKeyIsSet] = useState(false);
  const [smtpPassIsSet, setSmtpPassIsSet] = useState(false);

  useEffect(() => {
    if (data?.settings) {
      const s = data.settings;
      setRegistrationEnabled(s.registration_enabled === 'true');
      setRequireEmailVerification(s.require_email_verification === 'true');
      setAppName(s.app_name ?? 'ShortLink');
      setEmailProvider((s.email_provider as 'resend' | 'smtp') ?? 'resend');
      // FE-S3: Secrets are masked by the server ("***" when set) — never fill the
      // input with them; only remember whether one is configured.
      setResendApiKey('');
      setResendKeyIsSet(s.resend_api_key === '***');
      setEmailFromDomain(s.email_from_domain ?? '');
      setEmailFromName(s.email_from_name ?? '');
      setSmtpHost(s.smtp_host ?? '');
      setSmtpPort(s.smtp_port ?? '587');
      setSmtpUser(s.smtp_user ?? '');
      setSmtpPass('');
      setSmtpPassIsSet(s.smtp_pass === '***');
      setSmtpFrom(s.smtp_from ?? '');
    }
  }, [data]);

  const handleRegistrationToggle = async (enabled: boolean) => {
    setRegistrationEnabled(enabled);
    try {
      await adminApi.updateSettings({
        registration_enabled: enabled ? 'true' : 'false',
      });
      toast.success(
        enabled
          ? t('toast.registrationEnabled')
          : t('toast.registrationDisabled'),
      );
    } catch (err) {
      setRegistrationEnabled(!enabled);
      toastApiError(err, t('toast.requestFailed'), t);
    }
  };

  const handleRequireEmailVerificationToggle = async (enabled: boolean) => {
    setRequireEmailVerification(enabled);
    try {
      await adminApi.updateSettings({
        require_email_verification: enabled ? 'true' : 'false',
      });
      toast.success(
        enabled
          ? t('admin.emailVerificationEnabled')
          : t('admin.emailVerificationDisabled'),
      );
    } catch (err) {
      setRequireEmailVerification(!enabled);
      toastApiError(err, t('toast.requestFailed'), t);
    }
  };

  const handleSaveAppName = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAppName(true);
    try {
      await adminApi.updateSettings({ app_name: appName });
      reloadAppConfig();
      toast.success(t('toast.appNameUpdated'));
    } catch (err) {
      toastApiError(err, t('toast.requestFailed'), t);
    } finally {
      setSavingAppName(false);
    }
  };

  const handleSaveEmailSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingEmail(true);
    try {
      // FE-S3: Only submit secret fields when the admin explicitly typed a value;
      // empty values leave the existing credential untouched.
      const payload: Record<string, string> = {
        email_provider: emailProvider,
        email_from_domain: emailFromDomain,
        email_from_name: emailFromName,
        smtp_host: smtpHost,
        smtp_port: smtpPort,
        smtp_user: smtpUser,
        smtp_from: smtpFrom,
      };
      if (resendApiKey !== '') payload.resend_api_key = resendApiKey;
      if (smtpPass !== '') payload.smtp_pass = smtpPass;
      await adminApi.updateSettings(payload);
      toast.success(t('toast.emailSettingsSaved'));
    } catch (err) {
      toastApiError(err, t('toast.requestFailed'), t);
    } finally {
      setSavingEmail(false);
    }
  };

  if (isLoading)
    return (
      <div className="p-6 text-muted-foreground">{t('common.loading')}</div>
    );

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('admin.globalSettings')}</h1>

      {/* Registration toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('admin.registrationToggle')}
          </CardTitle>
          <CardDescription>{t('admin.registrationDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="reg-toggle"
              checked={registrationEnabled}
              onCheckedChange={handleRegistrationToggle}
            />
            <Label htmlFor="reg-toggle">
              {t('admin.registrationCurrent')}{' '}
              <strong>
                {registrationEnabled ? t('admin.open') : t('admin.closed')}
              </strong>
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* Email verification toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('admin.emailVerificationToggle')}
          </CardTitle>
          <CardDescription>{t('admin.emailVerificationDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="email-verify-toggle"
              checked={requireEmailVerification}
              onCheckedChange={handleRequireEmailVerificationToggle}
            />
            <Label htmlFor="email-verify-toggle">
              {t('admin.emailVerificationCurrent')}{' '}
              <strong>
                {requireEmailVerification
                  ? t('admin.emailVerificationRequired')
                  : t('admin.emailVerificationNotRequired')}
              </strong>
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* App name */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('admin.appName')}</CardTitle>
          <CardDescription>{t('admin.appNameDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveAppName} className="flex gap-3">
            <Input
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              placeholder="ShortLink"
              className="max-w-xs"
              required
            />
            <Button type="submit" size="sm" loading={savingAppName}>
              {t('common.save')}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Email provider */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('admin.emailProvider')}
          </CardTitle>
          <CardDescription>{t('admin.emailProviderDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveEmailSettings} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email-provider">{t('admin.provider')}</Label>
              <select
                id="email-provider"
                value={emailProvider}
                onChange={(e) =>
                  setEmailProvider(e.target.value as 'resend' | 'smtp')
                }
                className="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="resend">Resend</option>
                <option value="smtp">SMTP</option>
              </select>
            </div>

            {emailProvider === 'resend' && (
              <div className="space-y-3 rounded-md border p-4">
                <div className="space-y-1.5">
                  <Label htmlFor="resend-api-key">API Key</Label>
                  <Input
                    id="resend-api-key"
                    value={resendApiKey}
                    onChange={(e) => setResendApiKey(e.target.value)}
                    placeholder={
                      resendKeyIsSet
                        ? '•••••••• (leave blank to keep)'
                        : 're_xxxxxxxxxxxx'
                    }
                    type="password"
                    autoComplete="new-password"
                  />
                  {resendKeyIsSet && (
                    <p className="text-xs text-muted-foreground">
                      An API key is configured. Leave blank to keep it
                      unchanged.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Get your API key from{' '}
                    <a
                      href="https://resend.com/api-keys"
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      resend.com
                    </a>
                    . Stored in the database; alternatively set the{' '}
                    <code className="text-xs">RESEND_API_KEY</code> Worker
                    secret.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="email-from-name">Sender Name</Label>
                  <Input
                    id="email-from-name"
                    value={emailFromName}
                    onChange={(e) => setEmailFromName(e.target.value)}
                    placeholder="ShortLink"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="email-from-domain">Sender Domain</Label>
                  <Input
                    id="email-from-domain"
                    value={emailFromDomain}
                    onChange={(e) => setEmailFromDomain(e.target.value)}
                    placeholder="example.com"
                  />
                  <p className="text-xs text-muted-foreground">
                    Emails will be sent from{' '}
                    <code className="text-xs">noreply@&lt;domain&gt;</code>. The
                    domain must be verified in your Resend account.
                  </p>
                </div>
              </div>
            )}

            {emailProvider === 'smtp' && (
              <div className="space-y-3 rounded-md border p-4">
                <div className="grid grid-cols-[1fr_120px] gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="smtp-host">Host</Label>
                    <Input
                      id="smtp-host"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                      placeholder="smtp.example.com"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="smtp-port">Port</Label>
                    <Input
                      id="smtp-port"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(e.target.value)}
                      placeholder="587"
                      type="number"
                      min={1}
                      max={65535}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="smtp-from">From Address</Label>
                  <Input
                    id="smtp-from"
                    value={smtpFrom}
                    onChange={(e) => setSmtpFrom(e.target.value)}
                    placeholder="noreply@example.com"
                    type="email"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="smtp-user">Username</Label>
                  <Input
                    id="smtp-user"
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                    placeholder="noreply@example.com"
                    autoComplete="off"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="smtp-pass">Password</Label>
                  <Input
                    id="smtp-pass"
                    value={smtpPass}
                    onChange={(e) => setSmtpPass(e.target.value)}
                    placeholder={
                      smtpPassIsSet
                        ? '•••••••• (leave blank to keep)'
                        : '••••••••'
                    }
                    type="password"
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted-foreground">
                    {smtpPassIsSet
                      ? 'A password is configured. Leave blank to keep it unchanged.'
                      : 'Credentials are stored in the database.'}
                  </p>
                </div>
              </div>
            )}

            <Button type="submit" size="sm" loading={savingEmail}>
              {t('common.save')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
