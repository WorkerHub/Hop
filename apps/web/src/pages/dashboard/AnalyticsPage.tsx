import { useQuery } from '@tanstack/react-query';
import { BarChart2, Search, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { type AnalyticsStats, analyticsApi, linksApi } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useTranslation } from '@/i18n';
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants';
import { isSafeUrl } from '@/lib/utils';

const COLORS = [
  '#6366f1',
  '#22d3ee',
  '#f59e0b',
  '#10b981',
  '#f43f5e',
  '#a855f7',
];

const DAY_OPTIONS = [7, 14, 30, 90] as const;
type DayOption = (typeof DAY_OPTIONS)[number];

function isDayOption(value: number): value is DayOption {
  return (DAY_OPTIONS as readonly number[]).includes(value);
}

export default function AnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();

  // FE-C5: the selection lives in the URL, so browser back/forward (and links
  // shared between tabs) restore the same link and range instead of only the
  // values present on the first render.
  const selectedLinkId = searchParams.get('linkId') ?? '';
  const daysParam = Number(searchParams.get('days'));
  const days: DayOption = isDayOption(daysParam) ? daysParam : 30;
  const [slugSearch, setSlugSearch] = useState('');
  const debouncedSlugSearch = useDebouncedValue(slugSearch, SEARCH_DEBOUNCE_MS);

  const updateParams = useCallback(
    (
      updates: { linkId?: string | null; days?: DayOption },
      replace = false,
    ) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (updates.linkId === null) next.delete('linkId');
          else if (updates.linkId !== undefined)
            next.set('linkId', updates.linkId);
          if (updates.days !== undefined)
            next.set('days', String(updates.days));
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );

  // Search links by slug to allow selection
  const { data: searchResults } = useQuery({
    queryKey: ['links-search', debouncedSlugSearch],
    queryFn: () =>
      linksApi.list({
        search: debouncedSlugSearch || undefined,
        limit: 10,
      }),
    enabled: debouncedSlugSearch.length > 0,
  });

  // If arrived with linkId, fetch just that link's details (to show slug in input)
  const { data: selectedLinkData } = useQuery({
    queryKey: ['link-detail', selectedLinkId],
    queryFn: () => linksApi.get(selectedLinkId),
    enabled: !!selectedLinkId,
  });

  // Summary (all links) query
  const summaryQuery = useQuery({
    queryKey: ['analytics-summary', days],
    queryFn: () => analyticsApi.summary(days),
    enabled: !selectedLinkId,
  });

  // Per-link query
  const linkQuery = useQuery({
    queryKey: ['analytics-link', selectedLinkId, days],
    queryFn: () => analyticsApi.get(selectedLinkId, days),
    enabled: !!selectedLinkId,
  });

  const isLoading = selectedLinkId
    ? linkQuery.isLoading
    : summaryQuery.isLoading;
  const error = selectedLinkId ? linkQuery.error : summaryQuery.error;
  const stats: AnalyticsStats | undefined = selectedLinkId
    ? linkQuery.data?.stats
    : summaryQuery.data?.stats;

  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    setShowDropdown(
      slugSearch.length > 0 && (searchResults?.links.length ?? 0) > 0,
    );
  }, [slugSearch, searchResults]);

  // Keep the search box in step when back/forward changes the selected link.
  useEffect(() => {
    if (!selectedLinkId) {
      setSlugSearch('');
      return;
    }
    if (selectedLinkData?.link.id === selectedLinkId) {
      setSlugSearch(selectedLinkData.link.slug);
    }
  }, [selectedLinkId, selectedLinkData]);

  const handleSelectLink = (linkId: string, slug: string) => {
    updateParams({ linkId });
    setSlugSearch(slug);
    setShowDropdown(false);
  };

  const handleClearLink = () => {
    updateParams({ linkId: null }, true);
    setSlugSearch('');
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{t('analytics.title')}</h1>

      {/* Link selector + day picker */}
      <div className="flex gap-3 items-end flex-wrap">
        <div className="flex-1 min-w-48 relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('analytics.linkSearchPlaceholder')}
            value={slugSearch}
            onChange={(e) => {
              setSlugSearch(e.target.value);
              if (!e.target.value) updateParams({ linkId: null }, true);
            }}
            className="pl-9 pr-8"
          />
          {slugSearch && (
            <button
              type="button"
              className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
              onClick={handleClearLink}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {showDropdown && (
            <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-md overflow-hidden">
              {searchResults?.links.map((link) => (
                <button
                  type="button"
                  key={link.id}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2"
                  onClick={() => handleSelectLink(link.id, link.slug)}
                >
                  <span className="font-mono text-primary">{link.slug}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {link.destination_url}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? 'default' : 'outline'}
              onClick={() => updateParams({ days: d })}
            >
              {d}d
            </Button>
          ))}
        </div>
      </div>

      {/* Header: show which mode we're in */}
      {!selectedLinkId && (
        <p className="text-sm text-muted-foreground">
          {t('analytics.allLinksStats')}
        </p>
      )}
      {selectedLinkId && selectedLinkData?.link && (
        <div className="text-sm text-muted-foreground">
          <span className="font-mono font-medium text-foreground">
            {selectedLinkData.link.slug}
          </span>
          {' → '}
          {/* FE-S2: Only render as a link when the protocol is http/https */}
          {isSafeUrl(selectedLinkData.link.destination_url) ? (
            <a
              href={selectedLinkData.link.destination_url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {selectedLinkData.link.destination_url}
            </a>
          ) : (
            <span>{selectedLinkData.link.destination_url}</span>
          )}
        </div>
      )}

      {isLoading && (
        <div className="text-center py-12 text-muted-foreground">
          {t('common.loading')}
        </div>
      )}
      {error && (
        <div className="text-destructive">{t('analytics.failedToLoad')}</div>
      )}

      {stats && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              title={t('analytics.totalClicks')}
              value={stats.totalClicks}
            />
            <StatCard
              title={t('analytics.countries')}
              value={stats.countries.length}
            />
            <StatCard
              title={t('analytics.topDevice')}
              value={stats.devices[0]?.device_type ?? '—'}
            />
            <StatCard
              title={t('analytics.topBrowser')}
              value={stats.browsers[0]?.browser ?? '—'}
            />
          </div>

          {/* Top links (summary only) */}
          {!selectedLinkId && stats.topLinks && stats.topLinks.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('analytics.topLinks')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {stats.topLinks.map((l) => (
                    <div
                      key={l.id}
                      className="flex items-center justify-between text-sm"
                    >
                      <button
                        type="button"
                        className="font-mono text-primary hover:underline text-left"
                        onClick={() => handleSelectLink(l.id, l.slug)}
                      >
                        {l.slug}
                      </button>
                      <span className="font-medium">
                        {l.clicks} {t('analytics.clicks')}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Timeline */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t('analytics.clicksOverTime')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={stats.timeline}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-border"
                  />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="clicks"
                    stroke="#6366f1"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Device + Country breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('analytics.devices')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={stats.devices}
                      dataKey="clicks"
                      nameKey="device_type"
                      cx="50%"
                      cy="50%"
                      outerRadius={70}
                      label={(props) => {
                        const device_type = props.name;
                        const percent = props.percent;
                        if (percent === undefined) return '';
                        return `${device_type} ${(percent * 100).toFixed(0)}%`;
                      }}
                    >
                      {stats.devices.map((device, i) => (
                        <Cell
                          key={device.device_type}
                          fill={COLORS[i % COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('analytics.topCountries')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {stats.countries.slice(0, 8).map((c) => (
                    <div
                      key={c.country}
                      className="flex items-center justify-between text-sm"
                    >
                      <span>{c.country}</span>
                      <span className="font-medium">{c.clicks}</span>
                    </div>
                  ))}
                  {stats.countries.length === 0 && (
                    <p className="text-muted-foreground text-sm">
                      {t('analytics.noData')}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Browsers + Referrers */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('analytics.browsers')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {stats.browsers.map((b) => (
                    <div
                      key={b.browser}
                      className="flex items-center justify-between text-sm"
                    >
                      <span>{b.browser}</span>
                      <span className="font-medium">{b.clicks}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('analytics.topReferrers')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {stats.referrers.slice(0, 8).map((r) => (
                    <div
                      key={r.referer}
                      className="flex items-center justify-between text-sm gap-2"
                    >
                      <span className="truncate text-muted-foreground">
                        {r.referer}
                      </span>
                      <span className="font-medium flex-shrink-0">
                        {r.clicks}
                      </span>
                    </div>
                  ))}
                  {stats.referrers.length === 0 && (
                    <p className="text-muted-foreground text-sm">
                      {t('analytics.noReferrer')}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {!stats && !isLoading && !error && (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
          <BarChart2 className="h-12 w-12 opacity-30" />
          <p>{t('analytics.selectLink')}</p>
        </div>
      )}
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className="text-2xl font-bold mt-1">{value}</p>
      </CardContent>
    </Card>
  );
}
