import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { authApi, setAccessToken } from '@/api/client';
import { ResendCodeButton } from '@/components/resend-code-button';
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
import { OtpInput } from '@/components/ui/otp-input';
import { useAppConfig } from '@/contexts/AppConfigContext';
import { useAuth } from '@/contexts/AuthContext';
import { useCountdown } from '@/hooks/use-countdown';
import { useTranslation } from '@/i18n';
import { RESEND_COUNTDOWN_SECONDS } from '@/lib/constants';
import { toastApiError } from '@/lib/toast';

type Step = 'form' | 'verify';

export default function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    registrationEnabled,
    isLoading: configLoading,
    loadFailed: configLoadFailed,
    reload: reloadConfig,
  } = useAppConfig();
  const { refreshUser, broadcastRefresh, setPendingState } = useAuth();
  const [step, setStep] = useState<Step>('form');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [userId, setUserId] = useState('');
  const [code, setCode] = useState('');
  const { countdown, start: startCountdown } = useCountdown();

  // FE-R3: Decide only once /api/config has answered — the provider's initial
  // `registrationEnabled = false` used to bounce every direct visit to /login.
  useEffect(() => {
    if (configLoading || configLoadFailed) return;
    if (!registrationEnabled) navigate('/login', { replace: true });
  }, [configLoading, configLoadFailed, registrationEnabled, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await authApi.register(email, username, password);
      if (result.requiresEmailVerification && result.userId) {
        setUserId(result.userId);
        startCountdown(RESEND_COUNTDOWN_SECONDS);
        setStep('verify');
      } else {
        toast.success(t('auth.accountCreated'));
        navigate('/login');
      }
    } catch (err) {
      toastApiError(err, t('toast.registrationFailed'), t);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await authApi.verifyEmail(userId, code);
      // FE-C4: Only a response carrying an access token is a signed-in session;
      // anything else would land on /dashboard and be bounced to /login.
      if (result.requiresTwoFactor && result.pendingToken && result.methods) {
        setPendingState(result.pendingToken, result.methods);
        navigate('/two-factor', { replace: true });
        return;
      }
      if (!result.accessToken) {
        toast.success(t('auth.emailVerifiedSignIn'));
        navigate('/login', { replace: true });
        return;
      }
      setAccessToken(result.accessToken);
      broadcastRefresh();
      await refreshUser();
      navigate('/dashboard', { replace: true });
    } catch (err) {
      toastApiError(err, t('toast.verificationFailed'), t);
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setLoading(true);
    try {
      await authApi.resendVerifyEmail(userId);
      setCode('');
      startCountdown(RESEND_COUNTDOWN_SECONDS);
      toast.success(t('auth.verifyCodeResent'));
    } catch (err) {
      toastApiError(err, t('toast.sendCodeFailed'), t);
    } finally {
      setLoading(false);
    }
  };

  if (step === 'form' && (configLoading || configLoadFailed)) {
    return (
      <AuthCard>
        <CardHeader>
          <CardTitle className="text-2xl">{t('auth.createAccount')}</CardTitle>
        </CardHeader>
        <CardContent>
          {configLoading ? (
            <p className="text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-destructive" role="alert">
                {t('auth.configLoadFailed')}
              </p>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={reloadConfig}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link to="/login" className="text-primary hover:underline">
              {t('auth.backToLogin')}
            </Link>
          </p>
        </CardContent>
      </AuthCard>
    );
  }

  if (step === 'verify') {
    return (
      <AuthCard>
        <CardHeader>
          <CardTitle className="text-2xl">
            {t('auth.verifyEmailTitle')}
          </CardTitle>
          <CardDescription>
            {t('auth.verifyEmailDesc', { email })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-4">
            {t('auth.codeValidFor')}
          </p>
          <form onSubmit={handleVerify} className="space-y-4">
            <div className="space-y-1">
              <Label>{t('auth.verificationCode')}</Label>
              <OtpInput value={code} onChange={setCode} autoFocus />
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
          <p className="mt-4 text-center text-sm text-muted-foreground">
            <ResendCodeButton
              countdown={countdown}
              onResend={handleResend}
              loading={loading}
            />
          </p>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            <Link to="/login" className="text-primary hover:underline">
              {t('auth.backToLogin')}
            </Link>
          </p>
        </CardContent>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <CardHeader>
        <CardTitle className="text-2xl">{t('auth.createAccount')}</CardTitle>
        <CardDescription>{t('auth.createAccountDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="email">{t('auth.email')}</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="username">{t('auth.username')}</Label>
            <Input
              id="username"
              type="text"
              placeholder="johndoe"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">{t('auth.password')}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              minLength={8}
            />
            <p className="text-xs text-muted-foreground">
              {t('auth.passwordHint')}
            </p>
          </div>
          <Button type="submit" className="w-full" loading={loading}>
            {t('auth.createAccount')}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t('auth.alreadyAccount')}{' '}
          <Link to="/login" className="text-primary hover:underline">
            {t('auth.signInLink')}
          </Link>
        </p>
      </CardContent>
    </AuthCard>
  );
}
