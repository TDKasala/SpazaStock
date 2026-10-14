import React, { useEffect, useState } from 'react';
import { ArrowLeft, Ban, CreditCard, PlayCircle } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/ErrorMessage';
import { LoadingState } from '../../components/ui/LoadingState';
import { adminApi, adminErrorMessage } from '../api';
import { useAdminIdentity } from '../AdminContext';
import { useAdminI18n } from '../i18n';
import { formatDate, formatDateTime, formatMoney, formatNumber, platformDayStart, toPlatformDay } from '../format';
import { canAdmin } from '../permissions';
import { adminHref } from '../router';
import type { Plan, TenantDetail, TenantMember } from '../types';
import { useAdminQuery } from '../useAdminQuery';
import { AdminLink } from '../components/AdminLink';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { ReasonConfirmDialog } from '../components/ReasonConfirmDialog';
import { selectClass } from '../components/DateRangeFilter';
import { DetailList, Field, PageHeader, QueryError, Section } from '../components/PageParts';
import { provinceName } from '../../lib/shopDetails';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A date input's day means "until the end of that South African day". */
function endOfDay(day: string): string | null {
  return day ? new Date(platformDayStart(day).getTime() + DAY_MS).toISOString() : null;
}

function dayOf(value: string | null): string {
  return value ? toPlatformDay(new Date(new Date(value).getTime() - 1)) : '';
}

export const TenantDetailPage: React.FC<{ shopId: string }> = ({ shopId }) => {
  const { at, label, locale } = useAdminI18n();
  const identity = useAdminIdentity();
  const tenant = useAdminQuery(shopId, () => adminApi.getTenant(shopId));
  const [statusOpen, setStatusOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = canAdmin(identity.role, 'tenants.manage');
  const canBill = canAdmin(identity.role, 'billing.manage');
  const canAudit = canAdmin(identity.role, 'audit.view');

  const back = (
    <AdminLink href={adminHref('tenants')} className="inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100">
      <ArrowLeft className="w-4 h-4" />
      {at('tenant.back')}
    </AdminLink>
  );

  if (!tenant.data) {
    return (
      <>
        {back}
        {tenant.error ? (
          <QueryError message={adminErrorMessage(tenant.error, at)} onRetry={tenant.reload} />
        ) : (
          <LoadingState message={at('common.loading')} />
        )}
      </>
    );
  }

  const data: TenantDetail = tenant.data;
  const { shop } = data;
  const suspended = shop.status === 'suspended';
  const n = (v: number | null | undefined) => formatNumber(v, locale);
  const dt = (v: string | null | undefined) => formatDateTime(v, locale);

  const memberColumns: Column<TenantMember>[] = [
    {
      key: 'email',
      header: at('tenant.email'),
      render: (m) => (
        <span>
          {m.email ?? at('common.none')}
          {m.display_name && <span className="block text-xs text-zinc-500">{m.display_name}</span>}
        </span>
      ),
    },
    { key: 'role', header: at('tenant.role'), render: (m) => label('shopRoles', m.role) },
    { key: 'status', header: at('common.status'), render: (m) => <StatusBadge value={m.status} /> },
    { key: 'joined', header: at('tenant.joined'), render: (m) => formatDate(m.joined_at, locale) },
    { key: 'signin', header: at('tenant.lastSignIn'), render: (m) => dt(m.last_sign_in_at) },
  ];

  const limit = data.usage.team_limit;

  return (
    <>
      {back}
      <PageHeader
        title={shop.name}
        description={at('tenant.accessNote')}
        actions={
          <>
            <StatusBadge value={shop.status} />
            {canBill && data.subscription && (
              <Button variant="outline" size="sm" leftIcon={<CreditCard className="w-4 h-4" />} onClick={() => setSubscriptionOpen(true)}>
                {at('tenant.changeSubscription')}
              </Button>
            )}
            {canManage && (
              <Button
                variant={suspended ? 'primary' : 'danger'}
                size="sm"
                leftIcon={suspended ? <PlayCircle className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
                onClick={() => setStatusOpen(true)}
              >
                {at(suspended ? 'tenant.reactivate' : 'tenant.suspend')}
              </Button>
            )}
          </>
        }
      />

      {notice && <ErrorMessage variant="success" message={notice} onDismiss={() => setNotice(null)} />}
      {suspended && (
        <ErrorMessage
          variant="warning"
          title={at('tenant.suspendedBanner')}
          message={`${dt(shop.suspended_at)} · ${shop.suspended_by_email ?? at('common.none')} · ${shop.suspension_reason ?? ''}`}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={at('tenant.profile')}>
          <DetailList
            items={[
              [at('tenant.id'), <code className="text-xs">{shop.id}</code>],
              [at('tenant.createdAt'), dt(shop.created_at)],
              [
                at('tenant.phone'),
                shop.phone ? <a href={`tel:${shop.phone}`} className="text-emerald-300 hover:underline">{shop.phone}</a> : at('common.none'),
              ],
              [
                at('tenant.address'),
                [shop.address, shop.city, provinceName(shop.province)].filter(Boolean).join(', ') || at('common.none'),
              ],
              [at('tenant.timezone'), shop.timezone],
              [at('tenant.reminders'), (shop.expiry_reminder_days ?? []).join(', ') || at('common.none')],
            ]}
          />
        </Section>
        <Section title={at('tenant.owner')}>
          {data.owner ? (
            <DetailList
              items={[
                [at('tenant.email'), data.owner.email ?? at('common.none')],
                [at('tenant.name'), data.owner.display_name ?? at('common.none')],
                [at('tenant.emailConfirmed'), at(data.owner.email_confirmed ? 'common.yes' : 'common.no')],
                [at('tenant.accountCreated'), dt(data.owner.created_at)],
                [at('tenant.lastSignIn'), dt(data.owner.last_sign_in_at)],
              ]}
            />
          ) : (
            <p className="text-sm text-zinc-500">{at('common.none')}</p>
          )}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={at('tenant.subscription')}>
          {data.subscription ? (
            <DetailList
              items={[
                [at('common.plan'), label('plans', data.subscription.plan)],
                [at('common.status'), <StatusBadge value={data.subscription.status} />],
                [at('tenant.trialEnds'), dt(data.subscription.trial_ends_at)],
                [at('tenant.periodEnd'), dt(data.subscription.current_period_end)],
                [at('tenant.provider'), data.subscription.provider ?? at('tenant.noProvider')],
                [at('tenant.effectivePlan'), label('plans', data.entitlements.plan)],
              ]}
            />
          ) : (
            <p className="text-sm text-zinc-500">{at('common.none')}</p>
          )}
        </Section>
        <Section title={at('tenant.entitlements')}>
          <DetailList
            items={[
              [at('entitlements.expiry_push'), at(data.entitlements.expiry_push ? 'common.on' : 'common.off')],
              [
                at('tenant.teamMembers'),
                limit === null
                  ? at('tenant.usageUnlimited', { used: n(data.usage.team_members) })
                  : at('tenant.usageOf', { used: n(data.usage.team_members), limit: n(limit) }),
              ],
            ]}
          />
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={at('tenant.inventory')}>
          <DetailList
            items={[
              [at('tenant.productsActive'), n(data.inventory.active_products)],
              [at('tenant.productsArchived'), n(data.inventory.archived_products)],
              [at('tenant.batchesInStock'), n(data.inventory.batches_in_stock)],
              [at('tenant.unitsInStock'), n(data.inventory.units_in_stock)],
              [
                at('tenant.stockValue'),
                <>
                  {formatMoney(data.inventory.stock_value_at_cost, 'ZAR', locale)}
                  {data.inventory.batches_without_cost > 0 && (
                    <span className="block text-xs text-zinc-500">
                      {at('tenant.stockValueNote', { count: n(data.inventory.batches_without_cost) })}
                    </span>
                  )}
                </>,
              ],
            ]}
          />
        </Section>
        <Section title={at('tenant.activity')}>
          <DetailList
            items={[
              [at('tenant.lastMovement'), dt(data.activity.last_movement_at)],
              [at('tenant.movements30d'), n(data.activity.movements_30d)],
              [at('tenant.sales30d'), n(data.activity.sales_30d)],
              [at('tenant.openAlerts'), n(data.activity.open_expiry_alerts)],
              [at('tenant.syncFailures7d'), n(data.activity.sync_failures_7d)],
            ]}
          />
        </Section>
      </div>

      <Section title={at('tenant.members')}>
        <DataTable
          caption={at('tenant.members')}
          hideCaption
          columns={memberColumns}
          rows={data.members}
          rowKey={(m) => m.member_id}
        />
      </Section>

      <Section title={at('tenant.outlets')} description={at('tenant.outletsDescription')}>
        {data.outlets.length === 0 ? (
          <p className="text-sm text-zinc-500">{at('tenant.noOutlets')}</p>
        ) : (
          <ul className="divide-y divide-zinc-800/80 text-sm">
            {data.outlets.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 py-2">
                <AdminLink href={adminHref('tenants', { tenantId: o.id })} className="text-emerald-300 hover:underline">
                  {o.name}
                </AdminLink>
                <span className="flex items-center gap-2 text-xs text-zinc-500">
                  {formatDate(o.created_at, locale)}
                  <StatusBadge value={o.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={at('tenant.history')}>
        <div className="grid gap-6 lg:grid-cols-3">
          <HistoryList
            title={at('tenant.membershipHistory')}
            items={data.history.membership.map((e) => ({
              when: e.occurred_at,
              text: `${label('memberActions', e.action)}: ${e.target_email ?? at('common.none')}${
                e.new_role ? ` (${label('shopRoles', e.old_role)} → ${label('shopRoles', e.new_role)})` : ''
              }`,
              who: e.actor_email,
            }))}
          />
          <HistoryList
            title={at('tenant.subscriptionHistory')}
            items={data.history.subscription.map((e) => ({
              when: e.occurred_at,
              text: `${label('subscriptionEvents', e.event)}: ${label('plans', e.new_plan)} · ${label('status', e.new_status)}`,
              who: e.actor_email,
            }))}
          />
          <HistoryList
            title={at('tenant.adminHistory')}
            items={data.history.admin.map((e) => ({
              when: e.occurred_at,
              text: `${label('actions', e.action)}${e.outcome === 'denied' ? ` (${label('status', 'denied')})` : ''}${
                e.reason ? `: ${e.reason}` : ''
              }`,
              who: e.actor_email,
            }))}
            footer={
              canAudit ? (
                <AdminLink href={adminHref('audit', { params: { shop: shop.id } })} className="text-xs text-emerald-300 hover:underline">
                  {at('tenant.openAudit')}
                </AdminLink>
              ) : null
            }
          />
        </div>
      </Section>

      <ReasonConfirmDialog
        isOpen={statusOpen}
        title={at(suspended ? 'tenant.reactivateTitle' : 'tenant.suspendTitle', { name: shop.name })}
        description={at(suspended ? 'tenant.reactivateDescription' : 'tenant.suspendDescription')}
        confirmLabel={at(suspended ? 'tenant.reactivate' : 'tenant.suspend')}
        danger={!suspended}
        confirmName={suspended ? undefined : shop.name}
        onConfirm={async (reason) => {
          await adminApi.setShopStatus(shop.id, suspended ? 'active' : 'suspended', reason);
          setStatusOpen(false);
          setNotice(at(suspended ? 'tenant.reactivated' : 'tenant.suspended'));
          tenant.reload();
        }}
        onClose={() => setStatusOpen(false)}
      />
      {data.subscription && (
        <SubscriptionDialog
          isOpen={subscriptionOpen}
          shopId={shop.id}
          current={data.subscription}
          onClose={() => setSubscriptionOpen(false)}
          onSaved={(plan) => {
            setSubscriptionOpen(false);
            setNotice(at('tenant.subscriptionUpdated', { plan: label('plans', plan) }));
            tenant.reload();
          }}
        />
      )}
    </>
  );
};

const HistoryList: React.FC<{
  title: string;
  items: { when: string; text: string; who: string | null }[];
  footer?: React.ReactNode;
}> = ({ title, items, footer }) => {
  const { at, locale } = useAdminI18n();
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500">{at('tenant.noHistory')}</p>
      ) : (
        <ol className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {items.map((item, i) => (
            <li key={`${item.when}-${i}`} className="text-sm border-l-2 border-zinc-800 pl-3">
              <span className="block text-zinc-200 break-words">{item.text}</span>
              <span className="block text-xs text-zinc-500">
                {formatDateTime(item.when, locale)}
                {item.who ? ` · ${item.who}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
      {footer}
    </div>
  );
};

const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'canceled'] as const;

const SubscriptionDialog: React.FC<{
  isOpen: boolean;
  shopId: string;
  current: NonNullable<TenantDetail['subscription']>;
  onClose: () => void;
  onSaved: (effectivePlan: string) => void;
}> = ({ isOpen, shopId, current, onClose, onSaved }) => {
  const { at, label } = useAdminI18n();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [plan, setPlan] = useState(current.plan);
  const [status, setStatus] = useState(current.status);
  const [trialDay, setTrialDay] = useState(dayOf(current.trial_ends_at));
  const [periodDay, setPeriodDay] = useState(dayOf(current.current_period_end));

  useEffect(() => {
    if (!isOpen) return;
    setPlan(current.plan);
    setStatus(current.status);
    setTrialDay(dayOf(current.trial_ends_at));
    setPeriodDay(dayOf(current.current_period_end));
    adminApi
      .listPlans()
      .then((r) => setPlans(r.plans))
      .catch(() => setPlans([]));
  }, [isOpen, current]);

  const choices = (plans ?? []).filter((p) => p.is_active || p.code === current.plan);
  const complete = Boolean(plan) && (status !== 'past_due' || Boolean(periodDay));

  return (
    <ReasonConfirmDialog
      isOpen={isOpen}
      title={at('tenant.changeSubscription')}
      description={at('subscriptionForm.note')}
      confirmLabel={at('common.save')}
      canSubmit={complete}
      onConfirm={async (reason) => {
        const result = await adminApi.updateSubscription(
          shopId,
          {
            plan,
            status,
            trialEndsAt: status === 'trialing' ? endOfDay(trialDay) : null,
            currentPeriodEnd: endOfDay(periodDay),
          },
          reason
        );
        onSaved(result.effective_plan);
      }}
      onClose={onClose}
    >
      <Field id="sub-plan" label={at('common.plan')}>
        <select id="sub-plan" className={selectClass} value={plan} onChange={(e) => setPlan(e.target.value)}>
          {choices.length === 0 && <option value={current.plan}>{label('plans', current.plan)}</option>}
          {choices.map((p) => (
            <option key={p.code} value={p.code}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="sub-status" label={at('common.status')}>
        <select id="sub-status" className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)}>
          {SUBSCRIPTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {label('status', s)}
            </option>
          ))}
        </select>
      </Field>
      {status === 'trialing' && (
        <Field id="sub-trial" label={at('subscriptionForm.trialEnds')} hint={at('subscriptionForm.trialHint')}>
          <input id="sub-trial" type="date" className={selectClass} value={trialDay} onChange={(e) => setTrialDay(e.target.value)} />
        </Field>
      )}
      <Field
        id="sub-period"
        label={at('subscriptionForm.periodEnd')}
        hint={status === 'past_due' ? at('subscriptionForm.pastDueHint') : at('subscriptionForm.periodHint')}
      >
        <input id="sub-period" type="date" className={selectClass} value={periodDay} onChange={(e) => setPeriodDay(e.target.value)} />
      </Field>
    </ReasonConfirmDialog>
  );
};
