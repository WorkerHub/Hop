import { startAuthentication } from '@simplewebauthn/browser';
import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { LoginResult } from '@/api/client';
import { authApi, setAccessToken } from '@/api/client';
import { AuthCard } from '@/components/ui/auth-card';
import { Button } from '@/components/ui/button';
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { OtpInput } from '@/components/ui/otp-input';
import { useAuth } from '@/contexts/AuthContext';
import { useTranslation } from '@/i18n';
import { toastApiError } from '@/lib/toast';
import { safeNextPath } from '@/lib/utils';

type Tab = 'totp' | 'email_otp' | 'passkey';

export default function TwoFactorPage() {
  const {
    pendingToken,
    pendingMethods,
    clearPendingState,
    refreshUser,
    broadcastRefresh,
  } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // FE-R5: destination forwarded from the login page (?next=).
  const next = safeNextPath(searchParams.get('next'));
  const [tab, setTab] = useState<Tab>(
    (pendingMethods[0] as Tab | undefined) ?? 'totp',
  );
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [otpSent, setOtpSent] = useState(false);

  // FE-C3: Redirect declaratively — calling navigate() during render is a side
  // effect React may run twice (StrictMode) or warn about.
  if (!pendingToken)
    return (
      <Navigate
        to={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}
        replace
      />
    );

  const handleSuccess = async (result: LoginResult) => {
    if (!result.accessToken) {
      toast.error(t('toast.verificationFailed'));
      return;
    }
    setAccessToken(result.accessToken);
    broadcastRefresh();
    await refreshUser();
    // Leave the page before clearing the pending state: clearing it first
    // re-renders this page without a pendingToken and flashes /login.
    navigate(next ?? '/dashboard', { replace: true });
    clearPendingState();
  };

  const handleTotpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await authApi.totpVerify(pendingToken, code);
      await handleSuccess(result);
    } catch (err) {
      toastApiError(err, t('toast.invalidCode'));
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSend = async () => {
    setLoading(true);
    try {
      await authApi.emailOtpSend(pendingToken);
      setOtpSent(true);
      toast.success(t('toast.codeSent'));
    } catch (err) {
      toastApiError(err, t('toast.sendCodeFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleEmailVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await authApi.emailOtpVerify(pendingToken, code);
      await handleSuccess(result);
    } catch (err) {
      toastApiError(err, t('toast.invalidCode'));
    } finally {
      setLoading(false);
    }
  };

  const handlePasskey = async () => {
    setLoading(true);
    try {
      const { options, challengeId } =
        await authApi.passkeyVerifyOptions(pendingToken);
      const response = await startAuthentication({ optionsJSON: options });
      const result = await authApi.passkeyVerify(
        pendingToken,
        response,
        challengeId,
      );
      await handleSuccess(result);
    } catch (err) {
      toastApiError(err, t('toast.passkeyAuthFailed'));
    } finally {
      setLoading(false);
    }
  };

  const tabs = pendingMethods.filter((m): m is Tab =>
    ['totp', 'email_otp', 'passkey'].includes(m),
  );
  const tabLabels: Record<Tab, string> = {
    totp: t('auth.authenticatorApp'),
    email_otp: t('auth.emailCode'),
    passkey: t('auth.passkey'),
  };

  return (
    <AuthCard>
      <CardHeader>
        <CardTitle>{t('auth.twoFactor')}</CardTitle>
        <CardDescription>{t('auth.twoFactorDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {tabs.length > 1 && (
          <div className="flex gap-1 mb-6 border-b">
            {tabs.map((t_) => (
              <button
                key={t_}
                type="button"
                onClick={() => {
                  setTab(t_);
                  setCode('');
                  setOtpSent(false);
                }}
                className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  tab === t_
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {tabLabels[t_]}
              </button>
            ))}
          </div>
        )}

        {tab === 'totp' && (
          <form onSubmit={handleTotpVerify} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="totp-code">{t('auth.sixDigitCode')}</Label>
              <OtpInput
                id="totp-code"
                value={code}
                onChange={setCode}
                autoFocus
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              loading={loading}
              disabled={code.length < 6}
            >
              {t('auth.verify')}
            </Button>
          </form>
        )}

        {tab === 'email_otp' && (
          <div className="space-y-4">
            {!otpSent ? (
              <Button
                className="w-full"
                onClick={handleEmailSend}
                loading={loading}
              >
                {t('auth.sendCode')}
              </Button>
            ) : (
              <form onSubmit={handleEmailVerify} className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="email-code">
                    {t('auth.sixDigitFromEmail')}
                  </Label>
                  <OtpInput
                    id="email-code"
                    value={code}
                    onChange={setCode}
                    autoFocus
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  loading={loading}
                  disabled={code.length < 6}
                >
                  {t('auth.verify')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={handleEmailSend}
                >
                  {t('auth.resendCode')}
                </Button>
              </form>
            )}
          </div>
        )}

        {tab === 'passkey' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('auth.passkeyDesc')}
            </p>
            <Button
              className="w-full"
              onClick={handlePasskey}
              loading={loading}
            >
              {t('auth.verifyWithPasskey')}
            </Button>
          </div>
        )}
      </CardContent>
    </AuthCard>
  );
}
