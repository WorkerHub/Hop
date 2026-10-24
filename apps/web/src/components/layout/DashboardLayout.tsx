import { BarChart2, Link2, LogOut, Menu, Settings, Shield } from 'lucide-react';
import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAppConfig } from '@/contexts/AppConfigContext';
import { useAuth } from '@/contexts/AuthContext';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const { appName } = useAppConfig();
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = [
    { to: '/dashboard/links', label: t('nav.links'), icon: Link2 },
    { to: '/dashboard/analytics', label: t('nav.analytics'), icon: BarChart2 },
    { to: '/dashboard/settings', label: t('nav.settings'), icon: Settings },
  ];

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const navLinkClass = (to: string) => {
    const isActive = location.pathname.startsWith(to);
    return {
      className: cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-body font-medium tracking-wide transition-colors duration-(--duration-fast) ease-(--ease-out)',
        isActive
          ? 'bg-accent font-semibold text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      ),
      'aria-current': isActive ? ('page' as const) : undefined,
    };
  };

  const sidebarContent = (
    <>
      <div className="border-b p-4">
        <Link
          to="/dashboard"
          className="flex items-center gap-2 transition-opacity duration-(--duration-fast) ease-(--ease-out) hover:opacity-80"
          onClick={() => setMobileOpen(false)}
        >
          <img src="/logo.svg" alt="" className="h-6 w-6 shrink-0" />
          <span className="text-h3 font-bold tracking-tight">{appName}</span>
        </Link>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {navItems.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            onClick={() => setMobileOpen(false)}
            {...navLinkClass(to)}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
        {user?.role === 'admin' && (
          <Link
            to="/admin"
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-3 rounded-md px-3 py-2 text-body font-medium tracking-wide text-muted-foreground transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-accent hover:text-accent-foreground"
          >
            <Shield className="h-4 w-4" />
            {t('nav.admin')}
          </Link>
        )}
      </nav>
      <div className="p-3 border-t">
        <div className="mb-2 truncate px-3 py-1 text-caption text-muted-foreground">
          {user?.email}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4" />
          {t('nav.logout')}
        </Button>
      </div>
    </>
  );

  return (
    <div className="flex h-screen bg-background">
      {mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50 animate-backdrop-in md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label={t('common.closeMenu')}
        />
      )}

      <aside
        className={cn(
          'flex flex-col w-60 border-r bg-background',
          'fixed inset-y-0 left-0 z-50 transition-transform duration-(--duration-slow) ease-(--ease-out) md:relative md:z-auto md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {sidebarContent}
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3 md:hidden">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('common.openMenu')}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-h3 font-bold tracking-tight"
          >
            <img src="/logo.svg" alt="" className="h-6 w-6 shrink-0" />
            {appName}
          </Link>
        </div>

        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
