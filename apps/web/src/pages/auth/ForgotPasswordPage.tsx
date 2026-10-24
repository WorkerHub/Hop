import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { authApi } from '@/api/client';
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
import { useCountdown } from '@/hooks/use-countdown';
import { useTranslation } from '@/i18n';
import { RESEND_COUNTDOWN_SECONDS } from '@/lib/constants';
import { toastApiError } from '@/lib/toast';

type Step = 'email' | 'code' | 'password';

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { countdown, start: startCountdown } = useCountdown();

  // Shared: send/resend reset code — always silent, never surfaces errors (no user enumeration)
  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setLoading(true);
    try {
      await authApi.forgotPassword(email);
    } catch {
      // Silently ignore — the user should never know whether the email exists
    } finally {
      setLoading(false);
    }
    setCode('');
    startCountdown(RESEND_COUNTDOWN_SECONDS);
    setStep('code');
  };

  // Step 2: verify code — if correct, advance to password step
  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await authApi.verifyResetCode(email, code);
      setStep('password');
    } catch (err) {
      toastApiError(err, t('toast.invalidCode'), t);
    } finally {
      setLoading(false);
    }
  };

  // Step 3: set new password
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error(t('settings.passwordsDoNotMatch'));
      return;
    }
    setLoading(true);
    try {
      await authApi.resetPassword(email, code, newPassword);
      toast.success(t('auth.resetSuccess'));
      navigate('/login');
    } catch (err) {
      toastApiError(err, t('toast.resetPasswordFailed'), t);
    } finally {
      setLoading(false);
    }
  };

  if (step === 'password') {
    return (
      <AuthCard>
        <CardHeader>
          <CardTitle>{t('auth.newPasswordTitle')}</CardTitle>
          <CardDescription>{t('auth.newPasswordDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>{t('settings.newPassword')}</Label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
              <p className="text-caption text-muted-foreground">
                {t('auth.passwordHint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t('settings.confirmPassword')}</Label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full" loading={loading}>
              {t('auth.resetPassword')}
            </Button>
          </form>
        </CardContent>
      </AuthCard>
    );
  }

  if (step === 'code') {
    return (
      <AuthCard>
        <CardHeader>
          <CardTitle>{t('auth.forgotPasswordTitle')}</CardTitle>
          <CardDescription>
            {t('auth.resetCodeSentTo', { email })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-caption text-muted-foreground mb-4">
            {t('auth.codeValidFor')}
          </p>
          <form onSubmit={handleCodeSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>{t('auth.resetCode')}</Label>
              <OtpInput
                value={code}
                onChange={setCode}
                autoFocus
                placeholder={t('auth.resetCodePlaceholder')}
              />
            </div>
            <Button type="submit" className="w-full" loading={loading}>
              {t('auth.verifyCode')}
            </Button>
          </form>
          <p className="mt-4 text-center text-body text-muted-foreground">
            <ResendCodeButton
              countdown={countdown}
              onResend={sendCode}
              loading={loading}
            />
          </p>
          <p className="mt-2 text-center text-body text-muted-foreground">
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
        <CardTitle>{t('auth.forgotPasswordTitle')}</CardTitle>
        <CardDescription>{t('auth.forgotPasswordDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={sendCode} className="space-y-4">
          <div className="space-y-2">
            <Label>{t('auth.email')}</Label>
            <Input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <Button type="submit" className="w-full" loading={loading}>
            {t('auth.sendResetCode')}
          </Button>
        </form>
        <p className="mt-4 text-center text-body text-muted-foreground">
          <Link to="/login" className="text-primary hover:underline">
            {t('auth.backToLogin')}
          </Link>
        </p>
      </CardContent>
    </AuthCard>
  );
}
