import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useAdminI18n } from '../i18n';
import { formatDateTime, formatNumber } from '../format';
import type { CountMap } from '../types';

export const PageHeader: React.FC<{ title: string; description?: string; actions?: React.ReactNode }> = ({
  title,
  description,
  actions,
}) => (
  <div className="flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0">
      <h1 className="text-xl font-semibold text-zinc-100">{title}</h1>
      {description && <p className="mt-1 text-sm text-zinc-400 max-w-3xl">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

export const Section: React.FC<{ title: string; description?: string; children: React.ReactNode; actions?: React.ReactNode }> = ({
  title,
  description,
  children,
  actions,
}) => (
  <section className="bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-4 sm:p-5 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {description && <p className="mt-1 text-xs text-zinc-400 max-w-3xl">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
    {children}
  </section>
);

export const RefreshButton: React.FC<{ onClick: () => void; isLoading: boolean; loadedAt: Date | null }> = ({
  onClick,
  isLoading,
  loadedAt,
}) => {
  const { at, locale } = useAdminI18n();
  return (
    <div className="flex items-center gap-2">
      {loadedAt && (
        <span className="text-xs text-zinc-500" aria-live="polite">
          {at('common.updatedAt', { time: formatDateTime(loadedAt.toISOString(), locale) })}
        </span>
      )}
      <Button variant="outline" size="sm" onClick={onClick} isLoading={isLoading} leftIcon={<RefreshCw className="w-4 h-4" />}>
        {at('common.refresh')}
      </Button>
    </div>
  );
};

/** Label/value pairs for a record's details. */
export const DetailList: React.FC<{ items: [string, React.ReactNode][] }> = ({ items }) => (
  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
    {items.map(([label, value]) => (
      <div key={label} className="min-w-0">
        <dt className="text-xs text-zinc-500">{label}</dt>
        <dd className="mt-0.5 text-zinc-200 break-words">{value}</dd>
      </div>
    ))}
  </dl>
);

/** A small table of counts keyed by a database value (status, reason, kind...). */
export const CountTable: React.FC<{
  caption: string;
  counts: CountMap | null | undefined;
  group: string;
  keyHeader: string;
  valueHeader?: string;
  renderKey?: (key: string, text: string) => React.ReactNode;
}> = ({ caption, counts, group, keyHeader, valueHeader, renderKey }) => {
  const { at, label, locale } = useAdminI18n();
  const entries = Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <table className="w-full text-sm">
      <caption className="text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 pb-2">{caption}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">{keyHeader}</th>
          <th scope="col">{valueHeader ?? at('common.count')}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-800/80">
        {entries.length === 0 ? (
          <tr>
            <td colSpan={2} className="py-2 text-zinc-500">
              {at('common.none')}
            </td>
          </tr>
        ) : (
          entries.map(([key, value]) => (
            <tr key={key}>
              <th scope="row" className="py-1.5 text-left font-normal text-zinc-300">
                {renderKey ? renderKey(key, label(group, key)) : label(group, key)}
              </th>
              <td className="py-1.5 text-right tabular-nums text-zinc-100">{formatNumber(value, locale)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
};

export const QueryError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => {
  const { at } = useAdminI18n();
  return (
    <div role="alert" className="p-4 rounded-xl border border-rose-800/60 bg-rose-950/40 text-rose-200 text-sm flex flex-wrap items-center justify-between gap-3">
      <span>{message}</span>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {at('common.retry')}
      </Button>
    </div>
  );
};

export const fieldClass =
  'w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none rounded-xl px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500';

export const Field: React.FC<{ id: string; label: string; hint?: string; children: React.ReactNode }> = ({
  id,
  label,
  hint,
  children,
}) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={id} className="text-xs font-medium text-zinc-300">
      {label}
    </label>
    {children}
    {hint && <span className="text-xs text-zinc-500">{hint}</span>}
  </div>
);
