import { lazy, type ReactNode, Suspense } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { Button } from './components/ui/button.tsx';
import { useAuth } from './contexts/AuthContext.tsx';
import { useTranslation } from './i18n/index.tsx';

const AdminLayout = lazy(() => import('./components/layout/AdminLayout.tsx'));
const DashboardLayout = lazy(
  () => import('./components/layout/DashboardLayout.tsx'),
);
const AdminLinksPage = lazy(() => import('./pages/admin/AdminLinksPage.tsx'));
const AdminSettingsPage = lazy(
  () => import('./pages/admin/AdminSettingsPage.tsx'),
);
const AdminUsersPage = lazy(() => import('./pages/admin/AdminUsersPage.tsx'));
const ForgotPasswordPage = lazy(
  () => import('./pages/auth/ForgotPasswordPage.tsx'),
);
const LoginPage = lazy(() => import('./pages/auth/LoginPage.tsx'));
const RegisterPage = lazy(() => import('./pages/auth/RegisterPage.tsx'));
const TwoFactorPage = lazy(() => import('./pages/auth/TwoFactorPage.tsx'));
const AnalyticsPage = lazy(() => import('./pages/dashboard/AnalyticsPage.tsx'));
const LinksPage = lazy(() => import('./pages/dashboard/LinksPage.tsx'));
const SettingsPage = lazy(() => import('./pages/dashboard/SettingsPage.tsx'));

function PageFallback() {
  return (
    <div className="flex h-screen items-center justify-center">Loading...</div>
  );
}

// FE-R1: Shown instead of the login redirect when the session could not be
// restored for a transient reason — the refresh cookie may still be valid.
function SessionRestoreFailed() {
  const { retryRestore } = useAuth();
  const { t } = useTranslation();
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 text-center">
      <p className="text-sm text-muted-foreground" role="alert">
        {t('auth.sessionRestoreFailed')}
      </p>
      <Button type="button" onClick={retryRestore}>
        {t('common.retry')}
      </Button>
      <Link to="/login" className="text-sm text-primary hover:underline">
        {t('auth.signInLink')}
      </Link>
    </div>
  );
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, isLoading, restoreFailed } = useAuth();
  if (isLoading) return <PageFallback />;
  if (!user && restoreFailed) return <SessionRestoreFailed />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminRoute({ children }: { children: ReactNode }) {
  const { user, isLoading, restoreFailed } = useAuth();
  if (isLoading) return <PageFallback />;
  if (!user && restoreFailed) return <SessionRestoreFailed />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

export default function App() {
  const { user, isLoading, restoreFailed } = useAuth();

  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        {/* Public */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/two-factor" element={<TwoFactorPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />

        {/* Dashboard */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<LinksPage />} />
          <Route path="links" element={<LinksPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        {/* Admin */}
        <Route
          path="/admin"
          element={
            <AdminRoute>
              <AdminLayout />
            </AdminRoute>
          }
        >
          <Route index element={<AdminUsersPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="links" element={<AdminLinksPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
        </Route>

        {/* Root redirect — wait for auth state before redirecting */}
        <Route
          path="/"
          element={
            isLoading ? (
              <PageFallback />
            ) : (
              <Navigate
                to={user || restoreFailed ? '/dashboard' : '/login'}
                replace
              />
            )
          }
        />
        <Route
          path="/404"
          element={
            <div className="flex h-screen items-center justify-center text-muted-foreground">
              Link not found or expired.
            </div>
          }
        />
        <Route path="*" element={<Navigate to="/404" replace />} />
      </Routes>
    </Suspense>
  );
}
