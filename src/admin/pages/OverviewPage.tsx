import React, { useEffect, useState } from 'react';
import { adminApi, adminErrorMessage } from '../api';
import { useAdminIdentity } from '../AdminContext';
import { useAdminI18n } from '../i18n';
import { formatNumber } from '../format';
import { canOpenSection } from '../permissions';
import { defaultBucket, resolveRange, type DateRangeValue } from '../range';
import { adminHref } from '../router';
import type { GrowthMetric } from '../types';
import { useAdminQuery } from '../useAdminQuery';
import { DateRangeFilter, selectClass } from '../components/DateRangeFilter';
import { MetricCard } from '../components/MetricCard';
import { MiniChart } from '../components/MiniChart';
import { AdminLink } from '../components/AdminLink';
import { CountTable, PageHeader, QueryError, RefreshButton, Section } from '../components/PageParts';

const REFRESH_MS = 60_000;
const GROWTH_METRICS: readonly GrowthMetric[] = ['shops', 'users', 'active_shops', 'stock_movements', 'sales', 'expiry_alerts'];

export const OverviewPage: React.FC = () => {
  const { at, locale } = useAdminI18n();
  const identity = useAdminIdentity();
  const canSeeTenants = canOpenSection(identity.role, 'tenants');
  const [range, setRange] = useState<DateRangeValue>({ preset: '30d' });
  const [metric, setMetric] = useState<GrowthMetric>('shops');
  const rangeKey = JSON.stringify(range);

  const overview = useAdminQuery(rangeKey, () => {
    const span = resolveRange(range);
    if (!span) return Promise.reject(new Error('range'));
    return adminApi.overview(span.from, span.to);
  });
  const growth = useAdminQuery(`${rangeKey}:${metric}`, () => {
    const span = resolveRange(range);
    if (!span) return Promise.reject(new Error('range'));
    return adminApi.growthSeries(metric, span.from, span.to, defaultBucket(span.from, span.to));
  });

  const { reload: reloadOverview } = overview;
  const { reload: reloadGrowth } = growth;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        reloadOverview();
        reloadGrowth();
      }
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reloadOverview, reloadGrowth]);

  const data = overview.data;
  const n = (value: number | null | undefined) => formatNumber(value, locale);
  const tenantsLink = (params: Record<string, string>) => (canSeeTenants ? adminHref('tenants', { params }) : undefined);

  return (
    <>
      <PageHeader
        title={at('overview.title')}
        description={at('overview.description')}
        actions={
          <RefreshButton
            onClick={() => {
              reloadOverview();
              reloadGrowth();
            }}
            isLoading={overview.isLoading}
            loadedAt={overview.loadedAt}
          />
        }
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFilter value={range} onChange={setRange} />
        <p className="text-xs text-zinc-500">{at('overview.autoRefresh')} {at('common.timezoneNote')}</p>
      </div>

      {overview.error && !data ? (
        <QueryError message={adminErrorMessage(overview.error, at)} onRetry={reloadOverview} />
      ) : (
        <>
          <Section title={at('overview.shops')}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <MetricCard label={at('overview.shopsTotal')} value={n(data?.shops.total)} href={tenantsLink({})} />
              <MetricCard label={at('overview.shopsActive')} value={n(data?.shops.active)} href={tenantsLink({ status: 'active' })} />
              <MetricCard
                label={at('overview.shopsSuspended')}
                value={n(data?.shops.suspended)}
                href={tenantsLink({ status: 'suspended' })}
                tone={data && data.shops.suspended > 0 ? 'warning' : 'default'}
              />
              <MetricCard label={at('overview.shopsNew')} value={n(data?.shops.new)} />
            </div>
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title={at('overview.users')}>
              <div className="grid grid-cols-3 gap-3">
                <MetricCard label={at('overview.usersRegistered')} value={n(data?.users.registered)} />
                <MetricCard label={at('overview.usersConfirmed')} value={n(data?.users.confirmed)} />
                <MetricCard label={at('overview.usersNew')} value={n(data?.users.new)} />
              </div>
            </Section>
            <Section title={at('overview.revenue')}>
              <p className="text-sm text-zinc-400">{at('overview.revenueUnavailable')}</p>
            </Section>
          </div>

          <Section title={at('overview.subscriptions')}>
            <div className="grid grid-cols-3 gap-3">
              <MetricCard label={at('overview.subsActive')} value={n(data?.subscriptions.active)} />
              <MetricCard label={at('overview.trialsActive')} value={n(data?.subscriptions.trials_active)} />
              <MetricCard label={at('overview.cancellations')} value={n(data?.subscriptions.cancellations)} />
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <CountTable
                caption={at('overview.byPlan')}
                counts={data?.subscriptions.by_plan}
                group="plans"
                keyHeader={at('common.plan')}
                renderKey={(key, text) =>
                  canSeeTenants ? (
                    <AdminLink href={adminHref('tenants', { params: { plan: key } })} className="text-emerald-300 hover:underline">
                      {text}
                    </AdminLink>
                  ) : (
                    text
                  )
                }
              />
              <CountTable caption={at('overview.byStatus')} counts={data?.subscriptions.by_status} group="status" keyHeader={at('common.status')} />
            </div>
          </Section>

          <Section title={at('overview.activity')}>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <MetricCard label={at('overview.activeShops')} value={n(data?.stock.active_shops)} hint={at('overview.activeShopsHint')} />
              <MetricCard label={at('overview.movements')} value={n(data?.stock.movements)} />
              <MetricCard label={at('overview.unitsIn')} value={n(data?.stock.units_in)} />
              <MetricCard label={at('overview.unitsOut')} value={n(data?.stock.units_out)} />
              <MetricCard label={at('overview.sales')} value={n(data?.sales)} />
            </div>
            <CountTable caption={at('overview.byReason')} counts={data?.stock_by_reason} group="reasons" keyHeader={at('common.reason')} />
          </Section>

          <Section title={at('overview.expiry')}>
            <div className="grid grid-cols-3 gap-3">
              <MetricCard label={at('overview.expiryCreated')} value={n(data?.expiry.created)} />
              <MetricCard label={at('overview.expiryResolved')} value={n(data?.expiry.resolved)} />
              <MetricCard label={at('overview.expiryOpen')} value={n(data?.expiry.open)} hint={at('overview.expiryOpenHint')} />
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <CountTable caption={at('overview.byKind')} counts={data?.expiry.by_kind} group="kinds" keyHeader={at('common.kind')} />
              <CountTable caption={at('overview.byResolution')} counts={data?.expiry.by_resolution} group="resolutions" keyHeader={at('common.resolution')} />
            </div>
          </Section>

          <Section title={at('overview.errors')}>
            <div className="grid grid-cols-3 gap-3">
              <MetricCard
                label={at('overview.pushFailed')}
                value={n(data?.errors.push_failed)}
                tone={data && data.errors.push_failed > 0 ? 'danger' : 'default'}
                href={canOpenSection(identity.role, 'operations') ? adminHref('operations') : undefined}
              />
              <MetricCard
                label={at('overview.syncFailures')}
                value={n(data?.errors.sync_failures)}
                tone={data && data.errors.sync_failures > 0 ? 'warning' : 'default'}
                href={canOpenSection(identity.role, 'operations') ? adminHref('operations') : undefined}
              />
              <MetricCard
                label={at('overview.cronFailures')}
                value={data && data.errors.cron_failures === null ? at('common.unavailable') : n(data?.errors.cron_failures)}
                tone={data && (data.errors.cron_failures ?? 0) > 0 ? 'danger' : 'default'}
              />
            </div>
          </Section>
        </>
      )}

      <Section
        title={at('overview.growth')}
        actions={
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            {at('overview.metric')}
            <select className={selectClass} value={metric} onChange={(e) => setMetric(e.target.value as GrowthMetric)}>
              {GROWTH_METRICS.map((m) => (
                <option key={m} value={m}>
                  {at(`metrics.${m}`)}
                </option>
              ))}
            </select>
          </label>
        }
      >
        {growth.error && !growth.data ? (
          <QueryError message={adminErrorMessage(growth.error, at)} onRetry={reloadGrowth} />
        ) : growth.data ? (
          <MiniChart
            title={`${at(`metrics.${growth.data.metric}`)} (${at(`buckets.${growth.data.bucket}`)})`}
            series={growth.data.series}
            type={growth.data.metric === 'active_shops' ? 'line' : 'bar'}
          />
        ) : null}
      </Section>
    </>
  );
};
