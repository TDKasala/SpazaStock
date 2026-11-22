// @vitest-environment node
/**
 * The platform admin functions (worker/d1/admin.ts) must answer like Postgres. D1 is a copy of the
 * Postgres shared tables; each shop's ledger is copied into its own SQLite database (as its
 * Durable Object would hold it) for the figures the admin side adds up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  bootstrapSuperadmin,
  createDatabase,
  createShop,
  createUser,
  grantAdmin,
  newProduct,
  rpc,
  sell,
  stockIn,
  type User,
} from '../db/harness';
import { mirrorD1 } from './d1diff';
import { nodeSql, openShopDatabase } from './nodeSql';
import { TABLES } from '../../../worker/db/columns';
import { DbError } from '../../../worker/db/errors';
import { D1_FUNCTIONS } from '../../../worker/d1/functions';
import type { AdminCtx } from '../../../worker/d1/admin';
import { rangeMetrics, seriesCounts, tenantStats } from '../../../worker/shop/metrics';
import { convertValue, parseExact } from '../../../scripts/migrate-data/lib/transform';

const SHOP_SCHEMA = readFileSync(join(import.meta.dirname, '..', '..', '..', 'worker', 'shop', 'schema.sql'), 'utf8');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;

let pg: PGlite;
let superadmin: User;
let analyst: User;
let owner: User;
let staff: User;
let shopA: string;
let shopB: string;
const known = new Set<string>();

beforeAll(async () => {
  pg = await createDatabase();
  superadmin = await createUser(pg, 'super@example.com');
  analyst = await createUser(pg, 'analyst@example.com');
  owner = await createUser(pg, 'owner@example.com', { displayName: 'Owner' });
  staff = await createUser(pg, 'staff@example.com');
  await bootstrapSuperadmin(pg, superadmin);
  await grantAdmin(pg, superadmin, analyst, 'analyst');
  shopA = await createShop(pg, owner, 'Alpha Spaza');
  shopB = await createShop(pg, owner, 'Beta Tuck Shop');
  await addMember(pg, owner, shopA, staff, 'staff');
  const p = await newProduct(pg, owner, shopA);
  await stockIn(pg, owner, shopA, p.id, 10, { cost: 4.5, expiry: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) });
  await sell(pg, staff, shopA, [{ product_id: p.id, quantity: 4 }]);
  const q = await newProduct(pg, owner, shopB);
  await stockIn(pg, owner, shopB, q.id, 2);
  await pg.query('select private.generate_expiry_alerts(now())');
  for (const u of [superadmin, analyst, owner, staff]) known.add(u.id);
  known.add(shopA);
  known.add(shopB);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

/** Each shop's ledger, copied from Postgres into SQLite like its Durable Object. */
async function shopDatabases() {
  const types: Record<string, Record<string, string>> = {};
  const { rows: cols } = await pg.query<{ t: string; c: string; ty: string }>(
    `select c.relname as t, a.attname as c, format_type(a.atttypid, a.atttypmod) as ty
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'private') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`
  );
  for (const r of cols) (types[r.t] ??= {})[r.c] = r.ty;
  const out = new Map<string, ReturnType<typeof nodeSql>>();
  const { rows: allShops } = await pg.query<{ id: string }>('select id from public.shops');
  for (const { id: shopId } of allShops) {
    const db = openShopDatabase(SHOP_SCHEMA);
    db.exec('PRAGMA foreign_keys = OFF');
    for (const [table, meta] of Object.entries(TABLES)) {
      if (meta.store !== 'shop') continue;
      const schema = table === 'low_stock_episodes' ? 'private' : 'public';
      const { rows } = await pg.query<{ line: string }>(`select to_jsonb(t)::text as line from ${schema}.${table} t where shop_id = $1`, [shopId]);
      for (const r of rows) {
        const raw = parseExact(r.line);
        const row: Record<string, string | number | null> = {};
        for (const [api, column] of meta.columns) row[column] = convertValue(`${schema}.${table}`, api, types[table][api], raw[api] as never);
        const c = Object.keys(row);
        db.prepare(`insert into ${table} (${c.join(', ')}) values (${c.map(() => '?').join(', ')})`).run(...(c.map((k) => row[k]) as never[]));
      }
    }
    out.set(shopId, nodeSql(db));
  }
  return out;
}

function normalise(value: unknown, now: number): unknown {
  if (Array.isArray(value)) return value.map((v) => normalise(v, now));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'created_at' || k === 'updated_at' || k === 'generated_at' || k === 'id' && typeof v === 'number') continue;
      out[k] = normalise(v, now);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (UUID.test(value)) return known.has(value.toLowerCase()) ? value.toLowerCase() : '<new id>';
    if (ISO.test(value)) {
      const ms = Date.parse(value.replace(' ', 'T'));
      return Math.abs(ms - now) < 600_000 ? '<recent>' : new Date(ms).toISOString();
    }
  }
  return value;
}

async function same(user: User, fn: string, args: Record<string, unknown> = {}) {
  const d1 = await mirrorD1(pg);
  const shops = await shopDatabases();
  const now = Date.now();
  const ctx: AdminCtx & { imageExists: (k: string) => Promise<boolean> } = {
    userId: user.id,
    email: user.email,
    now: new Date().toISOString(),
    shops: {
      tenantStats: async (id, at) => tenantStats(shops.get(id)!, at),
      rangeMetrics: async (id, from, to) => rangeMetrics(shops.get(id)!, from, to),
      seriesCounts: async (id, metric, from, to, tz, bucket) => seriesCounts(shops.get(id)!, metric, from, to, tz, bucket),
    },
    integrations: { push_keys: false, push_subject: false },
    imageExists: async () => true,
  };
  let d1Out: unknown;
  try {
    d1Out = { data: JSON.parse(JSON.stringify(await D1_FUNCTIONS[fn](d1, ctx, args))) };
  } catch (err) {
    if (!(err instanceof DbError)) throw err;
    d1Out = { error: { code: err.code, message: err.message } };
  }
  let pgOut: unknown;
  try {
    pgOut = { data: await rpc(pg, user, fn, args) };
  } catch (err) {
    const e = err as { code: string; message: string };
    pgOut = { error: { code: e.code, message: e.message } };
  }
  d1.db.close();
  return { d1: normalise(d1Out, now), pg: normalise(pgOut, now) };
}

async function expectSame(user: User, fn: string, args: Record<string, unknown> = {}, adjust?: (o: { data?: Record<string, unknown> }) => void) {
  const r = await same(user, fn, args);
  if (adjust) {
    adjust(r.d1 as never);
    adjust(r.pg as never);
  }
  expect(r.d1, `${fn} ${JSON.stringify(args)}`).toEqual(r.pg);
  return r;
}

const range = { p_from: new Date(Date.now() - 7 * 86_400_000).toISOString(), p_to: new Date(Date.now() + 86_400_000).toISOString() };
const reason = 'Checking the port against Postgres';

describe('admin: identity, tenants and audit', () => {
  it('answers whoami, tenant lists, exports and tenant detail the same way', async () => {
    await expectSame(superadmin, 'admin_whoami');
    await expectSame(owner, 'admin_whoami');
    for (const extra of [{}, { p_search: 'alpha' }, { p_search: 'OWNER@' }, { p_sort: 'name_asc' }, { p_sort: 'activity_desc' }, { p_status: 'nope' }, { p_sort: 'size' }]) {
      await expectSame(superadmin, 'admin_list_tenants', extra);
    }
    await expectSame(owner, 'admin_list_tenants', {});
    await expectSame(superadmin, 'admin_export_tenants', { p_search: '', p_status: null, p_plan: null, p_reason: reason });
    await expectSame(superadmin, 'admin_export_tenants', { p_search: '', p_status: null, p_plan: null, p_reason: 'short' });
    await expectSame(superadmin, 'admin_get_tenant', { p_shop_id: shopA }, (o) => {
      // Postgres orders history rows that share a timestamp arbitrarily.
      const h = (o.data as { history?: { membership?: { action: string }[] } })?.history;
      h?.membership?.sort((x, y) => x.action.localeCompare(y.action));
    });
    await expectSame(superadmin, 'admin_get_tenant', { p_shop_id: randomUUID() });
    await expectSame(superadmin, 'admin_list_audit', { p_action: 'admin.', p_limit: 10 });
    await expectSame(superadmin, 'admin_list_audit', { p_action: 'Bad Action!' });
  });

  it('manages administrators the same way', async () => {
    await expectSame(superadmin, 'admin_list_admins');
    await expectSame(analyst, 'admin_list_admins');
    await expectSame(superadmin, 'admin_grant_admin', { p_email: 'staff@example.com', p_role: 'support', p_reason: reason });
    await expectSame(superadmin, 'admin_grant_admin', { p_email: 'nobody@example.com', p_role: 'support', p_reason: reason });
    await expectSame(superadmin, 'admin_grant_admin', { p_email: 'analyst@example.com', p_role: 'analyst', p_reason: reason });
    await expectSame(superadmin, 'admin_set_admin_role', { p_user_id: analyst.id, p_role: 'billing', p_reason: reason });
    await expectSame(superadmin, 'admin_set_admin_role', { p_user_id: superadmin.id, p_role: 'billing', p_reason: reason });
    await expectSame(superadmin, 'admin_revoke_admin', { p_user_id: analyst.id, p_reason: reason });
    await expectSame(superadmin, 'admin_revoke_admin', { p_user_id: randomUUID(), p_reason: reason });
  });
});

describe('admin: plans, shops and subscriptions', () => {
  it('lists and changes plans, entitlements and features the same way', async () => {
    await expectSame(superadmin, 'admin_list_plans');
    await expectSame(superadmin, 'admin_upsert_plan', { p_code: ' Pro ', p_name: 'Pro', p_price_cents: 9900, p_currency: 'ZAR', p_billing_interval: 'month', p_trial_days: 14, p_grace_days: 7, p_is_active: true, p_reason: reason });
    await expectSame(superadmin, 'admin_upsert_plan', { p_code: 'free', p_name: 'Free', p_price_cents: 0, p_currency: 'ZAR', p_billing_interval: 'month', p_trial_days: 0, p_grace_days: 0, p_is_active: false, p_reason: reason });
    await expectSame(superadmin, 'admin_upsert_plan', { p_code: 'x', p_name: 'X', p_price_cents: 1, p_currency: 'zar', p_billing_interval: 'month', p_trial_days: 0, p_grace_days: 0, p_is_active: true, p_reason: reason });
    await expectSame(superadmin, 'admin_set_entitlement', { p_plan: 'free', p_key: 'team.max_members', p_enabled: true, p_limit: 3, p_reason: reason });
    await expectSame(superadmin, 'admin_set_entitlement', { p_plan: 'free', p_key: 'expiry_push', p_enabled: true, p_limit: 3, p_reason: reason });
    await expectSame(superadmin, 'admin_set_feature', { p_key: 'expiry_push', p_enabled: false, p_reason: reason });
    await expectSame(superadmin, 'admin_set_feature', { p_key: 'team.max_members', p_enabled: false, p_reason: reason });
  });

  it('creates shops, suspends them and updates subscriptions the same way', async () => {
    await expectSame(superadmin, 'admin_create_shop', { p_owner_email: 'owner@example.com', p_name: 'Gamma', p_reason: reason, p_phone: '0821234567' });
    await expectSame(superadmin, 'admin_create_shop', { p_owner_email: 'ghost@example.com', p_name: 'Gamma', p_reason: reason });
    await expectSame(superadmin, 'admin_set_shop_status', { p_shop_id: shopB, p_status: 'suspended', p_reason: reason });
    await expectSame(superadmin, 'admin_set_shop_status', { p_shop_id: shopB, p_status: 'paused', p_reason: reason });
    await expectSame(superadmin, 'admin_update_subscription', { p_shop_id: shopA, p_plan: 'free', p_status: 'past_due', p_trial_ends_at: null, p_current_period_end: null, p_reason: reason });
    await expectSame(superadmin, 'admin_update_subscription', { p_shop_id: shopA, p_plan: 'free', p_status: 'past_due', p_trial_ends_at: null, p_current_period_end: '2026-12-31T00:00:00Z', p_reason: reason });
    await expectSame(superadmin, 'admin_update_subscription', { p_shop_id: shopA, p_plan: 'gold', p_status: 'active', p_trial_ends_at: null, p_current_period_end: null, p_reason: reason });
  });
});

describe('admin: reports', () => {
  it('reports the platform overview, analytics, growth and operations the same way', async () => {
    await expectSame(superadmin, 'admin_platform_overview', range, (o) => {
      // pg_cron's run history has no Cloudflare counterpart.
      const e = (o.data as { errors?: Record<string, unknown> })?.errors;
      if (e) delete e.cron_failures;
    });
    await expectSame(superadmin, 'admin_platform_overview', { p_from: range.p_to, p_to: range.p_from });
    await expectSame(superadmin, 'admin_analytics', range);
    for (const metric of ['shops', 'users', 'stock_movements', 'sales', 'expiry_alerts', 'active_shops']) {
      await expectSame(superadmin, 'admin_growth_series', { p_metric: metric, ...range, p_bucket: 'day' });
    }
    await expectSame(superadmin, 'admin_growth_series', { p_metric: 'sales', ...range, p_bucket: 'week' });
    await expectSame(superadmin, 'admin_growth_series', { p_metric: 'shops', p_from: '2026-01-15T00:00:00Z', p_to: '2026-12-15T00:00:00Z', p_bucket: 'month' });
    await expectSame(superadmin, 'admin_growth_series', { p_metric: 'revenue', ...range, p_bucket: 'day' });
    await expectSame(superadmin, 'admin_operations_health', {}, (o) => {
      const d = o.data as Record<string, unknown> | undefined;
      if (d) {
        delete d.scheduler; // pg_cron vs Cron Triggers
        delete d.integrations; // Vault vs Worker secrets
      }
    });
  });
});

describe('admin: catalogue editor', () => {
  it('searches, edits and links catalogue products the same way', async () => {
    const created = await same(superadmin, 'admin_save_catalog_product', { p_id: null, p_name: 'Maize Meal', p_brand: 'White Star', p_category: 'groceries', p_package_size: '5kg', p_package_quantity: 5, p_package_unit: 'kg', p_verification_status: 'verified', p_reason: reason });
    expect(created.d1).toEqual(created.pg);
    const { rows } = await pg.query<{ id: string }>(`select id from public.catalog_products where name = 'Maize Meal'`);
    const id = rows[0].id;
    known.add(id);
    await expectSame(superadmin, 'admin_search_catalog', { p_query: 'maize' });
    await expectSame(superadmin, 'admin_get_catalog_product', { p_id: id });
    await expectSame(superadmin, 'admin_save_catalog_product', { p_id: id, p_name: 'Maize Meal Super', p_brand: null, p_category: 'groceries', p_package_size: null, p_package_quantity: null, p_package_unit: null, p_verification_status: 'verified', p_reason: reason });
    await expectSame(superadmin, 'admin_save_catalog_product', { p_id: id, p_name: '', p_brand: null, p_category: 'groceries', p_package_size: null, p_package_quantity: null, p_package_unit: null, p_verification_status: 'verified', p_reason: reason });
    await pg.query(`insert into public.catalog_barcodes (barcode, catalog_product_id, kind, source) values ('6001111111111', $1, 'unit', 'user')`, [id]);
    await expectSame(superadmin, 'admin_link_catalog_barcode', { p_catalog_product_id: id, p_barcode: '6001111111111', p_kind: 'unit', p_units_per_package: null, p_reason: reason });
    await expectSame(superadmin, 'admin_link_catalog_barcode', { p_catalog_product_id: id, p_barcode: '6001111111112', p_kind: 'pack', p_units_per_package: 12, p_reason: reason });
    await expectSame(superadmin, 'admin_link_catalog_barcode', { p_catalog_product_id: id, p_barcode: '6001111111113', p_kind: 'pack', p_units_per_package: 1, p_reason: reason });
    await expectSame(superadmin, 'admin_unlink_catalog_barcode', { p_barcode: '6001111111111', p_reason: reason });
    await expectSame(superadmin, 'admin_unlink_catalog_barcode', { p_barcode: '0000', p_reason: reason });
    await expectSame(superadmin, 'admin_set_catalog_common', { p_id: id, p_common: true, p_reason: reason });
    await expectSame(superadmin, 'admin_set_catalog_image', { p_id: id, p_image_path: `catalog/${randomUUID()}.webp`, p_reason: reason });
    await expectSame(owner, 'admin_search_catalog', { p_query: '' });
  });
});
