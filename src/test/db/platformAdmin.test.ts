// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
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
  query,
  REASON,
  rpc,
  type Caller,
  type User,
} from './harness';
import { PLATFORM_ROLE_PERMISSIONS } from '../../admin/permissions';

let pg: PGlite;
let root: User;
let support: User;
let billing: User;
let analyst: User;
let shopper: User;
let unconfirmed: User;
let shop: string;

const FROM = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
const TO = new Date(Date.now() + 3600 * 1000).toISOString();

type Result = { ok: boolean; code?: string; [key: string]: unknown };

/** Every admin function with valid arguments, keyed by the action recorded when it is refused. */
function adminCalls(): [string, string, Record<string, unknown>][] {
  return [
    ['overview.view', 'admin_platform_overview', { p_from: FROM, p_to: TO }],
    ['analytics.series', 'admin_growth_series', { p_metric: 'shops', p_from: FROM, p_to: TO, p_bucket: 'day' }],
    ['analytics.view', 'admin_analytics', { p_from: FROM, p_to: TO }],
    ['tenant.list', 'admin_list_tenants', {}],
    ['tenant.view', 'admin_get_tenant', { p_shop_id: shop }],
    ['tenant.status', 'admin_set_shop_status', { p_shop_id: shop, p_status: 'suspended', p_reason: REASON }],
    ['tenant.create', 'admin_create_shop', { p_owner_email: shopper.email, p_name: 'Second', p_reason: REASON }],
    ['tenant.export', 'admin_export_tenants', { p_search: null, p_status: null, p_plan: null, p_reason: REASON }],
    ['admin.list', 'admin_list_admins', {}],
    ['admin.grant', 'admin_grant_admin', { p_email: shopper.email, p_role: 'superadmin', p_reason: REASON }],
    ['admin.role', 'admin_set_admin_role', { p_user_id: root.id, p_role: 'analyst', p_reason: REASON }],
    ['admin.revoke', 'admin_revoke_admin', { p_user_id: root.id, p_reason: REASON }],
    ['plan.list', 'admin_list_plans', {}],
    [
      'billing.subscription',
      'admin_update_subscription',
      { p_shop_id: shop, p_plan: 'pro', p_status: 'active', p_trial_ends_at: null, p_current_period_end: null, p_reason: REASON },
    ],
    [
      'plan.upsert',
      'admin_upsert_plan',
      {
        p_code: 'free', p_name: 'Free', p_price_cents: 0, p_currency: 'ZAR', p_billing_interval: 'month',
        p_trial_days: 0, p_grace_days: 0, p_is_active: false, p_reason: REASON,
      },
    ],
    ['plan.entitlement', 'admin_set_entitlement', { p_plan: 'free', p_key: 'team.max_members', p_enabled: true, p_limit: 1, p_reason: REASON }],
    ['feature.change', 'admin_set_feature', { p_key: 'expiry_push', p_enabled: false, p_reason: REASON }],
    ['operations.view', 'admin_operations_health', {}],
    ['audit.view', 'admin_list_audit', {}],
    ['catalog.search', 'admin_search_catalog', {}],
    ['catalog.view', 'admin_get_catalog_product', { p_id: shop }],
    [
      'catalog.save',
      'admin_save_catalog_product',
      {
        p_id: null,
        p_name: 'Catalogue item',
        p_brand: null,
        p_category: 'other',
        p_package_size: null,
        p_package_quantity: null,
        p_package_unit: null,
        p_verification_status: 'verified',
        p_reason: REASON,
      },
    ],
    [
      'catalog.barcode',
      'admin_link_catalog_barcode',
      {
        p_catalog_product_id: shop,
        p_barcode: '6001000000001',
        p_kind: 'unit',
        p_units_per_package: null,
        p_reason: REASON,
      },
    ],
    ['catalog.barcode_remove', 'admin_unlink_catalog_barcode', { p_barcode: '6001000000001', p_reason: REASON }],
    ['catalog.image', 'admin_set_catalog_image', { p_id: shop, p_image_path: null, p_reason: REASON }],
  ];
}

function call(caller: Caller, fn: string, args: Record<string, unknown> = {}) {
  return rpc<Result>(pg, caller, fn, args);
}

beforeAll(async () => {
  pg = await createDatabase();
  root = await createUser(pg, 'root@spazastock.test');
  support = await createUser(pg);
  billing = await createUser(pg);
  analyst = await createUser(pg);
  shopper = await createUser(pg, 'thandi@example.com', { displayName: 'Thandi' });
  unconfirmed = await createUser(pg, undefined, { unconfirmed: true });
  shop = await createShop(pg, shopper, 'Thandi Spaza');
  await newProduct(pg, shopper, shop);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('bootstrap', () => {
  it('only accepts an existing account with a confirmed email', async () => {
    expect(await errorCode(pg.query('select private.bootstrap_superadmin($1, $2)', [unconfirmed.email, REASON]))).toBe('22023');
    expect(await errorCode(pg.query('select private.bootstrap_superadmin($1, $2)', ['nobody@example.com', REASON]))).toBe('22023');
    expect(await errorCode(pg.query('select private.bootstrap_superadmin($1, $2)', [root.email, 'short']))).toBe('22023');
  });

  it('cannot be run by signed-in users, anonymous callers or the service role', async () => {
    for (const caller of [shopper, null, 'service'] as Caller[]) {
      const code = await errorCode(query(pg, caller, 'select private.bootstrap_superadmin($1, $2)', [shopper.email, REASON]));
      expect(code).toBe('42501');
    }
    const { rows } = await pg.query('select 1 from private.platform_admins');
    expect(rows).toHaveLength(0);
  });

  it('creates the first superadmin once and records it', async () => {
    await bootstrapSuperadmin(pg, root);
    const [row] = await auditRows(pg, { action: 'admin.bootstrap' });
    expect(row.outcome).toBe('success');
    expect(row.target_id).toBe(root.id);
    expect(row.actor_email).toMatch(/^db:/);

    expect(await errorCode(pg.query('select private.bootstrap_superadmin($1, $2)', [shopper.email, REASON]))).toBe('55000');
    const whoami = await call(root, 'admin_whoami');
    expect(whoami.role).toBe('superadmin');
  });
});

describe('access control', () => {
  beforeAll(async () => {
    await grantAdmin(pg, root, support, 'support');
    await grantAdmin(pg, root, billing, 'billing');
    await grantAdmin(pg, root, analyst, 'analyst');
  });

  it('matches the permission matrix in src/admin/permissions.ts', async () => {
    const { rows } = await pg.query<{ role: string; permission: string }>(
      'select role, permission from private.platform_role_permissions order by role, permission'
    );
    const fromDb = new Map<string, string[]>();
    for (const row of rows) fromDb.set(row.role, [...(fromDb.get(row.role) ?? []), row.permission]);
    expect([...fromDb.keys()].sort()).toEqual(Object.keys(PLATFORM_ROLE_PERMISSIONS).sort());
    for (const [role, permissions] of Object.entries(PLATFORM_ROLE_PERMISSIONS)) {
      expect([...permissions].sort(), role).toEqual((fromDb.get(role) ?? []).sort());
    }
  });

  it('tells each caller their own role and nothing more', async () => {
    const mine = await call(root, 'admin_whoami');
    expect(mine).toMatchObject({ ok: true, role: 'superadmin', email: root.email });
    expect((mine.permissions as string[]).sort()).toEqual([...PLATFORM_ROLE_PERMISSIONS.superadmin].sort());
    expect(await call(support, 'admin_whoami')).toMatchObject({ role: 'support', permissions: ['operations.view', 'tenants.view'] });
    expect(await call(shopper, 'admin_whoami')).toEqual({ ok: true, role: null, email: null, permissions: [] });
  });

  it('refuses every admin function to shop users and records each refusal', async () => {
    for (const [action, fn, args] of adminCalls()) {
      expect(await call(shopper, fn, args), fn).toEqual({ ok: false, code: 'forbidden' });
      const denied = await auditRows(pg, { actor: shopper, action, outcome: 'denied' });
      expect(denied, action).toHaveLength(1);
      expect(denied[0].actor_role).toBeNull();
    }
    const [shopRow] = await query<{ status: string }>(pg, shopper, 'select status from public.shops where id = $1', [shop]);
    expect(shopRow.status).toBe('active');
    expect((await call(root, 'admin_whoami')).role).toBe('superadmin');
  });

  it('refuses anonymous callers before anything runs', async () => {
    for (const [, fn, args] of [['', 'admin_whoami', {}], ...adminCalls()] as [string, string, Record<string, unknown>][]) {
      expect(await errorCode(call(null, fn, args)), fn).toBe('42501');
    }
  });

  it('records a burst of identical refusals once', async () => {
    const before = (await auditRows(pg, { actor: support, action: 'admin.list' })).length;
    for (let i = 0; i < 3; i++) expect((await call(support, 'admin_list_admins')).ok).toBe(false);
    expect((await auditRows(pg, { actor: support, action: 'admin.list' })).length - before).toBe(1);
  });

  it('limits support to viewing tenants and operations', async () => {
    expect((await call(support, 'admin_list_tenants')).ok).toBe(true);
    expect((await call(support, 'admin_get_tenant', { p_shop_id: shop })).ok).toBe(true);
    expect((await call(support, 'admin_operations_health')).ok).toBe(true);
    expect((await call(support, 'admin_platform_overview', { p_from: FROM, p_to: TO })).ok).toBe(true);
    for (const fn of ['admin_set_shop_status', 'admin_export_tenants', 'admin_list_audit', 'admin_analytics', 'admin_list_plans']) {
      const args = adminCalls().find(([, name]) => name === fn)![2];
      expect((await call(support, fn, args)).ok, fn).toBe(false);
    }
  });

  it('limits billing to tenants, plans and subscriptions', async () => {
    expect((await call(billing, 'admin_list_plans')).ok).toBe(true);
    expect((await call(billing, 'admin_get_tenant', { p_shop_id: shop })).ok).toBe(true);
    for (const fn of ['admin_upsert_plan', 'admin_set_feature', 'admin_set_entitlement', 'admin_grant_admin', 'admin_set_shop_status']) {
      const args = adminCalls().find(([, name]) => name === fn)![2];
      expect((await call(billing, fn, args)).ok, fn).toBe(false);
    }
  });

  it('gives analysts aggregates without shop names or emails', async () => {
    const report = await call(analyst, 'admin_analytics', { p_from: FROM, p_to: TO });
    expect(report.ok).toBe(true);
    const text = JSON.stringify(report);
    expect(text).not.toContain('Thandi');
    expect(text).not.toContain('@');
    expect((await call(analyst, 'admin_platform_overview', { p_from: FROM, p_to: TO })).ok).toBe(true);
    for (const fn of ['admin_list_tenants', 'admin_get_tenant', 'admin_export_tenants', 'admin_operations_health']) {
      const args = adminCalls().find(([, name]) => name === fn)![2];
      expect((await call(analyst, fn, args)).ok, fn).toBe(false);
    }
  });

  it('records sensitive tenant access', async () => {
    const before = (await auditRows(pg, { actor: support, action: 'tenant.viewed' })).length;
    await call(support, 'admin_get_tenant', { p_shop_id: shop });
    const rows = await auditRows(pg, { actor: support, action: 'tenant.viewed' });
    expect(rows.length - before).toBe(1);
    expect(rows.at(-1)).toMatchObject({ shop_id: shop, outcome: 'success', actor_role: 'support' });
  });

  it('gives platform roles nothing inside shops', async () => {
    expect(await errorCode(rpc(pg, root, 'list_shop_team', { p_shop_id: shop }))).toBe('42501');
    expect(await errorCode(newProduct(pg, root, shop))).toBe('42501');
    expect(await query(pg, root, 'select id from public.products where shop_id = $1', [shop])).toHaveLength(0);
    expect(await call(root, 'my_shops')).toEqual([]);
  });

  it('keeps platform tables away from every client', async () => {
    const tables = [
      'private.platform_admins',
      'private.platform_role_permissions',
      'private.entitlement_catalog',
      'public.platform_audit_log',
      'public.plan_entitlements',
      'public.platform_features',
      'public.subscription_events',
      'public.sync_failure_reports',
    ];
    for (const caller of [root, shopper, null] as Caller[]) {
      for (const table of tables) {
        expect(await errorCode(query(pg, caller, `select 1 from ${table}`)), table).toBe('42501');
      }
    }
    expect(await query(pg, shopper, 'select code from public.plans order by code')).toEqual([{ code: 'free' }, { code: 'pro' }]);
    expect(await errorCode(query(pg, shopper, 'select suspension_reason from public.shops'))).toBe('42501');
  });
});

describe('administrator management', () => {
  it('requires a reason of 10 to 500 characters', async () => {
    const grant = (reason: string | null) =>
      call(root, 'admin_grant_admin', { p_email: shopper.email, p_role: 'support', p_reason: reason });
    expect(await errorCode(grant(null))).toBe('22023');
    expect(await errorCode(grant('   too short  '))).toBe('22023');
    expect(await errorCode(grant('x'.repeat(501)))).toBe('22023');
  });

  it('grants only to existing accounts with a confirmed email', async () => {
    for (const email of [unconfirmed.email, 'ghost@example.com']) {
      expect(await errorCode(call(root, 'admin_grant_admin', { p_email: email, p_role: 'support', p_reason: REASON }))).toBe('22023');
    }
  });

  it('stops administrators changing or revoking themselves', async () => {
    expect(await errorCode(call(root, 'admin_set_admin_role', { p_user_id: root.id, p_role: 'support', p_reason: REASON }))).toBe('22023');
    expect(await errorCode(call(root, 'admin_revoke_admin', { p_user_id: root.id, p_reason: REASON }))).toBe('22023');
    expect(await errorCode(call(root, 'admin_grant_admin', { p_email: root.email, p_role: 'support', p_reason: REASON }))).toBe('22023');
  });

  it('never leaves the platform without a superadmin', async () => {
    expect(await errorCode(pg.query('select private.assert_not_last_superadmin($1)', [root.id]))).toBe('22023');
    await expect(pg.query('select private.assert_not_last_superadmin($1)', [support.id])).resolves.toBeDefined();
  });

  it('changes roles and lists administrators with an audit trail', async () => {
    const changed = await call(root, 'admin_set_admin_role', { p_user_id: analyst.id, p_role: 'billing', p_reason: REASON });
    expect(changed).toEqual({ ok: true, unchanged: false });
    expect((await call(analyst, 'admin_whoami')).role).toBe('billing');
    const [row] = (await auditRows(pg, { action: 'admin.role_changed' })).slice(-1);
    expect(row.details).toMatchObject({ before: 'analyst', after: 'billing' });
    expect(row.reason).toBe(REASON);

    const list = await call(root, 'admin_list_admins');
    const rows = list.rows as { email: string; role: string; is_you: boolean }[];
    expect(rows.find((r) => r.email === root.email)?.is_you).toBe(true);
    expect(rows.find((r) => r.email === analyst.email)?.role).toBe('billing');
  });

  it('revokes access immediately', async () => {
    expect(await call(root, 'admin_revoke_admin', { p_user_id: analyst.id, p_reason: REASON })).toEqual({ ok: true });
    expect((await call(analyst, 'admin_whoami')).role).toBeNull();
    expect((await call(analyst, 'admin_list_plans')).ok).toBe(false);
    expect(await call(root, 'admin_revoke_admin', { p_user_id: analyst.id, p_reason: REASON })).toEqual({ ok: false, code: 'not_found' });
    const rows = (await call(root, 'admin_list_admins')).rows as { email: string; status: string }[];
    expect(rows.find((r) => r.email === analyst.email)?.status).toBe('revoked');
  });

  it('lets a second superadmin be granted and demoted while one remains', async () => {
    await grantAdmin(pg, root, shopper, 'superadmin');
    expect((await call(shopper, 'admin_set_admin_role', { p_user_id: root.id, p_role: 'support', p_reason: REASON })).ok).toBe(true);
    expect((await call(root, 'admin_whoami')).role).toBe('support');
    expect((await call(shopper, 'admin_set_admin_role', { p_user_id: root.id, p_role: 'superadmin', p_reason: REASON })).ok).toBe(true);
    expect((await call(root, 'admin_revoke_admin', { p_user_id: shopper.id, p_reason: REASON })).ok).toBe(true);
  });
});

describe('audit log', () => {
  it('can never be changed or deleted, even by the database owner', async () => {
    expect(await errorCode(pg.query(`update public.platform_audit_log set reason = 'edited'`))).toBe('42501');
    expect(await errorCode(pg.query('delete from public.platform_audit_log'))).toBe('42501');
    expect(await errorCode(pg.query('truncate public.platform_audit_log'))).toBe('42501');
  });

  it('is readable by superadmins only, with filters and pages', async () => {
    const page = await call(root, 'admin_list_audit', { p_action: 'admin.', p_limit: 2, p_offset: 0 });
    const rows = page.rows as { action: string; occurred_at: string }[];
    expect(rows).toHaveLength(2);
    expect(page.total as number).toBeGreaterThan(2);
    expect(rows.every((r) => r.action.startsWith('admin.'))).toBe(true);
    expect(rows[0].occurred_at >= rows[1].occurred_at).toBe(true);

    const denied = await call(root, 'admin_list_audit', { p_outcome: 'denied', p_actor_email: shopper.email, p_limit: 100 });
    expect((denied.rows as unknown[]).length).toBe(adminCalls().length);

    const scoped = await call(root, 'admin_list_audit', { p_shop_id: shop, p_limit: 100 });
    expect((scoped.rows as { shop_id: string }[]).every((r) => r.shop_id === shop)).toBe(true);

    expect(await errorCode(call(root, 'admin_list_audit', { p_outcome: 'maybe' }))).toBe('22023');
    expect(await errorCode(call(root, 'admin_list_audit', { p_action: "x' or 1=1" }))).toBe('22023');
    expect((await call(root, 'admin_list_audit', { p_limit: 5000 })).limit).toBe(100);
    expect((await call(support, 'admin_list_audit')).ok).toBe(false);
  });

  it('lets an unknown shop id return not_found rather than leak anything', async () => {
    expect(await call(root, 'admin_get_tenant', { p_shop_id: randomUUID() })).toEqual({ ok: false, code: 'not_found' });
  });
});
