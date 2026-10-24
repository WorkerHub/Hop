import { ArrowLeft, Link2, Menu, Settings, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

export default function AdminLayout() {
  const location = useLocation();
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = [
    { to: '/admin/users', label: t('admin.users'), icon: Users },
    { to: '/admin/links', label: t('admin.allLinks'), icon: Link2 },
    { to: '/admin/settings', label: t('nav.settings'), icon: Settings },
  ];

  const sidebarContent = (
    <>
      <div className="flex items-center gap-2 border-b p-4">
        <img src="/logo.svg" alt="" className="h-6 w-6 shrink-0" />
        <span className="text-h3 font-bold tracking-tight">
          {t('admin.adminPanel')}
        </span>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {navItems.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            onClick={() => setMobileOpen(false)}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-body font-medium tracking-wide transition-colors duration-(--duration-fast) ease-(--ease-out)',
              location.pathname === to
                ? 'bg-accent font-semibold text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="border-t p-3">
        <Link
          to="/dashboard"
          onClick={() => setMobileOpen(false)}
          className="flex items-center gap-3 rounded-md px-3 py-2 text-body font-medium tracking-wide text-muted-foreground transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-accent hover:text-accent-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('nav.backToDashboard')}
        </Link>
      </div>
    </>
  );

  return (
    <div className="flex h-screen bg-background">
      {mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu"
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
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="text-h3 font-bold tracking-tight">
            {t('admin.adminPanel')}
          </span>
        </div>

        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
