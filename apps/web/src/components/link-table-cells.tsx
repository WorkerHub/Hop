import { BarChart2, Copy, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Link } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import {
  buildShortUrl,
  copyToClipboard,
  expiryParts,
  isExpired,
  isSafeUrl,
} from '@/lib/utils';

export function LinkSlugCell({ slug }: { slug: string }) {
  const { t } = useTranslation();
  return (
    <td className="px-4 py-3 font-mono">
      <div className="flex items-center gap-1">
        <span className="text-primary">{slug}</span>
        <button
          type="button"
          onClick={() => {
            // FE-R5: clipboard access can be denied (permissions, insecure
            // context) — report it instead of leaving a rejected promise.
            copyToClipboard(buildShortUrl(slug))
              .then(() => toast.success(t('toast.copied')))
              .catch(() => toast.error(t('toast.copyFailed')));
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <Copy className="h-3 w-3" />
        </button>
      </div>
    </td>
  );
}

export function LinkDestinationCell({ url }: { url: string }) {
  // FE-S2: Only render the URL as a clickable link when its protocol is http/https.
  return (
    <td className="px-4 py-3 max-w-xs">
      <div className="flex items-center gap-1 truncate">
        <span className="truncate text-muted-foreground">{url}</span>
        {isSafeUrl(url) && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </td>
  );
}

export function LinkExpiryCell({ expiresAt }: { expiresAt: number | null }) {
  const { t } = useTranslation();
  const parts = expiryParts(expiresAt);
  let label: string;
  switch (parts.kind) {
    case 'never':
      label = t('common.never');
      break;
    case 'expired':
      label = t('common.expired');
      break;
    case 'minutes':
      label = t('links.minutesRemaining', { count: parts.value });
      break;
    case 'hours':
      label = t('links.hoursRemaining', { count: parts.value });
      break;
    case 'days':
      label = t('links.daysRemaining', { count: parts.value });
      break;
  }
  return <td className="px-4 py-3 text-muted-foreground">{label}</td>;
}

export function LinkStatusCell({
  isActive,
  expiresAt,
}: {
  // FE-Q3: normalized to a real boolean in the API client.
  isActive: boolean;
  expiresAt: number | null;
}) {
  const { t } = useTranslation();
  return (
    <td className="px-4 py-3">
      {!isActive ? (
        <Badge variant="secondary">{t('common.inactive')}</Badge>
      ) : isExpired(expiresAt) ? (
        <Badge variant="destructive">{t('common.expired')}</Badge>
      ) : (
        <Badge variant="success">{t('common.active')}</Badge>
      )}
    </td>
  );
}

export function LinkActionCell({
  link,
  onEdit,
  onDelete,
}: {
  link: Link;
  onEdit: (link: Link) => void;
  onDelete: (id: string) => void;
}) {
  const navigate = useNavigate();
  return (
    <td className="px-4 py-3">
      <div className="flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(`/dashboard/analytics?linkId=${link.id}`)}
        >
          <BarChart2 className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => onEdit(link)}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(link.id)}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </td>
  );
}
