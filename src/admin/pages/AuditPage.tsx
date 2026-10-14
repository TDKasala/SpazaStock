import React, { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { adminApi, adminErrorMessage } from '../api';
import { useAdminIdentity } from '../AdminContext';
import { useAdminI18n } from '../i18n';
import { formatDateTime, platformDayStart } from '../format';
import { canOpenSection } from '../permissions';
import { adminHref, navigateAdmin, useAdminRoute } from '../router';
import type { AuditEntry, AuditFilters } from '../types';
import { useAdminQuery } from '../useAdminQuery';
import { DataTable, type Column } from '../components/DataTable';
import { Pagination } from '../components/Pagination';
import { StatusBadge } from '../components/StatusBadge';
import { AdminLink } from '../components/AdminLink';
import { selectClass } from '../components/DateRangeFilter';
import { PageHeader } from '../components/PageParts';

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_PREFIXES = ['tenant', 'admin', 'billing', 'plan', 'feature', 'overview', 'analytics', 'operations', 'audit'];

interface AuditQuery {
  action: string;
  actor: string;
  shop: string;
  outcome: '' | 'success' | 'denied';
  fromDay: string;
  toDay: string;
  offset: number;
}

function queryFrom(params: URLSearchParams): AuditQuery {
  const outcome = params.get('outcome');
  return {
    action: params.get('action') ?? '',
    actor: params.get('actor') ?? '',
    shop: params.get('shop') ?? '',
    outcome: outcome === 'success' || outcome === 'denied' ? outcome : '',
    fromDay: params.get('from') ?? '',
    toDay: params.get('to') ?? '',
    offset: Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0),
  };
}

function hrefFor(q: AuditQuery) {
  return adminHref('audit', {
    params: {
      action: q.action,
      actor: q.actor,
      shop: q.shop,
      outcome: q.outcome,
      from: q.fromDay,
      to: q.toDay,
      offset: q.offset ? String(q.offset) : null,
    },
  });
}

function filtersFor(q: AuditQuery): AuditFilters {
  return {
    action: q.action,
    actorEmail: q.actor,
    shopId: UUID.test(q.shop) ? q.shop : '',
    outcome: q.outcome,
    from: q.fromDay ? platformDayStart(q.fromDay).toISOString() : null,
    to: q.toDay ? new Date(platformDayStart(q.toDay).getTime() + DAY_MS).toISOString() : null,
  };
}

export const AuditPage: React.FC = () => {
  const { at, label, locale } = useAdminI18n();
  const identity = useAdminIdentity();
  const canSeeTenants = canOpenSection(identity.role, 'tenants');
  const route = useAdminRoute();
  const query = queryFrom(route.params);
  const [draft, setDraft] = useState(query);
  const shopInvalid = draft.shop.trim() !== '' && !UUID.test(draft.shop.trim());
  const rangeInvalid = Boolean(draft.fromDay && draft.toDay && draft.fromDay > draft.toDay);

  const audit = useAdminQuery(hrefFor(query), () => adminApi.listAudit(filtersFor(query), PAGE_SIZE, query.offset));

  const apply = (next: AuditQuery) => {
    setDraft(next);
    navigateAdmin(hrefFor(next), { replace: true });
  };

  const columns: Column<AuditEntry>[] = [
    { key: 'when', header: at('audit.when'), render: (e) => <span className="whitespace-nowrap font-normal">{formatDateTime(e.occurred_at, locale)}</span> },
    {
      key: 'actor',
      header: at('audit.actor'),
      render: (e) => (
        <span className="text-xs">
          {e.actor_email ?? at('common.none')}
          {e.actor_role && <span className="block text-zinc-500">{label('roles', e.actor_role)}</span>}
        </span>
      ),
    },
    {
      key: 'action',
      header: at('audit.action'),
      render: (e) => (
        <span>
          {label('actions', e.action)}
          <code className="block text-[11px] text-zinc-500">{e.action}</code>
        </span>
      ),
    },
    {
      key: 'target',
      header: at('audit.target'),
      render: (e) =>
        e.shop_id && canSeeTenants ? (
          <AdminLink href={adminHref('tenants', { tenantId: e.shop_id })} className="text-emerald-300 hover:underline text-xs">
            {label('targets', e.target_type)} · {e.shop_id.slice(0, 8)}
          </AdminLink>
        ) : (
          <span className="text-xs">
            {label('targets', e.target_type)}
            {e.target_id && <span className="block text-zinc-500 break-all">{e.target_id}</span>}
          </span>
        ),
    },
    { key: 'outcome', header: at('audit.outcome'), render: (e) => <StatusBadge value={e.outcome} /> },
    {
      key: 'reason',
      header: at('audit.reason'),
      render: (e) => (
        <span className="text-xs">
          <span className="block max-w-xs break-words">{e.reason ?? at('common.none')}</span>
          {e.details && Object.keys(e.details).length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">{at('audit.details')}</summary>
              <pre className="mt-1 max-w-sm overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-zinc-400 bg-zinc-950 rounded p-2">
                {JSON.stringify(e.details, null, 2)}
              </pre>
            </details>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={at('audit.title')} description={at('audit.description')} />

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (shopInvalid || rangeInvalid) return;
          apply({ ...draft, actor: draft.actor.trim().toLowerCase(), shop: draft.shop.trim().toLowerCase(), offset: 0 });
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {at('audit.action')}
          <select className={selectClass} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
            <option value="">{at('audit.allActions')}</option>
            {ACTION_PREFIXES.map((p) => (
              <option key={p} value={`${p}.`}>
                {label('actionGroups', p)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {at('audit.actorEmail')}
          <input
            type="email"
            className={selectClass}
            value={draft.actor}
            maxLength={320}
            onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {at('audit.shopId')}
          <input
            className={selectClass}
            value={draft.shop}
            maxLength={36}
            aria-invalid={shopInvalid}
            onChange={(e) => setDraft({ ...draft, shop: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {at('audit.outcome')}
          <select
            className={selectClass}
            value={draft.outcome}
            onChange={(e) => setDraft({ ...draft, outcome: e.target.value as AuditQuery['outcome'] })}
          >
            <option value="">{at('audit.allOutcomes')}</option>
            <option value="success">{label('status', 'success')}</option>
            <option value="denied">{label('status', 'denied')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {at('common.from')}
          <input type="date" className={selectClass} value={draft.fromDay} onChange={(e) => setDraft({ ...draft, fromDay: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {at('common.to')}
          <input type="date" className={selectClass} value={draft.toDay} onChange={(e) => setDraft({ ...draft, toDay: e.target.value })} />
        </label>
        <Button type="submit" size="sm" variant="secondary" disabled={shopInvalid || rangeInvalid}>
          {at('common.apply')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => apply({ action: '', actor: '', shop: '', outcome: '', fromDay: '', toDay: '', offset: 0 })}
        >
          {at('common.clear')}
        </Button>
        {shopInvalid && <p className="w-full text-xs text-rose-400">{at('audit.shopIdInvalid')}</p>}
        {rangeInvalid && <p className="w-full text-xs text-rose-400">{at('range.invalid')}</p>}
      </form>

      <DataTable
        caption={at('audit.title')}
        hideCaption
        columns={columns}
        rows={audit.data?.rows ?? null}
        rowKey={(e) => String(e.id)}
        isLoading={audit.isLoading}
        error={audit.error ? adminErrorMessage(audit.error, at) : null}
        onRetry={audit.reload}
        emptyMessage={at('audit.empty')}
      />
      {audit.data && (
        <Pagination
          total={audit.data.total}
          limit={audit.data.limit}
          offset={audit.data.offset}
          disabled={audit.isLoading}
          onChange={(offset) => apply({ ...query, offset })}
        />
      )}
    </>
  );
};
