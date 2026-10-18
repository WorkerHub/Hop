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
    onError: (err) => toastApiError(err, t('toast.deleteLinkFailed')),
  });

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-6">{t('admin.allLinks')}</h1>
      <div className="relative mb-4">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
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
        <div className="text-center py-12 text-muted-foreground">
          {t('common.loading')}
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
                  {t('common.user')}
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
              {data?.links.map((link) => (
                <tr
                  key={link.id}
                  className="border-b last:border-0 hover:bg-muted/20"
                >
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {link.seq}
                  </td>
                  <LinkSlugCell slug={link.slug} />
                  <LinkDestinationCell url={link.destination_url} />
                  <td className="px-4 py-3 text-muted-foreground">
                    {link.user_username}
                  </td>
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
        <div className="flex justify-between items-center mt-4">
          <span className="text-sm text-muted-foreground">
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
