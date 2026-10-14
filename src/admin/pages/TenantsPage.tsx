import React, { useEffect, useState } from 'react';
import { Download, Plus, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/ErrorMessage';
import { adminApi, adminErrorMessage } from '../api';
import { useAdminIdentity } from '../AdminContext';
import { useAdminI18n } from '../i18n';
import { formatDate, formatDateTime, formatNumber } from '../format';
import { canAdmin } from '../permissions';
import { adminHref, navigateAdmin, useAdminRoute } from '../router';
import type { TenantFilters, TenantRow, TenantSort } from '../types';
import { useAdminQuery } from '../useAdminQuery';
import { downloadCsv, toCsv } from '../csv';
import { DataTable, type Column, type SortState } from '../components/DataTable';
import { Pagination } from '../components/Pagination';
import { StatusBadge } from '../components/StatusBadge';
import { AdminLink } from '../components/AdminLink';
import { selectClass } from '../components/DateRangeFilter';
import { ReasonConfirmDialog } from '../components/ReasonConfirmDialog';
import { Field, fieldClass, PageHeader } from '../components/PageParts';
import {
  MAX_ADDRESS_LENGTH,
  MAX_CITY_LENGTH,
  MAX_SHOP_NAME_LENGTH,
  PROVINCES,
  normalizePhone,
  type ProvinceCode,
} from '../../lib/shopDetails';

const PAGE_SIZE = 25;
const SORTS: readonly TenantSort[] = ['created_desc', 'created_asc', 'name_asc', 'activity_desc'];

function filtersFrom(params: URLSearchParams): TenantFilters & { offset: number } {
  const status = params.get('status');
  const sort = params.get('sort') as TenantSort | null;
  return {
    search: params.get('q') ?? '',
    status: status === 'active' || status === 'suspended' ? status : '',
    plan: params.get('plan') ?? '',
    sort: sort && SORTS.includes(sort) ? sort : 'created_desc',
    offset: Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0),
  };
}

function hrefFor(filters: TenantFilters & { offset: number }) {
  return adminHref('tenants', {
    params: {
      q: filters.search,
      status: filters.status,
      plan: filters.plan,
      sort: filters.sort === 'created_desc' ? null : filters.sort,
      offset: filters.offset ? String(filters.offset) : null,
    },
  });
}

/** Column sorting maps onto the orders the server supports. */
function nextSort(column: string, current: TenantSort): TenantSort | null {
  if (column === 'name') return 'name_asc';
  if (column === 'created') return current === 'created_desc' ? 'created_asc' : 'created_desc';
  if (column === 'activity') return 'activity_desc';
  return null;
}

function sortState(sort: TenantSort): SortState {
  switch (sort) {
    case 'name_asc':
      return { key: 'name', direction: 'ascending' };
    case 'created_asc':
      return { key: 'created', direction: 'ascending' };
    case 'activity_desc':
      return { key: 'activity', direction: 'descending' };
    default:
      return { key: 'created', direction: 'descending' };
  }
}

export const TenantsPage: React.FC = () => {
  const { at, label, locale } = useAdminI18n();
  const identity = useAdminIdentity();
  const route = useAdminRoute();
  const filters = filtersFrom(route.params);
  const [searchDraft, setSearchDraft] = useState(filters.search ?? '');
  const [exportOpen, setExportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canExport = canAdmin(identity.role, 'tenants.export');
  const canCreate = canAdmin(identity.role, 'tenants.manage');
  const canListPlans = canAdmin(identity.role, 'billing.view') || canAdmin(identity.role, 'plans.manage');

  useEffect(() => setSearchDraft(filters.search ?? ''), [filters.search]);

  const tenants = useAdminQuery(hrefFor(filters), () => adminApi.listTenants(filters, PAGE_SIZE, filters.offset));
  const plans = useAdminQuery(`plans:${canListPlans}`, () =>
    canListPlans ? adminApi.listPlans().then((r) => r.plans) : Promise.resolve([])
  );

  const update = (patch: Partial<TenantFilters & { offset: number }>) =>
    navigateAdmin(hrefFor({ ...filters, offset: 0, ...patch }), { replace: true });

  const columns: Column<TenantRow>[] = [
    {
      key: 'name',
      header: at('tenants.name'),
      sortable: true,
      render: (row) => (
        <AdminLink href={adminHref('tenants', { tenantId: row.id })} className="text-emerald-300 hover:underline">
          {row.name}
        </AdminLink>
      ),
    },
    {
      key: 'owner',
      header: at('tenants.owner'),
      render: (row) => (
        <span className="block max-w-[16rem] truncate" title={row.owner_email ?? undefined}>
          {row.owner_email ?? at('common.none')}
        </span>
      ),
    },
    { key: 'status', header: at('common.status'), render: (row) => <StatusBadge value={row.status} /> },
    {
      key: 'plan',
      header: at('common.plan'),
      render: (row) => (
        <span className="whitespace-nowrap">
          {label('plans', row.plan)} · <StatusBadge value={row.subscription_status} />
        </span>
      ),
    },
    { key: 'members', header: at('tenants.members'), align: 'right', render: (row) => formatNumber(row.member_count, locale) },
    { key: 'products', header: at('tenants.products'), align: 'right', render: (row) => formatNumber(row.product_count, locale) },
    {
      key: 'activity',
      header: at('tenants.lastActivity'),
      sortable: true,
      render: (row) => (row.last_activity_at ? formatDateTime(row.last_activity_at, locale) : at('tenants.never')),
    },
    { key: 'created', header: at('tenants.created'), sortable: true, render: (row) => formatDate(row.created_at, locale) },
  ];

  const exportCsv = async (reason: string) => {
    const result = await adminApi.exportTenants(filters, reason);
    const headers = [
      'shop_id', 'shop_name', 'status', 'created_at', 'owner_email', 'owner_name', 'plan',
      'subscription_status', 'members', 'active_products', 'last_activity_at',
    ];
    const rows = result.rows.map((r) => [
      r.id, r.name, r.status, r.created_at, r.owner_email, r.owner_name, r.plan,
      r.subscription_status, r.member_count, r.product_count, r.last_activity_at,
    ]);
    downloadCsv(`spazastock-tenants-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(headers, rows));
    setExportOpen(false);
    setNotice(
      result.truncated
        ? at('tenants.exportTruncated', { total: formatNumber(result.total, locale) })
        : at('tenants.exportDone', { count: formatNumber(result.rows.length, locale) })
    );
  };

  return (
    <>
      <PageHeader
        title={at('tenants.title')}
        description={at('tenants.description')}
        actions={
          <>
            {canExport && (
              <Button variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />} onClick={() => setExportOpen(true)}>
                {at('tenants.export')}
              </Button>
            )}
            {canCreate && (
              <Button size="sm" leftIcon={<Plus className="w-4 h-4" />} onClick={() => setCreateOpen(true)}>
                {at('tenants.create')}
              </Button>
            )}
          </>
        }
      />

      {notice && <ErrorMessage variant="success" message={notice} onDismiss={() => setNotice(null)} />}

      <div className="flex flex-wrap items-end gap-3">
        <form
          role="search"
          className="flex items-end gap-2 flex-1 min-w-[16rem]"
          onSubmit={(e) => {
            e.preventDefault();
            update({ search: searchDraft.trim() });
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-zinc-400 flex-1">
            {at('search.label')}
            <input
              type="search"
              value={searchDraft}
              maxLength={100}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder={at('search.placeholder')}
              className={selectClass}
            />
          </label>
          <Button type="submit" size="sm" variant="secondary">
            {at('search.submit')}
          </Button>
        </form>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {at('common.status')}
          <select
            className={selectClass}
            value={filters.status}
            onChange={(e) => update({ status: e.target.value as TenantFilters['status'] })}
          >
            <option value="">{at('common.allStatuses')}</option>
            <option value="active">{label('status', 'active')}</option>
            <option value="suspended">{label('status', 'suspended')}</option>
          </select>
        </label>
        {plans.data && plans.data.length > 0 ? (
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {at('common.plan')}
            <select className={selectClass} value={filters.plan} onChange={(e) => update({ plan: e.target.value })}>
              <option value="">{at('common.allPlans')}</option>
              {plans.data.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          filters.plan && (
            <button
              type="button"
              onClick={() => update({ plan: '' })}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              {at('common.plan')}: {label('plans', filters.plan)}
              <X className="w-3 h-3" aria-label={at('common.clear')} />
            </button>
          )
        )}
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {at('tenants.sort')}
          <select className={selectClass} value={filters.sort} onChange={(e) => update({ sort: e.target.value as TenantSort })}>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {at(`tenants.sorts.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <DataTable
        caption={at('tenants.caption')}
        hideCaption
        columns={columns}
        rows={tenants.data?.rows ?? null}
        rowKey={(row) => row.id}
        isLoading={tenants.isLoading}
        error={tenants.error ? adminErrorMessage(tenants.error, at) : null}
        onRetry={tenants.reload}
        emptyMessage={at('tenants.empty')}
        sort={sortState(filters.sort ?? 'created_desc')}
        onSort={(column) => {
          const sort = nextSort(column, filters.sort ?? 'created_desc');
          if (sort) update({ sort });
        }}
      />
      {tenants.data && (
        <Pagination
          total={tenants.data.total}
          limit={tenants.data.limit}
          offset={tenants.data.offset}
          disabled={tenants.isLoading}
          onChange={(offset) => update({ offset })}
        />
      )}

      <ReasonConfirmDialog
        isOpen={exportOpen}
        title={at('tenants.exportTitle')}
        description={at('tenants.exportDescription')}
        confirmLabel={at('tenants.export')}
        onConfirm={exportCsv}
        onClose={() => setExportOpen(false)}
      />
      <CreateShopDialog isOpen={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CreateShopDialog: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { at } = useAdminI18n();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [province, setProvince] = useState<ProvinceCode | ''>('');

  useEffect(() => {
    if (!isOpen) return;
    setEmail('');
    setName('');
    setPhone('');
    setAddress('');
    setCity('');
    setProvince('');
  }, [isOpen]);

  const normalizedPhone = normalizePhone(phone);

  return (
    <ReasonConfirmDialog
      isOpen={isOpen}
      title={at('tenants.createTitle')}
      description={at('tenants.createDescription')}
      confirmLabel={at('tenants.create')}
      canSubmit={EMAIL.test(email.trim()) && name.trim().length > 0 && normalizedPhone !== 'invalid'}
      onConfirm={async (reason) => {
        const shop = {
          name: name.trim(),
          phone: normalizedPhone === 'invalid' ? null : normalizedPhone,
          address: address.replace(/\s+/g, ' ').trim() || null,
          city: city.replace(/\s+/g, ' ').trim() || null,
          province: province || null,
        };
        const result = await adminApi.createShop(email.trim(), shop, reason);
        onClose();
        navigateAdmin(adminHref('tenants', { tenantId: result.shop_id }));
      }}
      onClose={onClose}
    >
      <Field id="create-owner-email" label={at('tenants.ownerEmail')}>
        <input
          id="create-owner-email"
          type="email"
          autoComplete="off"
          value={email}
          maxLength={320}
          onChange={(e) => setEmail(e.target.value)}
          className={fieldClass}
        />
      </Field>
      <Field id="create-shop-name" label={at('tenants.shopName')}>
        <input
          id="create-shop-name"
          value={name}
          maxLength={MAX_SHOP_NAME_LENGTH}
          onChange={(e) => setName(e.target.value)}
          className={fieldClass}
        />
      </Field>
      <Field id="create-shop-phone" label={at('tenants.phone')}>
        <input
          id="create-shop-phone"
          type="tel"
          autoComplete="off"
          value={phone}
          maxLength={24}
          placeholder="082 123 4567"
          aria-invalid={normalizedPhone === 'invalid'}
          aria-describedby={normalizedPhone === 'invalid' ? 'create-shop-phone-error' : undefined}
          onChange={(e) => setPhone(e.target.value)}
          className={fieldClass}
        />
        {normalizedPhone === 'invalid' && (
          <span id="create-shop-phone-error" className="text-xs text-rose-400">
            {at('tenants.phoneInvalid')}
          </span>
        )}
      </Field>
      <Field id="create-shop-address" label={at('tenants.address')}>
        <input
          id="create-shop-address"
          autoComplete="off"
          value={address}
          maxLength={MAX_ADDRESS_LENGTH}
          onChange={(e) => setAddress(e.target.value)}
          className={fieldClass}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="create-shop-city" label={at('tenants.city')}>
          <input
            id="create-shop-city"
            autoComplete="off"
            value={city}
            maxLength={MAX_CITY_LENGTH}
            onChange={(e) => setCity(e.target.value)}
            className={fieldClass}
          />
        </Field>
        <Field id="create-shop-province" label={at('tenants.province')}>
          <select
            id="create-shop-province"
            value={province}
            onChange={(e) => setProvince(e.target.value as ProvinceCode | '')}
            className={`${selectClass} w-full`}
          >
            <option value="">{at('common.none')}</option>
            {PROVINCES.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </ReasonConfirmDialog>
  );
};
