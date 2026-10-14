import React, { useState } from 'react';
import { adminApi, adminErrorMessage } from '../api';
import { useAdminI18n } from '../i18n';
import { formatNumber, formatPercent } from '../format';
import { defaultBucket, resolveRange, type DateRangeValue } from '../range';
import { useAdminQuery } from '../useAdminQuery';
import { DateRangeFilter } from '../components/DateRangeFilter';
import { MetricCard } from '../components/MetricCard';
import { MiniChart } from '../components/MiniChart';
import { CountTable, PageHeader, QueryError, RefreshButton, Section } from '../components/PageParts';

const DEFINITIONS = [
  'activeShop',
  'activeUser',
  'retention',
  'conversion',
  'effectivePlan',
  'adoption',
  'units',
  'timezone',
  'revenue',
] as const;

export const AnalyticsPage: React.FC = () => {
  const { at, label, locale } = useAdminI18n();
  const [range, setRange] = useState<DateRangeValue>({ preset: '90d' });
  const rangeKey = JSON.stringify(range);

  const report = useAdminQuery(rangeKey, () => {
    const span = resolveRange(range);
    if (!span) return Promise.reject(new Error('range'));
    return adminApi.analytics(span.from, span.to);
  });
  const activeSeries = useAdminQuery(rangeKey, () => {
    const span = resolveRange(range);
    if (!span) return Promise.reject(new Error('range'));
    return adminApi.growthSeries('active_shops', span.from, span.to, defaultBucket(span.from, span.to));
  });

  const n = (v: number | null | undefined) => formatNumber(v, locale);
  const data = report.data;
  const longest = Math.max(0, ...(data?.retention ?? []).map((r) => r.active.length));

  return (
    <>
      <PageHeader
        title={at('analytics.title')}
        description={at('analytics.description')}
        actions={<RefreshButton onClick={report.reload} isLoading={report.isLoading} loadedAt={report.loadedAt} />}
      />
      <DateRangeFilter value={range} onChange={setRange} />

      {report.error && !data ? (
        <QueryError message={adminErrorMessage(report.error, at)} onRetry={report.reload} />
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Section title={at('analytics.tenants')}>
              <div className="grid grid-cols-3 gap-3">
                <MetricCard label={at('analytics.atStart')} value={n(data?.tenants.at_start)} />
                <MetricCard label={at('analytics.atEnd')} value={n(data?.tenants.at_end)} />
                <MetricCard label={at('analytics.new')} value={n(data?.tenants.new)} />
              </div>
            </Section>
            <Section title={at('analytics.usage')}>
              <div className="grid grid-cols-2 gap-3">
                <MetricCard label={at('analytics.activeShops')} value={n(data?.usage.active_shops)} />
                <MetricCard label={at('analytics.activeUsers')} value={n(data?.usage.active_users)} />
              </div>
            </Section>
          </div>

          <Section title={at('analytics.activeTrend')}>
            {activeSeries.data ? (
              <MiniChart
                title={`${at('metrics.active_shops')} (${at(`buckets.${activeSeries.data.bucket}`)})`}
                series={activeSeries.data.series}
                type="line"
              />
            ) : activeSeries.error ? (
              <QueryError message={adminErrorMessage(activeSeries.error, at)} onRetry={activeSeries.reload} />
            ) : null}
          </Section>

          <Section title={at('analytics.retention')} description={at('analytics.retentionDescription')}>
            <div className="overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full text-sm">
                <caption className="sr-only">{at('analytics.retention')}</caption>
                <thead className="bg-zinc-900/80 text-xs text-zinc-400">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">{at('analytics.cohort')}</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">{at('analytics.cohortSize')}</th>
                    {Array.from({ length: longest }, (_, i) => (
                      <th key={i} scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                        {at('analytics.month', { n: i })}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/80">
                  {(data?.retention ?? []).map((row) => (
                    <tr key={row.cohort}>
                      <th scope="row" className="px-3 py-2 text-left font-medium text-zinc-200">{row.cohort}</th>
                      <td className="px-3 py-2 text-right tabular-nums">{n(row.size)}</td>
                      {Array.from({ length: longest }, (_, i) => (
                        <td key={i} className="px-3 py-2 text-right tabular-nums text-zinc-300">
                          {i < row.active.length ? (
                            <>
                              {n(row.active[i])}
                              <span className="block text-[11px] text-zinc-500">{formatPercent(row.active[i], row.size, locale)}</span>
                            </>
                          ) : (
                            ''
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title={at('analytics.conversion')}>
              <div className="grid grid-cols-2 gap-3">
                <MetricCard label={at('analytics.trialsStarted')} value={n(data?.conversion.trials_started)} />
                <MetricCard label={at('analytics.trialsConverted')} value={n(data?.conversion.trials_converted)} />
                <MetricCard label={at('analytics.trialsLapsed')} value={n(data?.conversion.trials_lapsed)} />
                <MetricCard
                  label={at('analytics.conversionRate')}
                  value={
                    data
                      ? formatPercent(
                          data.conversion.trials_converted,
                          data.conversion.trials_converted + data.conversion.trials_lapsed,
                          locale
                        )
                      : '—'
                  }
                  hint={at('analytics.conversionRateHint')}
                />
              </div>
            </Section>
            <Section title={at('analytics.planDistribution')}>
              <div className="grid gap-6 sm:grid-cols-2">
                <CountTable caption={at('analytics.subscribed')} counts={data?.plan_distribution.subscribed} group="plans" keyHeader={at('common.plan')} />
                <CountTable caption={at('analytics.effective')} counts={data?.plan_distribution.effective} group="plans" keyHeader={at('common.plan')} />
              </div>
            </Section>
          </div>

          <Section title={at('analytics.adoption')}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(['push_enabled', 'teams', 'expiry_tracking'] as const).map((key) => (
                <MetricCard
                  key={key}
                  label={at(`analytics.adoptionKeys.${key}`)}
                  value={data ? formatPercent(data.feature_adoption[key], data.feature_adoption.shops, locale) : '—'}
                  hint={
                    data
                      ? at('analytics.ofShops', { count: n(data.feature_adoption[key]), total: n(data.feature_adoption.shops) })
                      : undefined
                  }
                />
              ))}
            </div>
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title={at('analytics.stockVolumes')}>
              <table className="w-full text-sm">
                <caption className="sr-only">{at('analytics.stockVolumes')}</caption>
                <thead className="text-xs text-zinc-400">
                  <tr>
                    <th scope="col" className="py-1.5 text-left font-medium">{at('common.reason')}</th>
                    <th scope="col" className="py-1.5 text-right font-medium">{at('analytics.movements')}</th>
                    <th scope="col" className="py-1.5 text-right font-medium">{at('analytics.units')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/80">
                  {Object.entries(data?.stock_volumes ?? {}).length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-2 text-zinc-500">{at('common.none')}</td>
                    </tr>
                  ) : (
                    Object.entries(data?.stock_volumes ?? {})
                      .sort((a, b) => b[1].movements - a[1].movements)
                      .map(([reason, v]) => (
                        <tr key={reason}>
                          <th scope="row" className="py-1.5 text-left font-normal text-zinc-300">{label('reasons', reason)}</th>
                          <td className="py-1.5 text-right tabular-nums">{n(v.movements)}</td>
                          <td className="py-1.5 text-right tabular-nums">{n(v.units)}</td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </Section>
            <Section title={at('analytics.expiry')}>
              <div className="grid gap-6 sm:grid-cols-2">
                <CountTable caption={at('analytics.createdByKind')} counts={data?.expiry.created_by_kind} group="kinds" keyHeader={at('common.kind')} />
                <CountTable
                  caption={at('analytics.resolvedBy')}
                  counts={data?.expiry.resolved_by_resolution}
                  group="resolutions"
                  keyHeader={at('common.resolution')}
                />
              </div>
              <p className="text-sm text-zinc-400">{at('analytics.openAlerts', { count: n(data?.expiry.open) })}</p>
            </Section>
          </div>
        </>
      )}

      <Section title={at('analytics.definitionsTitle')}>
        <dl className="space-y-3 text-sm">
          {DEFINITIONS.map((key) => (
            <div key={key}>
              <dt className="font-medium text-zinc-200">{at(`analytics.definitions.${key}.term`)}</dt>
              <dd className="text-zinc-400">{at(`analytics.definitions.${key}.text`)}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
};
