import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { type CreateLinkPayload, type Link, linksApi } from '@/api/client';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import {
  formatDate,
  fromDatetimeLocalValue,
  toDatetimeLocalValue,
} from '@/lib/utils';

export default function LinksPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [editLink, setEditLink] = useState<Link | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['links', page, search],
    queryFn: () =>
      linksApi.list({ page, limit: 20, search: search || undefined }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => linksApi.delete(id),
    onSuccess: () => {
      toast.success('Link deleted');
      queryClient.invalidateQueries({ queryKey: ['links'] });
      setDeleteId(null);
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Delete failed'),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">{t('links.title')}</h1>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          {t('links.createLink')}
        </Button>
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
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
        <div className="text-center py-12 text-muted-foreground">
          {t('common.loading')}
        </div>
      ) : !data?.links.length ? (
        <div className="text-center py-12 text-muted-foreground">
          {t('links.noLinks')}
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium w-12">#</th>
                <th className="px-4 py-3 text-left font-medium">
                  {t('links.shortLink')}
                </th>
                <th className="px-4 py-3 text-left font-medium">
                  {t('links.destination')}
                </th>
                <th className="px-4 py-3 text-left font-medium">
                  {t('links.clicks')}
                </th>
                <th className="px-4 py-3 text-left font-medium">
                  {t('links.expiry')}
                </th>
                <th className="px-4 py-3 text-left font-medium">
                  {t('common.status')}
                </th>
                <th className="px-4 py-3 text-left font-medium">
                  {t('common.created')}
                </th>
                <th className="px-4 py-3 text-right font-medium">
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.links.map((link) => (
                <tr
                  key={link.id}
                  className="border-b last:border-0 hover:bg-muted/20"
                >
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {link.user_seq}
                  </td>
                  <LinkSlugCell slug={link.slug} />
                  <LinkDestinationCell url={link.destination_url} />
                  <td className="px-4 py-3 text-muted-foreground">
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
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-muted-foreground">
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

      <Dialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('links.deleteTitle')}</DialogTitle>
            <DialogDescription>{t('links.deleteDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={deleteMutation.isPending}
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            >
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
      toast.success('Link created!');
      setForm({ destinationUrl: '' });
      setExpiryOption('never');
      setCustomExpiry('');
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create link');
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
          <div className="space-y-1">
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
          <div className="space-y-1">
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
          <div className="space-y-1">
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
                  className={`px-3 py-1 rounded-md text-sm border transition-colors ${
                    expiryOption === opt
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-input hover:bg-accent'
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
    isActive: !!link.is_active,
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
      toast.success('Link updated');
      onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
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
          <div className="space-y-1">
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
          <div className="space-y-1">
            <Label>{t('links.shortLink')}</Label>
            <Input
              value={form.customSlug}
              onChange={(e) =>
                setForm((f) => ({ ...f, customSlug: e.target.value }))
              }
              required
            />
          </div>
          <div className="space-y-1">
            <Label>{t('links.titleField')}</Label>
            <Input
              value={form.title}
              onChange={(e) =>
                setForm((f) => ({ ...f, title: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1">
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
              className="h-4 w-4"
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
