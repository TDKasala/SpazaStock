import React from 'react';
import { adminApi, adminErrorMessage } from '../api';
import { useAdminI18n } from '../i18n';
import { formatDateTime, formatNumber } from '../format';
import type { CronJobHealth, OperationsHealth } from '../types';
import { useAdminQuery } from '../useAdminQuery';
import { DataTable, type Column } from '../components/DataTable';
import { MetricCard } from '../components/MetricCard';
import { StatusBadge } from '../components/StatusBadge';
import { CountTable, PageHeader, QueryError, RefreshButton, Section } from '../components/PageParts';

type SyncRow = OperationsHealth['sync'][number];

export const OperationsPage: React.FC = () => {
  const { at, label, locale } = useAdminI18n();
  const health = useAdminQuery('operations', () => adminApi.operationsHealth());
  const n = (v: number | null | undefined) => formatNumber(v, locale);
  const dt = (v: string | null | undefined) => formatDateTime(v, locale);
  const data = health.data;

  const jobColumns: Column<CronJobHealth>[] = [
    {
      key: 'job',
      header: at('operations.job'),
      render: (j) => (
        <span>
          {label('jobs', j.job)}
          <code className="block text-[11px] text-zinc-500 font-normal">
            {j.job} · {j.schedule}
          </code>
        </span>
      ),
    },
    { key: 'active', header: at('common.status'), render: (j) => <StatusBadge value={j.active ? 'active' : 'inactive'} /> },
    {
      key: 'last',
      header: at('operations.lastRun'),
      render: (j) => (
        <span>
          {dt(j.last_run_at)} <StatusBadge value={j.last_status} />
          {j.last_duration_ms !== null && (
            <span className="block text-xs text-zinc-500">{at('operations.duration', { ms: n(j.last_duration_ms) })}</span>
          )}
        </span>
      ),
    },
    { key: 'success', header: at('operations.lastSuccess'), render: (j) => dt(j.last_success_at) },
    { key: 'runs', header: at('operations.runs24h'), align: 'right', render: (j) => n(j.runs_24h) },
    { key: 'failures', header: at('operations.failures24h'), align: 'right', render: (j) => n(j.failures_24h) },
    {
      key: 'failure',
      header: at('operations.lastFailure'),
      render: (j) =>
        j.last_failure_at ? (
          <span className="text-xs">
            {dt(j.last_failure_at)}
            <span className="block text-zinc-500 break-words max-w-xs">{j.last_failure_message}</span>
          </span>
        ) : (
          at('common.none')
        ),
    },
  ];

  const syncColumns: Column<SyncRow>[] = [
    { key: 'op', header: at('operations.opType'), render: (r) => label('opTypes', r.op_type) },
    { key: 'code', header: at('operations.errorCode'), render: (r) => <code className="text-xs">{r.error_code}</code> },
    { key: 'occurrences', header: at('operations.occurrences'), align: 'right', render: (r) => n(r.occurrences) },
    { key: 'shops', header: at('operations.shops'), align: 'right', render: (r) => n(r.shops) },
    { key: 'users', header: at('operations.users'), align: 'right', render: (r) => n(r.users) },
    { key: 'last', header: at('operations.lastSeen'), render: (r) => dt(r.last_seen) },
  ];

  return (
    <>
      <PageHeader
        title={at('operations.title')}
        description={at('operations.description')}
        actions={<RefreshButton onClick={health.reload} isLoading={health.isLoading} loadedAt={health.loadedAt} />}
      />
      {health.error && !data ? (
        <QueryError message={adminErrorMessage(health.error, at)} onRetry={health.reload} />
      ) : (
        data && (
          <>
            <Section title={at('operations.scheduler')}>
              {data.scheduler.available ? (
                <DataTable
                  caption={at('operations.scheduler')}
                  hideCaption
                  columns={jobColumns}
                  rows={data.scheduler.jobs}
                  rowKey={(j) => j.job}
                />
              ) : (
                <p className="text-sm text-zinc-400">{at('operations.schedulerUnavailable')}</p>
              )}
            </Section>

            <Section title={at('operations.push')}>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <MetricCard label={at('operations.dueNow')} value={n(data.push.due_now)} tone={data.push.due_now > 0 ? 'warning' : 'default'} />
                <MetricCard label={at('operations.oldestDue')} value={dt(data.push.oldest_due_at)} />
                <MetricCard label={at('operations.failed24h')} value={n(data.push.failed_24h)} tone={data.push.failed_24h > 0 ? 'danger' : 'default'} />
                <MetricCard label={at('operations.lastSent')} value={dt(data.push.last_sent_at)} />
              </div>
              <CountTable caption={at('operations.pushByStatus')} counts={data.push.by_status_7d} group="status" keyHeader={at('common.status')} />
            </Section>

            <Section title={at('operations.sync')} description={at('operations.syncNote')}>
              <DataTable
                caption={at('operations.sync')}
                hideCaption
                columns={syncColumns}
                rows={data.sync}
                rowKey={(r) => `${r.op_type}:${r.error_code}`}
                emptyMessage={at('operations.noSyncFailures')}
              />
            </Section>

            <Section title={at('operations.integrations')} description={at('operations.integrationsNote')}>
              <ul className="divide-y divide-zinc-800/80">
                {(Object.keys(data.integrations) as (keyof OperationsHealth['integrations'])[]).map((key) => (
                  <li key={key} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="text-zinc-200">{label('integrations', key)}</span>
                    <StatusBadge value={data.integrations[key] ? 'configured' : 'missing'} />
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )
      )}
    </>
  );
};
