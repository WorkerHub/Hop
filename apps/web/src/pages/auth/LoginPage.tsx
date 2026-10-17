import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
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
import { useAppConfig } from '@/contexts/AppConfigContext';
import { useAuth } from '@/contexts/AuthContext';
import { useTranslation } from '@/i18n';

export default function LoginPage() {
  const { login, setPendingState } = useAuth();
  const {
    registrationEnabled,
    loadFailed: configLoadFailed,
    reload: reloadConfig,
  } = useAppConfig();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await login(email, password);
      if (result.requiresTwoFactor && result.pendingToken && result.methods) {
        setPendingState(result.pendingToken, result.methods);
        navigate('/two-factor');
      } else {
        navigate('/dashboard');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard>
      <CardHeader>
        <CardTitle className="text-2xl">{t('auth.signIn')}</CardTitle>
        <CardDescription>{t('auth.signInDesc')}</CardDescription>
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
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Link
                to="/forgot-password"
                className="text-xs text-primary hover:underline"
              >
                {t('auth.forgotPassword')}
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" className="w-full" loading={loading}>
            {t('auth.signIn')}
          </Button>
        </form>
        {/* FE-R3: Say so when /api/config failed instead of silently hiding
            the register link. */}
        {configLoadFailed && (
          <p
            className="mt-4 text-center text-sm text-muted-foreground"
            role="alert"
          >
            {t('auth.configLoadFailed')}{' '}
            <button
              type="button"
              onClick={reloadConfig}
              className="text-primary hover:underline"
            >
              {t('common.retry')}
            </button>
          </p>
        )}
        {registrationEnabled && (
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('auth.noAccount')}{' '}
            <Link to="/register" className="text-primary hover:underline">
              {t('auth.register')}
            </Link>
          </p>
        )}
      </CardContent>
    </AuthCard>
  );
}
