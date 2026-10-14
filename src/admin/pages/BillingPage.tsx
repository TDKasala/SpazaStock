import React, { useEffect, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/ErrorMessage';
import { adminApi, adminErrorMessage } from '../api';
import { useAdminIdentity } from '../AdminContext';
import { useAdminI18n } from '../i18n';
import { formatCents, formatDateTime, formatNumber } from '../format';
import { canAdmin } from '../permissions';
import type { Plan, PlansReport } from '../types';
import { useAdminQuery } from '../useAdminQuery';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { ReasonConfirmDialog } from '../components/ReasonConfirmDialog';
import { selectClass } from '../components/DateRangeFilter';
import { Field, fieldClass, PageHeader, QueryError, Section } from '../components/PageParts';

type EntitlementTarget = { plan: Plan; key: string; kind: 'boolean' | 'limit' };
type FeatureTarget = { key: string; enabled: boolean };

export const BillingPage: React.FC = () => {
  const { at, label, locale } = useAdminI18n();
  const identity = useAdminIdentity();
  const canManagePlans = canAdmin(identity.role, 'plans.manage');
  const report = useAdminQuery('plans', () => adminApi.listPlans());
  const [editingPlan, setEditingPlan] = useState<Plan | 'new' | null>(null);
  const [entitlement, setEntitlement] = useState<EntitlementTarget | null>(null);
  const [feature, setFeature] = useState<FeatureTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const saved = (message: string) => {
    setNotice(message);
    report.reload();
  };

  if (!report.data) {
    return (
      <>
        <PageHeader title={at('billing.title')} description={at('billing.description')} />
        {report.error ? <QueryError message={adminErrorMessage(report.error, at)} onRetry={report.reload} /> : null}
      </>
    );
  }

  const data: PlansReport = report.data;

  const planColumns: Column<Plan>[] = [
    {
      key: 'name',
      header: at('billing.plan'),
      render: (p) => (
        <span>
          {p.name}
          <code className="block text-[11px] text-zinc-500">{p.code}</code>
        </span>
      ),
    },
    {
      key: 'price',
      header: at('billing.price'),
      align: 'right',
      render: (p) =>
        p.price_cents === null
          ? at('billing.priceNotSet')
          : `${formatCents(p.price_cents, p.currency, locale)} / ${label('intervals', p.billing_interval)}`,
    },
    { key: 'trial', header: at('billing.trialDays'), align: 'right', render: (p) => formatNumber(p.trial_days, locale) },
    { key: 'grace', header: at('billing.graceDays'), align: 'right', render: (p) => formatNumber(p.grace_days, locale) },
    { key: 'subs', header: at('billing.subscriptions'), align: 'right', render: (p) => formatNumber(p.subscriptions, locale) },
    { key: 'active', header: at('common.status'), render: (p) => <StatusBadge value={p.is_active ? 'active' : 'inactive'} /> },
  ];
  if (canManagePlans) {
    planColumns.push({
      key: 'edit',
      header: at('common.actions'),
      render: (p) => (
        <Button variant="ghost" size="sm" leftIcon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setEditingPlan(p)}>
          {at('common.edit')}
        </Button>
      ),
    });
  }

  return (
    <>
      <PageHeader
        title={at('billing.title')}
        description={at('billing.description')}
        actions={
          canManagePlans && (
            <Button size="sm" leftIcon={<Plus className="w-4 h-4" />} onClick={() => setEditingPlan('new')}>
              {at('billing.newPlan')}
            </Button>
          )
        }
      />
      {notice && <ErrorMessage variant="success" message={notice} onDismiss={() => setNotice(null)} />}

      <Section title={at('billing.payments')}>
        <p className="text-sm text-zinc-400">
          {data.payments.provider_connected ? at('billing.paymentsConnected') : at('billing.paymentsNone')}
        </p>
      </Section>

      <Section title={at('billing.plans')} description={at('billing.plansDescription')}>
        <DataTable caption={at('billing.plans')} hideCaption columns={planColumns} rows={data.plans} rowKey={(p) => p.code} />
      </Section>

      <Section title={at('billing.entitlements')} description={at('billing.entitlementsDescription')}>
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <caption className="sr-only">{at('billing.entitlements')}</caption>
            <thead className="bg-zinc-900/80 text-xs text-zinc-400">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">{at('billing.entitlement')}</th>
                {data.plans.map((p) => (
                  <th key={p.code} scope="col" className="px-3 py-2 text-left font-medium">{p.name}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {data.catalog.map((item) => (
                <tr key={item.key}>
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <span className="text-zinc-200">{label('entitlements', item.key)}</span>
                    <span className="block text-xs text-zinc-500">{at(`entitlementHelp.${item.key.replace(/\./g, '_')}`)}</span>
                  </th>
                  {data.plans.map((p) => {
                    const value = p.entitlements[item.key];
                    const text = !value
                      ? at('billing.notConfigured')
                      : !value.enabled
                        ? at('common.off')
                        : item.kind === 'limit'
                          ? value.limit === null
                            ? at('common.unlimited')
                            : formatNumber(value.limit, locale)
                          : at('common.on');
                    return (
                      <td key={p.code} className="px-3 py-2">
                        <span className="inline-flex items-center gap-2">
                          {text}
                          {canManagePlans && (
                            <button
                              type="button"
                              className="p-1 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"
                              aria-label={at('billing.editEntitlement', { entitlement: label('entitlements', item.key), plan: p.name })}
                              onClick={() => setEntitlement({ plan: p, key: item.key, kind: item.kind })}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-zinc-500">{at('billing.missingMeansOn')}</p>
      </Section>

      <Section title={at('billing.features')} description={at('billing.featuresDescription')}>
        <ul className="divide-y divide-zinc-800/80">
          {data.catalog
            .filter((c) => c.kind === 'boolean')
            .map((c) => {
              const row = data.features.find((f) => f.key === c.key);
              const enabled = row?.enabled ?? true;
              return (
                <li key={c.key} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div>
                    <p className="text-sm text-zinc-200">{label('entitlements', c.key)}</p>
                    {row && (
                      <p className="text-xs text-zinc-500">
                        {at('billing.featureUpdated', {
                          time: formatDateTime(row.updated_at, locale),
                          who: row.updated_by_email ?? at('common.none'),
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge value={enabled ? 'on' : 'off'} />
                    {canManagePlans && (
                      <Button variant="outline" size="sm" onClick={() => setFeature({ key: c.key, enabled: !enabled })}>
                        {at(enabled ? 'billing.turnOff' : 'billing.turnOn')}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
        </ul>
      </Section>

      <PlanDialog
        target={editingPlan}
        onClose={() => setEditingPlan(null)}
        onSaved={() => {
          setEditingPlan(null);
          saved(at('billing.planSaved'));
        }}
      />
      <EntitlementDialog
        target={entitlement}
        onClose={() => setEntitlement(null)}
        onSaved={() => {
          setEntitlement(null);
          saved(at('billing.entitlementSaved'));
        }}
      />
      <ReasonConfirmDialog
        isOpen={feature !== null}
        title={feature ? at(feature.enabled ? 'billing.turnOnTitle' : 'billing.turnOffTitle', { feature: label('entitlements', feature.key) }) : ''}
        description={at(feature?.enabled ? 'billing.turnOnDescription' : 'billing.turnOffDescription')}
        confirmLabel={at(feature?.enabled ? 'billing.turnOn' : 'billing.turnOff')}
        danger={feature ? !feature.enabled : false}
        onConfirm={async (reason) => {
          if (!feature) return;
          await adminApi.setFeature(feature.key, feature.enabled, reason);
          setFeature(null);
          saved(at('billing.featureSaved'));
        }}
        onClose={() => setFeature(null)}
      />
    </>
  );
};

interface PlanDraft {
  code: string;
  name: string;
  price: string;
  currency: string;
  billingInterval: 'month' | 'year';
  trialDays: string;
  graceDays: string;
  isActive: boolean;
}

function draftFrom(plan: Plan | 'new' | null): PlanDraft {
  if (!plan || plan === 'new') {
    return { code: '', name: '', price: '', currency: 'ZAR', billingInterval: 'month', trialDays: '0', graceDays: '0', isActive: true };
  }
  return {
    code: plan.code,
    name: plan.name,
    price: plan.price_cents === null ? '' : (plan.price_cents / 100).toFixed(2),
    currency: plan.currency,
    billingInterval: plan.billing_interval,
    trialDays: String(plan.trial_days),
    graceDays: String(plan.grace_days),
    isActive: plan.is_active,
  };
}

/** Rands as typed ("49.99" or "49,99") to cents; empty is "not set". Undefined when invalid. */
export function parsePriceCents(text: string): number | null | undefined {
  const value = text.trim().replace(',', '.');
  if (value === '') return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return undefined;
  return Math.round(Number.parseFloat(value) * 100);
}

function parseWhole(text: string, max: number): number | undefined {
  if (!/^\d{1,4}$/.test(text.trim())) return undefined;
  const value = Number.parseInt(text, 10);
  return value <= max ? value : undefined;
}

const PlanDialog: React.FC<{ target: Plan | 'new' | null; onClose: () => void; onSaved: () => void }> = ({
  target,
  onClose,
  onSaved,
}) => {
  const { at } = useAdminI18n();
  const [draft, setDraft] = useState<PlanDraft>(() => draftFrom(target));
  const isNew = target === 'new';

  useEffect(() => setDraft(draftFrom(target)), [target]);

  const price = parsePriceCents(draft.price);
  const trial = parseWhole(draft.trialDays, 365);
  const grace = parseWhole(draft.graceDays, 90);
  const codeOk = /^[a-z][a-z0-9_]{1,31}$/.test(draft.code);
  const valid =
    codeOk && draft.name.trim().length > 0 && price !== undefined && trial !== undefined && grace !== undefined && /^[A-Z]{3}$/.test(draft.currency);
  const set = (patch: Partial<PlanDraft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <ReasonConfirmDialog
      isOpen={target !== null}
      title={isNew ? at('billing.newPlan') : at('billing.editPlan', { name: draft.name })}
      description={at('billing.planDialogDescription')}
      confirmLabel={at('common.save')}
      canSubmit={valid}
      onConfirm={async (reason) => {
        if (!valid || price === undefined || trial === undefined || grace === undefined) return;
        await adminApi.upsertPlan(
          {
            code: draft.code,
            name: draft.name.trim(),
            priceCents: price,
            currency: draft.currency,
            billingInterval: draft.billingInterval,
            trialDays: trial,
            graceDays: grace,
            isActive: draft.isActive,
          },
          reason
        );
        onSaved();
      }}
      onClose={onClose}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field id="plan-code" label={at('billing.code')} hint={isNew ? at('billing.codeHint') : undefined}>
          <input
            id="plan-code"
            className={fieldClass}
            value={draft.code}
            disabled={!isNew}
            maxLength={32}
            onChange={(e) => set({ code: e.target.value.toLowerCase() })}
          />
        </Field>
        <Field id="plan-name" label={at('billing.name')}>
          <input id="plan-name" className={fieldClass} value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field id="plan-price" label={at('billing.priceLabel')} hint={at('billing.priceHint')}>
          <input
            id="plan-price"
            className={fieldClass}
            inputMode="decimal"
            value={draft.price}
            onChange={(e) => set({ price: e.target.value })}
            aria-invalid={price === undefined}
          />
        </Field>
        <Field id="plan-currency" label={at('billing.currency')}>
          <input
            id="plan-currency"
            className={fieldClass}
            value={draft.currency}
            maxLength={3}
            onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
          />
        </Field>
        <Field id="plan-interval" label={at('billing.interval')}>
          <select
            id="plan-interval"
            className={selectClass}
            value={draft.billingInterval}
            onChange={(e) => set({ billingInterval: e.target.value as 'month' | 'year' })}
          >
            <option value="month">{at('intervals.month')}</option>
            <option value="year">{at('intervals.year')}</option>
          </select>
        </Field>
        <Field id="plan-trial" label={at('billing.trialDays')}>
          <input
            id="plan-trial"
            className={fieldClass}
            inputMode="numeric"
            value={draft.trialDays}
            onChange={(e) => set({ trialDays: e.target.value })}
            aria-invalid={trial === undefined}
          />
        </Field>
        <Field id="plan-grace" label={at('billing.graceDays')} hint={at('billing.graceHint')}>
          <input
            id="plan-grace"
            className={fieldClass}
            inputMode="numeric"
            value={draft.graceDays}
            onChange={(e) => set({ graceDays: e.target.value })}
            aria-invalid={grace === undefined}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={draft.isActive}
          disabled={draft.code === 'free'}
          onChange={(e) => set({ isActive: e.target.checked })}
          className="accent-emerald-500"
        />
        {at('billing.availableForNew')}
      </label>
      {draft.code === 'free' && <p className="text-xs text-zinc-500">{at('billing.freeNote')}</p>}
    </ReasonConfirmDialog>
  );
};

const EntitlementDialog: React.FC<{ target: EntitlementTarget | null; onClose: () => void; onSaved: () => void }> = ({
  target,
  onClose,
  onSaved,
}) => {
  const { at, label } = useAdminI18n();
  const [enabled, setEnabled] = useState(true);
  const [limit, setLimit] = useState('');

  useEffect(() => {
    if (!target) return;
    const current = target.plan.entitlements[target.key];
    setEnabled(current?.enabled ?? true);
    setLimit(current?.limit === null || current?.limit === undefined ? '' : String(current.limit));
  }, [target]);

  const limitValue = limit.trim() === '' ? null : /^\d{1,7}$/.test(limit.trim()) ? Number.parseInt(limit, 10) : undefined;
  const valid = target?.kind !== 'limit' || (limitValue !== undefined && (limitValue === null || limitValue <= 1_000_000));

  return (
    <ReasonConfirmDialog
      isOpen={target !== null}
      title={target ? at('billing.editEntitlement', { entitlement: label('entitlements', target.key), plan: target.plan.name }) : ''}
      description={at('billing.entitlementDialogDescription')}
      confirmLabel={at('common.save')}
      canSubmit={valid}
      onConfirm={async (reason) => {
        if (!target || limitValue === undefined) return;
        await adminApi.setEntitlement(target.plan.code, target.key, enabled, target.kind === 'limit' ? limitValue : null, reason);
        onSaved();
      }}
      onClose={onClose}
    >
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-emerald-500" />
        {at('billing.entitlementEnabled')}
      </label>
      {target?.kind === 'limit' && enabled && (
        <Field id="entitlement-limit" label={at('billing.limit')} hint={at('billing.limitHint')}>
          <input
            id="entitlement-limit"
            className={fieldClass}
            inputMode="numeric"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            aria-invalid={limitValue === undefined}
          />
        </Field>
      )}
    </ReasonConfirmDialog>
  );
};
