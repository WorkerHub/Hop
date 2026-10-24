import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { adminApi } from '@/api/client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useTranslation } from '@/i18n';
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants';
import { toastApiError } from '@/lib/toast';
import { formatDate } from '@/lib/utils';

export default function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [page, setPage] = useState(1);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', page, debouncedSearch],
    queryFn: () =>
      adminApi.users({ page, search: debouncedSearch || undefined }),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: { isActive?: boolean; role?: 'admin' | 'user' };
    }) => adminApi.updateUser(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success(t('toast.userUpdated'));
    },
    onError: (err) => toastApiError(err, t('toast.updateUserFailed'), t),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => adminApi.deleteUser(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success(t('toast.userDeleted'));
      setDeleteId(null);
    },
    onError: (err) => toastApiError(err, t('toast.deleteUserFailed'), t),
  });

  // FE-C5: while any mutation (update or delete) is in flight for a user, all of
  // that user's controls are disabled — otherwise a PATCH could race the DELETE
  // (or a second PATCH) and fire conflicting requests.
  const updatePendingId = updateMutation.isPending
    ? updateMutation.variables?.id
    : undefined;
  const deletePendingId = deleteMutation.isPending
    ? deleteMutation.variables
    : undefined;
  const isRowPending = (id: string) =>
    id === updatePendingId || id === deletePendingId;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-h1 font-bold tracking-tight">
            {t('admin.users')}
          </h1>
          <p className="text-body text-muted-foreground">
            {t('admin.usersDesc')}
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <UserPlus className="h-4 w-4" />
          {t('admin.createUser')}
        </Button>
      </div>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('admin.searchUsersPlaceholder')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-body text-muted-foreground">
          {t('common.loading')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('common.user')}
                </th>
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('admin.role')}
                </th>
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('admin.twoFA')}
                </th>
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('common.status')}
                </th>
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('admin.joined')}
                </th>
                <th className="px-4 py-3 text-right text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.users.map((u) => (
                <tr
                  key={u.id}
                  className="border-b last:border-0 transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-muted/20"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.username}</div>
                    <div className="text-caption text-muted-foreground">
                      {u.email}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={u.role}
                      disabled={u.id === currentUser?.id || isRowPending(u.id)}
                      onChange={(e) =>
                        updateMutation.mutate({
                          id: u.id,
                          payload: { role: e.target.value as 'admin' | 'user' },
                        })
                      }
                      className="flex h-9 rounded-md border border-input bg-background px-2 text-body shadow-xs transition-colors duration-(--duration-fast) ease-(--ease-out) focus-visible:outline-none focus-visible:shadow-(--shadow-focus) disabled:opacity-50"
                    >
                      <option value="user">{t('common.user')}</option>
                      <option value="admin">{t('common.admin')}</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {u.totp_enabled ? (
                        <Badge variant="secondary">TOTP</Badge>
                      ) : null}
                      {u.passkey_enabled ? (
                        <Badge variant="secondary">Passkey</Badge>
                      ) : null}
                      {u.email_2fa_enabled ? (
                        <Badge variant="secondary">Email</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      disabled={u.id === currentUser?.id || isRowPending(u.id)}
                      onClick={() =>
                        updateMutation.mutate({
                          id: u.id,
                          payload: { isActive: !u.is_active },
                        })
                      }
                      className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Badge variant={u.is_active ? 'success' : 'destructive'}>
                        {u.is_active
                          ? t('common.active')
                          : t('common.inactive')}
                      </Badge>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDate(u.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={
                          u.id === currentUser?.id || isRowPending(u.id)
                        }
                        onClick={() => setDeleteId(u.id)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pagination.pages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-body text-muted-foreground">
            {t('admin.totalUsers', { count: data.pagination.total })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              {t('common.previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.pagination.pages}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('common.next')}
            </Button>
          </div>
        </div>
      )}

      {/* Create User Dialog */}
      <CreateUserDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['admin-users'] });
          setShowCreate(false);
        }}
      />

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title={t('admin.deleteUser')}
        description={t('admin.deleteUserDesc')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        loading={deleteMutation.isPending}
        onConfirm={() => deleteId && deleteMutation.mutate(deleteId)}
      />
    </div>
  );
}

// ─── Create User Dialog ────────────────────────────────────────────────────────

function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    email: '',
    username: '',
    password: '',
    role: 'user' as 'admin' | 'user',
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await adminApi.createUser(form);
      toast.success(t('toast.userCreated'));
      setForm({ email: '', username: '', password: '', role: 'user' });
      onCreated();
    } catch (err) {
      toastApiError(err, t('toast.createUserFailed'), t);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('admin.createUserTitle')}</DialogTitle>
          <DialogDescription>{t('admin.createUserDesc')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>{t('auth.email')}</Label>
            <Input
              type="email"
              value={form.email}
              onChange={(e) =>
                setForm((f) => ({ ...f, email: e.target.value }))
              }
              required
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label>{t('auth.username')}</Label>
            <Input
              type="text"
              value={form.username}
              onChange={(e) =>
                setForm((f) => ({ ...f, username: e.target.value }))
              }
              required
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label>{t('auth.password')}</Label>
            <Input
              type="password"
              value={form.password}
              onChange={(e) =>
                setForm((f) => ({ ...f, password: e.target.value }))
              }
              required
              autoComplete="new-password"
              minLength={8}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('admin.role')}</Label>
            <select
              value={form.role}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  role: e.target.value as 'admin' | 'user',
                }))
              }
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-body shadow-xs transition-all duration-(--duration-fast) ease-(--ease-out) focus-visible:outline-none focus-visible:shadow-(--shadow-focus)"
            >
              <option value="user">{t('common.user')}</option>
              <option value="admin">{t('common.admin')}</option>
            </select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={loading}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
