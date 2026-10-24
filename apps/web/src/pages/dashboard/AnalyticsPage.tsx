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
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
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
    <div className="space-y-6 p-6 animate-enter">
      <div className="space-y-1">
        <h1 className="text-h1 font-bold tracking-tight">
          {t('analytics.title')}
        </h1>
        <p className="text-body text-muted-foreground">
          {t('analytics.titleDesc')}
        </p>
      </div>

      {/* Link selector + day picker */}
      <div className="flex gap-3 items-end flex-wrap">
        <div className="flex-1 min-w-48 relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
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
              className="absolute right-2 top-3 text-muted-foreground transition-colors duration-(--duration-fast) ease-(--ease-out) hover:text-foreground"
              onClick={handleClearLink}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {showDropdown && (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border bg-popover shadow-md animate-dropdown-in">
              {searchResults?.links.map((link) => (
                <button
                  type="button"
                  key={link.id}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-body transition-colors duration-(--duration-fast) ease-(--ease-out) hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
                  onClick={() => handleSelectLink(link.id, link.slug)}
                >
                  <span className="font-mono text-primary">{link.slug}</span>
                  <span className="truncate text-caption text-muted-foreground">
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
        <p className="text-body text-muted-foreground">
          {t('analytics.allLinksStats')}
        </p>
      )}
      {selectedLinkId && selectedLinkData?.link && (
        <div className="text-body text-muted-foreground">
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
        <div className="py-16 text-center text-body text-muted-foreground">
          {t('common.loading')}
        </div>
      )}
      {error && (
        <p className="text-body text-destructive" role="alert">
          {t('analytics.failedToLoad')}
        </p>
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
                <CardTitle>{t('analytics.topLinks')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {stats.topLinks.map((l) => (
                    <div
                      key={l.id}
                      className="flex items-center justify-between text-body"
                    >
                      <button
                        type="button"
                        className="font-mono text-primary hover:underline text-left"
                        onClick={() => handleSelectLink(l.id, l.slug)}
                      >
                        {l.slug}
                      </button>
                      <span className="font-mono font-semibold tabular-nums">
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
              <CardTitle>{t('analytics.clicksOverTime')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer
                width="100%"
                height={200}
                // 可达性：recharts 容器默认无语义，补图形角色与名称
                role="img"
                aria-label={t('analytics.clicksOverTimeAria')}
              >
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
                    stroke="hsl(var(--chart-1))"
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
                <CardTitle>{t('analytics.devices')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer
                  width="100%"
                  height={180}
                  role="img"
                  aria-label={t('analytics.devicesAria')}
                >
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
                <CardTitle>{t('analytics.topCountries')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {stats.countries.slice(0, 8).map((c) => (
                    <div
                      key={c.country}
                      className="flex items-center justify-between text-body"
                    >
                      <span>{c.country}</span>
                      <span className="font-mono font-semibold tabular-nums">
                        {c.clicks}
                      </span>
                    </div>
                  ))}
                  {stats.countries.length === 0 && (
                    <p className="text-body text-muted-foreground">
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
                <CardTitle>{t('analytics.browsers')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {stats.browsers.map((b) => (
                    <div
                      key={b.browser}
                      className="flex items-center justify-between text-body"
                    >
                      <span>{b.browser}</span>
                      <span className="font-mono font-semibold tabular-nums">
                        {b.clicks}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('analytics.topReferrers')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {stats.referrers.slice(0, 8).map((r) => (
                    <div
                      key={r.referer}
                      className="flex items-center justify-between gap-2 text-body"
                    >
                      <span className="truncate text-muted-foreground">
                        {r.referer}
                      </span>
                      <span className="flex-shrink-0 font-mono font-semibold tabular-nums">
                        {r.clicks}
                      </span>
                    </div>
                  ))}
                  {stats.referrers.length === 0 && (
                    <p className="text-body text-muted-foreground">
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
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
          <BarChart2 className="h-12 w-12 opacity-30" />
          <p className="text-body">{t('analytics.selectLink')}</p>
        </div>
      )}
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-caption font-medium tracking-caps text-muted-foreground uppercase">
          {title}
        </p>
        <p className="mt-1 font-mono text-h1 font-semibold leading-none tabular-nums">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
