// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  auditRows,
  bootstrapSuperadmin,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  grantAdmin,
  newProduct,
  REASON,
  rpc,
  sell,
  stockIn,
  type User,
} from './harness';

let pg: PGlite;
let root: User;
let support: User;
let alpha: User;
let beta: User;
let gamma: User;
let shopA: string;
let shopB: string;
let shopC: string;

type Result = { ok: boolean; code?: string; [key: string]: unknown };

const HOUR = 3600 * 1000;
const recent = () => ({ p_from: new Date(Date.now() - HOUR).toISOString(), p_to: new Date(Date.now() + HOUR).toISOString() });

// Midnight in Johannesburg (UTC+2) on the given day.
const sast = (day: string) => `${day}T00:00:00+02:00`;

// Shop creation times, fixed so date buckets are predictable:
//   Alpha  2026-01-05 12:00 SAST
//   Beta   2026-01-06 01:30 SAST (still 5 January in UTC)
//   Gamma  2026-01-20 02:00 SAST
const CREATED = {
  alpha: '2026-01-05T10:00:00Z',
  beta: '2026-01-05T23:30:00Z',
  gamma: '2026-01-20T00:00:00Z',
};

function call(caller: User | null, fn: string, args: Record<string, unknown> = {}) {
  return rpc<Result>(pg, caller, fn, args);
}

function tenants(args: Record<string, unknown> = {}) {
  return call(root, 'admin_list_tenants', args) as Promise<
    Result & { total: number; limit: number; offset: number; rows: { id: string; name: string; owner_email: string }[] }
  >;
}

beforeAll(async () => {
  pg = await createDatabase();
  root = await createUser(pg);
  support = await createUser(pg);
  alpha = await createUser(pg, 'alpha@example.com');
  beta = await createUser(pg, 'beta@example.com');
  gamma = await createUser(pg, 'gamma@example.com');
  await createUser(pg, undefined, { unconfirmed: true });
  await bootstrapSuperadmin(pg, root);
  await grantAdmin(pg, root, support, 'support');

  shopA = await createShop(pg, alpha, 'Alpha Spaza');
  shopB = await createShop(pg, beta, 'Beta Store');
  shopC = await createShop(pg, gamma, 'Gamma 100% Shop');
  for (const [id, at] of [[shopA, CREATED.alpha], [shopB, CREATED.beta], [shopC, CREATED.gamma]]) {
    await pg.query('update public.shops set created_at = $2 where id = $1', [id, at]);
  }

  const product = await newProduct(pg, alpha, shopA);
  await stockIn(pg, alpha, shopA, product.id, 10);
  await sell(pg, alpha, shopA, [{ product_id: product.id, quantity: 3 }]);

  await rpc(pg, root, 'admin_set_shop_status', { p_shop_id: shopB, p_status: 'suspended', p_reason: REASON });
  const subscription = (plan: string, status: string, shop: string) =>
    rpc(pg, root, 'admin_update_subscription', {
      p_shop_id: shop, p_plan: plan, p_status: status, p_trial_ends_at: null, p_current_period_end: null, p_reason: REASON,
    });
  await subscription('pro', 'trialing', shopA);
  await subscription('pro', 'active', shopA);
  await subscription('free', 'canceled', shopC);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('overview', () => {
  it('counts what happened in the range, straight from the tables', async () => {
    const overview = await call(root, 'admin_platform_overview', recent());
    expect(overview).toMatchObject({
      ok: true,
      shops: { total: 3, active: 2, suspended: 1, new: 0 },
      users: { registered: 6, confirmed: 5, new: 6 },
      subscriptions: { by_plan: { free: 2, pro: 1 }, by_status: { active: 2, canceled: 1 }, active: 2, trials_active: 0, cancellations: 1 },
      stock: { movements: 2, units_in: 10, units_out: 3, active_shops: 1 },
      stock_by_reason: { stock_in: 1, sale: 1 },
      sales: 1,
      errors: { push_failed: 0, sync_failures: 0, cron_failures: null },
      revenue: { available: false, reason: 'no_payment_provider' },
    });
  });

  it('includes the start of the range and excludes the end', async () => {
    const at = (from: string, to: string) =>
      call(root, 'admin_platform_overview', { p_from: from, p_to: to }).then((o) => (o.shops as { new: number }).new);
    expect(await at(CREATED.alpha, CREATED.gamma)).toBe(2);
    expect(await at(CREATED.beta, CREATED.gamma)).toBe(1);
    expect(await at(sast('2026-01-01'), CREATED.beta)).toBe(1);
  });

  it('rejects empty, reversed and over-long ranges', async () => {
    expect(await errorCode(call(root, 'admin_platform_overview', { p_from: CREATED.gamma, p_to: CREATED.gamma }))).toBe('22023');
    expect(await errorCode(call(root, 'admin_platform_overview', { p_from: CREATED.gamma, p_to: CREATED.alpha }))).toBe('22023');
    expect(await errorCode(call(root, 'admin_platform_overview', { p_from: sast('2025-01-01'), p_to: sast('2026-01-03') }))).toBe('22023');
    expect((await call(root, 'admin_platform_overview', { p_from: sast('2025-01-01'), p_to: sast('2026-01-02') })).ok).toBe(true);
    expect(await errorCode(call(root, 'admin_platform_overview', { p_from: null, p_to: CREATED.gamma }))).toBe('22023');
  });
});

describe('growth series', () => {
  const series = (bucket: string, from: string, to: string, metric = 'shops') =>
    call(root, 'admin_growth_series', { p_metric: metric, p_from: from, p_to: to, p_bucket: bucket }).then(
      (r) => r.series as { bucket: string; value: number }[]
    );

  it('buckets by Johannesburg day, week and month, including empty buckets', async () => {
    expect(await series('day', sast('2026-01-05'), sast('2026-01-08'))).toEqual([
      { bucket: '2026-01-05', value: 1 },
      { bucket: '2026-01-06', value: 1 },
      { bucket: '2026-01-07', value: 0 },
    ]);
    expect(await series('week', sast('2026-01-05'), sast('2026-01-26'))).toEqual([
      { bucket: '2026-01-05', value: 2 },
      { bucket: '2026-01-12', value: 0 },
      { bucket: '2026-01-19', value: 1 },
    ]);
    expect(await series('month', sast('2026-01-01'), sast('2026-03-01'))).toEqual([
      { bucket: '2026-01-01', value: 3 },
      { bucket: '2026-02-01', value: 0 },
    ]);
  });

  it('counts distinct active shops and validates its inputs', async () => {
    const { p_from, p_to } = recent();
    const active = await series('month', p_from, p_to, 'active_shops');
    expect(active.reduce((sum, b) => sum + b.value, 0)).toBe(1);
    const movements = await series('month', p_from, p_to, 'stock_movements');
    expect(movements.reduce((sum, b) => sum + b.value, 0)).toBe(2);
    expect(await errorCode(series('hour', p_from, p_to))).toBe('22023');
    expect(await errorCode(series('day', p_from, p_to, 'revenue'))).toBe('22023');
  });
});

describe('analytics', () => {
  it('reports tenants, usage, conversion and plan distribution', async () => {
    const report = await call(root, 'admin_analytics', { p_from: sast('2026-01-05'), p_to: sast('2026-01-08') });
    expect(report.tenants).toEqual({ at_start: 0, at_end: 2, new: 2 });

    const now = await call(root, 'admin_analytics', recent());
    expect(now).toMatchObject({
      usage: { active_shops: 1, active_users: 1 },
      conversion: { trials_started: 1, trials_converted: 1, trials_lapsed: 0 },
      plan_distribution: { subscribed: { free: 2, pro: 1 }, effective: { free: 2, pro: 1 } },
      feature_adoption: { shops: 3, push_enabled: 0, teams: 0, expiry_tracking: 0 },
      stock_volumes: { stock_in: { movements: 1, units: 10 }, sale: { movements: 1, units: 3 } },
    });
    const retention = now.retention as { cohort: string; size: number; active: number[] }[];
    expect(retention).toHaveLength(6);
  });
});

describe('tenant list', () => {
  it('searches names, owner emails and ids, treating wildcards literally', async () => {
    expect((await tenants({ p_search: 'alpha' })).rows.map((r) => r.name)).toEqual(['Alpha Spaza']);
    expect((await tenants({ p_search: 'BETA@example' })).rows.map((r) => r.name)).toEqual(['Beta Store']);
    expect((await tenants({ p_search: shopC })).rows.map((r) => r.name)).toEqual(['Gamma 100% Shop']);
    expect((await tenants({ p_search: '100%' })).rows.map((r) => r.name)).toEqual(['Gamma 100% Shop']);
    expect((await tenants({ p_search: '%' })).total).toBe(1);
    expect((await tenants({ p_search: '_' })).total).toBe(0);
    expect(await errorCode(tenants({ p_search: 'x'.repeat(101) }))).toBe('22023');
  });

  it('filters, sorts and pages', async () => {
    expect((await tenants({ p_status: 'suspended' })).rows.map((r) => r.id)).toEqual([shopB]);
    expect((await tenants({ p_plan: 'pro' })).rows.map((r) => r.id)).toEqual([shopA]);
    expect((await tenants({ p_sort: 'name_asc' })).rows.map((r) => r.id)).toEqual([shopA, shopB, shopC]);
    expect((await tenants()).rows.map((r) => r.id)).toEqual([shopC, shopB, shopA]);
    expect((await tenants({ p_sort: 'created_asc' })).rows.map((r) => r.id)).toEqual([shopA, shopB, shopC]);
    expect((await tenants({ p_sort: 'activity_desc' })).rows[0].id).toBe(shopA);

    const page = await tenants({ p_limit: 1, p_offset: 1 });
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(page.rows.map((r) => r.id)).toEqual([shopB]);
    expect((await tenants({ p_limit: 5000 })).limit).toBe(100);
    expect(await errorCode(tenants({ p_sort: 'random' }))).toBe('22023');
    expect(await errorCode(tenants({ p_status: 'deleted' }))).toBe('22023');
  });

  it('includes owner, members, products and activity', async () => {
    const [row] = (await tenants({ p_search: 'alpha' })).rows as unknown as Record<string, unknown>[];
    expect(row).toMatchObject({
      owner_email: 'alpha@example.com',
      plan: 'pro',
      subscription_status: 'active',
      member_count: 1,
      product_count: 1,
      status: 'active',
    });
    expect(row.last_activity_at).not.toBeNull();
  });

  it('exports with a reason and records the export', async () => {
    expect(await errorCode(call(root, 'admin_export_tenants', { p_search: null, p_status: null, p_plan: null, p_reason: null }))).toBe('22023');
    const exported = await call(root, 'admin_export_tenants', { p_search: null, p_status: 'active', p_plan: null, p_reason: REASON });
    expect(exported).toMatchObject({ ok: true, total: 2, truncated: false });
    const [row] = await auditRows(pg, { action: 'tenant.exported' });
    expect(row).toMatchObject({ actor_id: root.id, reason: REASON, details: { status: 'active', rows: 2, total: 2 } });
    expect(await call(support, 'admin_export_tenants', { p_search: null, p_status: null, p_plan: null, p_reason: REASON })).toEqual({
      ok: false,
      code: 'forbidden',
    });
  });
});

describe('sync failure reports', () => {
  const report = (caller: User | null, reports: unknown, shop = shopA) =>
    rpc<number>(pg, caller, 'report_sync_failures', { p_shop_id: shop, p_reports: reports });

  it('aggregates per user, day, change type and error code', async () => {
    expect(await report(alpha, [{ op_type: 'record_sale', error_code: 'SP001', count: 2 }])).toBe(1);
    expect(await report(alpha, [{ op_type: 'record_sale', error_code: 'SP001', count: 3 }, { op_type: 'stock_in' }])).toBe(2);
    expect(await report(alpha, [{ op_type: 'adjust', error_code: '23514', count: 5000 }])).toBe(1);

    const { rows } = await pg.query<{ op_type: string; error_code: string; occurrences: number }>(
      'select op_type, error_code, occurrences from public.sync_failure_reports order by op_type'
    );
    expect(rows).toEqual([
      { op_type: 'adjust', error_code: '23514', occurrences: 1000 },
      { op_type: 'record_sale', error_code: 'SP001', occurrences: 5 },
      { op_type: 'stock_in', error_code: 'unknown', occurrences: 1 },
    ]);
  });

  it('stores no payloads or messages', async () => {
    const { rows } = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'sync_failure_reports' order by ordinal_position`
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'shop_id', 'user_id', 'day', 'op_type', 'error_code', 'occurrences', 'first_seen', 'last_seen',
    ]);
  });

  it('accepts reports only from members, in a bounded shape', async () => {
    const one = [{ op_type: 'record_sale', error_code: 'SP001' }];
    expect(await errorCode(report(beta, one))).toBe('42501');
    expect(await errorCode(report(null, one))).toBe('42501');
    expect(await errorCode(report(alpha, Array.from({ length: 51 }, () => one[0])))).toBe('22023');
    expect(await errorCode(report(alpha, { op_type: 'record_sale' }))).toBe('22023');
    expect(await errorCode(report(alpha, [{ op_type: 'Record-Sale', error_code: 'SP001' }]))).toBe('22023');
    expect(await errorCode(report(alpha, [{ op_type: 'record_sale', error_code: 'duplicate key value' }]))).toBe('22023');
    expect(await errorCode(report(alpha, [{ error_code: 'SP001' }]))).toBe('22023');
  });

  it('shows up in the overview and operations health', async () => {
    const overview = await call(root, 'admin_platform_overview', recent());
    expect((overview.errors as { sync_failures: number }).sync_failures).toBe(1006);

    const health = await call(support, 'admin_operations_health');
    expect(health.sync).toEqual([
      expect.objectContaining({ op_type: 'adjust', error_code: '23514', occurrences: 1000, shops: 1, users: 1 }),
      expect.objectContaining({ op_type: 'record_sale', error_code: 'SP001', occurrences: 5, shops: 1, users: 1 }),
      expect.objectContaining({ op_type: 'stock_in', error_code: 'unknown', occurrences: 1, shops: 1, users: 1 }),
    ]);
  });
});

describe('operations health', () => {
  it('reports what it cannot see as unavailable and never returns secret values', async () => {
    const health = await call(support, 'admin_operations_health');
    expect(health.scheduler).toEqual({ available: false });
    expect(health.integrations).toEqual({
      push_keys: false,
      push_subject: false,
      scheduler_secret: false,
      project_url: false,
      payment_provider: false,
    });
    expect(health.push).toMatchObject({ due_now: 0, failed_24h: 0, last_sent_at: null });
  });
});
