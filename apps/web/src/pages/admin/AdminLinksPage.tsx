import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Link } from '@/api/client';
import { adminApi, linksApi } from '@/api/client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  LinkActionCell,
  LinkDestinationCell,
  LinkExpiryCell,
  LinkSlugCell,
  LinkStatusCell,
} from '@/components/link-table-cells';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useTranslation } from '@/i18n';
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants';
import { toastApiError } from '@/lib/toast';
import { formatDate } from '@/lib/utils';
import { EditLinkDialog } from '@/pages/dashboard/LinksPage';

export default function AdminLinksPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [page, setPage] = useState(1);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editLink, setEditLink] = useState<Link | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-links', page, debouncedSearch],
    queryFn: () =>
      adminApi.links({ page, search: debouncedSearch || undefined }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => linksApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-links'] });
      toast.success(t('toast.linkDeleted'));
      setDeleteId(null);
    },
    onError: (err) => toastApiError(err, t('toast.deleteLinkFailed'), t),
  });

  return (
    <div className="space-y-6 p-6 animate-enter">
      <div className="space-y-1">
        <h1 className="text-h1 font-bold tracking-tight">
          {t('admin.allLinks')}
        </h1>
        <p className="text-body text-muted-foreground">
          {t('admin.allLinksDesc')}
        </p>
      </div>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('admin.searchLinksPlaceholder')}
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
                  {t('common.user')}
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
              {data?.links.map((link) => (
                <tr
                  key={link.id}
                  className="border-b last:border-0 transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-muted/20"
                >
                  <td className="px-4 py-3 text-micro text-muted-foreground">
                    {link.seq}
                  </td>
                  <LinkSlugCell slug={link.slug} />
                  <LinkDestinationCell url={link.destination_url} />
                  <td className="px-4 py-3 text-muted-foreground">
                    {link.user_username}
                  </td>
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
            {t('admin.totalLinks', { count: data.pagination.total })}
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

      {editLink && (
        <EditLinkDialog
          link={editLink}
          open={!!editLink}
          onOpenChange={(o) => !o && setEditLink(null)}
          onUpdated={() => {
            queryClient.invalidateQueries({ queryKey: ['admin-links'] });
            setEditLink(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title={t('admin.deleteLink')}
        description={t('admin.deleteLinkDesc')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        loading={deleteMutation.isPending}
        onConfirm={() => deleteId && deleteMutation.mutate(deleteId)}
      />
    </div>
  );
}
