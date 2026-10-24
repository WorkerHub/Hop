import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { type CreateLinkPayload, type Link, linksApi } from '@/api/client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  LinkActionCell,
  LinkDestinationCell,
  LinkExpiryCell,
  LinkSlugCell,
  LinkStatusCell,
} from '@/components/link-table-cells';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useTranslation } from '@/i18n';
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants';
import { toastApiError } from '@/lib/toast';
import {
  formatDate,
  fromDatetimeLocalValue,
  toDatetimeLocalValue,
} from '@/lib/utils';

export default function LinksPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [editLink, setEditLink] = useState<Link | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['links', page, debouncedSearch],
    queryFn: () =>
      linksApi.list({
        page,
        limit: 20,
        search: debouncedSearch || undefined,
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => linksApi.delete(id),
    onSuccess: () => {
      toast.success(t('toast.linkDeleted'));
      queryClient.invalidateQueries({ queryKey: ['links'] });
      setDeleteId(null);
    },
    onError: (err) => toastApiError(err, t('toast.deleteLinkFailed'), t),
  });

  return (
    <div className="space-y-6 p-6 animate-enter">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-h1 font-bold tracking-tight">
            {t('links.title')}
          </h1>
          <p className="text-body text-muted-foreground">
            {t('links.titleDesc')}
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          {t('links.createLink')}
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('links.searchPlaceholder')}
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
      ) : !data?.links.length ? (
        <div className="py-16 text-center text-body text-muted-foreground">
          {t('links.noLinks')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="w-12 px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  #
                </th>
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('links.shortLink')}
                </th>
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('links.destination')}
                </th>
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('links.clicks')}
                </th>
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('links.expiry')}
                </th>
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('common.status')}
                </th>
                <th className="px-4 py-3 text-left text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('common.created')}
                </th>
                <th className="px-4 py-3 text-right text-caption font-medium tracking-caps text-muted-foreground uppercase">
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.links.map((link) => (
                <tr
                  key={link.id}
                  className="border-b last:border-0 transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-muted/20"
                >
                  <td className="px-4 py-3 text-micro text-muted-foreground">
                    {link.user_seq}
                  </td>
                  <LinkSlugCell slug={link.slug} />
                  <LinkDestinationCell url={link.destination_url} />
                  <td className="px-4 py-3 font-mono font-semibold tabular-nums">
                    {link.click_count ?? 0}
                  </td>
                  <LinkExpiryCell expiresAt={link.expires_at} />
                  <LinkStatusCell
                    isActive={link.is_active}
                    expiresAt={link.expires_at}
                  />
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDate(link.created_at)}
                  </td>
                  <LinkActionCell
                    link={link}
                    onEdit={(l) => setEditLink(l)}
                    onDelete={(id) => setDeleteId(id)}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pagination.pages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-body text-muted-foreground">
            {t('links.totalLinks', { count: data.pagination.total })}
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

      <CreateLinkDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['links'] });
          setShowCreate(false);
        }}
      />

      {editLink && (
        <EditLinkDialog
          link={editLink}
          open={!!editLink}
          onOpenChange={(o) => !o && setEditLink(null)}
          onUpdated={() => {
            queryClient.invalidateQueries({ queryKey: ['links'] });
            setEditLink(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title={t('links.deleteTitle')}
        description={t('links.deleteDesc')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        loading={deleteMutation.isPending}
        onConfirm={() => deleteId && deleteMutation.mutate(deleteId)}
      />
    </div>
  );
}

// ─── Create Link Dialog ────────────────────────────────────────────────────────

function CreateLinkDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<CreateLinkPayload>({ destinationUrl: '' });
  const [expiryOption, setExpiryOption] = useState<
    'never' | '1' | '7' | '30' | 'custom'
  >('never');
  // Raw datetime-local value for the "custom" option, kept apart from `form` so
  // switching options can never leave a stale timestamp in the payload.
  const [customExpiry, setCustomExpiry] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      // FE-C1: The backend gives expiresAt precedence over expiryDays, so only
      // the field matching the currently selected option may be sent.
      const payload: CreateLinkPayload = { ...form };
      if (expiryOption === 'custom') {
        payload.expiresAt = fromDatetimeLocalValue(customExpiry);
      } else if (expiryOption !== 'never') {
        payload.expiryDays = parseInt(expiryOption, 10);
      }
      await linksApi.create(payload);
      toast.success(t('toast.linkCreated'));
      setForm({ destinationUrl: '' });
      setExpiryOption('never');
      setCustomExpiry('');
      onCreated();
    } catch (err) {
      toastApiError(err, t('toast.createLinkFailed'), t);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('links.createTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="url">{t('links.destinationUrl')}</Label>
            <Input
              id="url"
              type="url"
              placeholder="https://example.com/very-long-url"
              value={form.destinationUrl}
              onChange={(e) =>
                setForm((f) => ({ ...f, destinationUrl: e.target.value }))
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="slug">{t('links.customSlug')}</Label>
            <Input
              id="slug"
              type="text"
              placeholder={t('links.slugPlaceholder')}
              value={form.customSlug ?? ''}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  customSlug: e.target.value || undefined,
                }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="title">{t('links.titleField')}</Label>
            <Input
              id="title"
              type="text"
              placeholder={t('links.titlePlaceholder')}
              value={form.title ?? ''}
              onChange={(e) =>
                setForm((f) => ({ ...f, title: e.target.value || undefined }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>{t('links.expiryLabel')}</Label>
            <div className="flex flex-wrap gap-2">
              {(['never', '1', '7', '30', 'custom'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setExpiryOption(opt)}
                  className={`rounded-md border px-3 py-1 text-caption transition-colors duration-(--duration-fast) ease-(--ease-out) ${
                    expiryOption === opt
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input hover:bg-accent hover:text-accent-foreground'
                  }`}
                >
                  {opt === 'never'
                    ? t('links.never')
                    : opt === 'custom'
                      ? t('links.custom')
                      : `${opt}d`}
                </button>
              ))}
            </div>
            {expiryOption === 'custom' && (
              <Input
                type="datetime-local"
                value={customExpiry}
                onChange={(e) => setCustomExpiry(e.target.value)}
              />
            )}
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

// ─── Edit Link Dialog ──────────────────────────────────────────────────────────

export function EditLinkDialog({
  link,
  open,
  onOpenChange,
  onUpdated,
}: {
  link: Link;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onUpdated: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    destinationUrl: link.destination_url,
    customSlug: link.slug,
    title: link.title ?? '',
    // FE-Q3: `is_active` is a boolean after client normalization.
    isActive: link.is_active,
  });
  const [expiresAt, setExpiresAt] = useState<number | null>(link.expires_at);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await linksApi.update(link.id, {
        destinationUrl: form.destinationUrl,
        customSlug: form.customSlug,
        title: form.title || undefined,
        isActive: form.isActive,
        // Only send expiresAt when it was edited: re-sending an unchanged past
        // expiry would make the backend reject edits to an expired link.
        ...(expiresAt !== link.expires_at && { expiresAt }),
      });
      toast.success(t('toast.linkUpdated'));
      onUpdated();
    } catch (err) {
      toastApiError(err, t('toast.updateLinkFailed'), t);
    } finally {
      setLoading(false);
    }
  };

  const expiresAtInputValue = toDatetimeLocalValue(expiresAt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('links.editTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>{t('links.destinationUrl')}</Label>
            <Input
              type="url"
              value={form.destinationUrl}
              onChange={(e) =>
                setForm((f) => ({ ...f, destinationUrl: e.target.value }))
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label>{t('links.shortLink')}</Label>
            <Input
              value={form.customSlug}
              onChange={(e) =>
                setForm((f) => ({ ...f, customSlug: e.target.value }))
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label>{t('links.titleField')}</Label>
            <Input
              value={form.title}
              onChange={(e) =>
                setForm((f) => ({ ...f, title: e.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>{t('links.expiryFieldLabel')}</Label>
            <Input
              type="datetime-local"
              value={expiresAtInputValue}
              onChange={(e) =>
                setExpiresAt(fromDatetimeLocalValue(e.target.value))
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="active"
              checked={form.isActive}
              onChange={(e) =>
                setForm((f) => ({ ...f, isActive: e.target.checked }))
              }
              className="h-4 w-4 accent-primary"
            />
            <Label htmlFor="active">{t('links.activeLabel')}</Label>
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
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
