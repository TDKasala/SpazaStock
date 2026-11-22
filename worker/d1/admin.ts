/**
 * Platform administration (/admin), ported from the admin_* Postgres functions. Every call checks
 * the caller's platform role, refusals are audited (at most once per 10 seconds per action), and
 * every change writes platform_audit_log in the same batch. Shop-ledger figures come from each
 * shop's Durable Object (ctx.shops) and are added up here.
 */
import { all, batch, first, run, type D1Like } from '../db/d1';
import { invalid } from '../db/errors';
import type { SqlValue } from '../db/sql';
import type { RangeMetrics, TenantStats } from '../shop/metrics';
import { newShopStatements, shopContact, shopLocation } from './team';
import {
  effectivePlan,
  entitlementLimit,
  hasPlatformPermission,
  platformRole,
  shopEntitlements,
  userEmail,
  uuidArg,
  type D1Ctx,
  type Stmt,
} from './common';

type Args = Record<string, unknown>;
type Row = Record<string, unknown>;

export interface AdminShops {
  tenantStats(shopId: string, now: string): Promise<TenantStats>;
  rangeMetrics(shopId: string, from: string, to: string): Promise<RangeMetrics>;
  seriesCounts(shopId: string, metric: string, from: string, to: string, timeZone: string, bucket: 'day' | 'week' | 'month'): Promise<Record<string, number>>;
}

export type AdminCtx = D1Ctx & { shops: AdminShops; integrations?: Record<string, boolean> };

const PLATFORM_TZ = 'Africa/Johannesburg';
const ROLES = ['superadmin', 'support', 'billing', 'analyst'];

/** private.audit, as a statement for the caller's batch. */
export async function auditStmt(
  db: D1Like,
  ctx: D1Ctx,
  action: string,
  outcome: 'success' | 'denied',
  targetType: string | null = null,
  targetId: string | null = null,
  shopId: string | null = null,
  reason: string | null = null,
  details: Row = {}
): Promise<Stmt> {
  return [
    `INSERT INTO platform_audit_log (occurred_at, actor_id, actor_email, actor_role, action, target_type, target_id, shop_id, reason, outcome, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.now,
    ctx.userId,
    (await userEmail(db, ctx.userId)) ?? (ctx.userId ? null : 'db:worker'),
    await platformRole(db, ctx.userId),
    action,
    targetType,
    targetId,
    shopId,
    reason?.trim() || null,
    outcome,
    JSON.stringify(details),
  ];
}

/** private.platform_denied: answer { ok: false, code: 'forbidden' } and audit it (deduplicated). */
async function denied(db: D1Like, ctx: D1Ctx, action: string, targetType: string | null = null, targetId: string | null = null, shopId: string | null = null) {
  const since = new Date(Date.parse(ctx.now) - 10_000).toISOString();
  const recent = await first(
    db,
    `SELECT 1 AS x FROM platform_audit_log WHERE actor_id IS ? AND action = ? AND outcome = 'denied' AND occurred_at > ?`,
    ctx.userId,
    action,
    since
  );
  if (!recent) await batch(db, [await auditStmt(db, ctx, action, 'denied', targetType, targetId, shopId)]);
  return { ok: false, code: 'forbidden' };
}

/** private.require_reason */
function requireReason(reason: unknown): string {
  const r = String(reason ?? '').trim();
  if ([...r].length < 10 || [...r].length > 500) throw invalid('A reason of 10 to 500 characters is required.');
  return r;
}

/** private.check_range */
function checkRange(fromIn: unknown, toIn: unknown): { from: string; to: string } {
  const from = fromIn == null ? NaN : Date.parse(String(fromIn));
  const to = toIn == null ? NaN : Date.parse(String(toIn));
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw invalid('Choose a start date before the end date.');
  if (to - from > 366 * 86_400_000) throw invalid('Date ranges are limited to 366 days.');
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

const pageLimit = (v: unknown) => Math.min(Math.max(v == null ? 25 : Number(v), 1), 100);
const pageOffset = (v: unknown) => Math.min(Math.max(v == null ? 0 : Number(v), 0), 1_000_000);

/** public.admin_whoami */
export async function adminWhoami(db: D1Like, ctx: AdminCtx): Promise<Row> {
  const role = await platformRole(db, ctx.userId);
  const permissions = role
    ? (await all<{ permission: string }>(db, 'SELECT permission FROM platform_role_permissions WHERE role = ? ORDER BY permission', role)).map((r) => r.permission)
    : [];
  return { ok: true, role, email: role ? await userEmail(db, ctx.userId) : null, permissions };
}

interface TenantRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  owner_id: string;
  owner_email: string | null;
  owner_name: string | null;
  plan: string | null;
  subscription_status: string | null;
  member_count: number;
  product_count: number;
  last_activity_at: string | null;
}

/** private.tenant_search: shops by name, owner email or id; product counts and activity from each shop. */
async function tenantSearch(db: D1Like, ctx: AdminCtx, search: unknown, status: unknown, plan: unknown): Promise<TenantRow[]> {
  const term = String(search ?? '').trim();
  if ([...term].length > 100) throw invalid('Search text is limited to 100 characters.');
  if (status != null && status !== 'active' && status !== 'suspended') throw invalid('Unknown shop status.');
  const pattern = `%${term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term) ? term.toLowerCase() : null;
  const rows = await all<Omit<TenantRow, 'product_count' | 'last_activity_at'>>(
    db,
    `SELECT s.id, s.name, s.status, s.created_at, s.owner_id, lower(u.email) AS owner_email, p.display_name AS owner_name,
            sub.plan, sub.status AS subscription_status,
            (SELECT count(*) FROM shop_members m WHERE m.shop_id = s.id AND m.user_id IS NOT NULL AND m.status = 'active') AS member_count
       FROM shops s
       LEFT JOIN users u ON u.id = s.owner_id
       LEFT JOIN profiles p ON p.id = s.owner_id
       LEFT JOIN subscriptions sub ON sub.shop_id = s.id
      WHERE (? = '' OR s.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR s.id = ?)
        AND (? IS NULL OR s.status = ?)
        AND (? IS NULL OR sub.plan = ?)`,
    term,
    pattern,
    pattern,
    id,
    (status as string) ?? null,
    (status as string) ?? null,
    (plan as string) ?? null,
    (plan as string) ?? null
  );
  return Promise.all(
    rows.map(async (r) => {
      const stats = await ctx.shops.tenantStats(r.id, ctx.now);
      return { ...r, member_count: Number(r.member_count), product_count: stats.active_products, last_activity_at: stats.last_movement_at };
    })
  );
}

const byCreated = (dir: 1 | -1) => (a: TenantRow, b: TenantRow) => (a.created_at < b.created_at ? -dir : a.created_at > b.created_at ? dir : 0) || (a.id < b.id ? -1 : 1);

/** public.admin_list_tenants */
export async function adminListTenants(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'tenants.view'))) return denied(db, ctx, 'tenant.list');
  const sort = (a.p_sort as string) ?? 'created_desc';
  const limit = pageLimit(a.p_limit);
  const offset = pageOffset(a.p_offset);
  if (!['created_desc', 'created_asc', 'name_asc', 'activity_desc'].includes(sort)) throw invalid('Unknown sort order.');
  const rows = await tenantSearch(db, ctx, a.p_search, a.p_status, a.p_plan);
  rows.sort(
    sort === 'name_asc'
      ? (x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()) || (x.id < y.id ? -1 : 1)
      : sort === 'created_asc'
        ? byCreated(1)
        : sort === 'created_desc'
          ? (x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0) || (x.id < y.id ? -1 : 1)
          : (x, y) =>
              (x.last_activity_at === null ? 1 : 0) - (y.last_activity_at === null ? 1 : 0) ||
              (x.last_activity_at! < y.last_activity_at! ? 1 : x.last_activity_at! > y.last_activity_at! ? -1 : 0) ||
              (x.id < y.id ? -1 : 1)
  );
  return { ok: true, total: rows.length, limit, offset, rows: rows.slice(offset, offset + limit).map((r, i) => ({ ...r, ord: offset + i + 1 })) };
}

/** public.admin_export_tenants: up to 5,000 rows, with a recorded reason. */
export async function adminExportTenants(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'tenants.export'))) return denied(db, ctx, 'tenant.export');
  const reason = requireReason(a.p_reason);
  const rows = (await tenantSearch(db, ctx, a.p_search, a.p_status, a.p_plan)).sort(
    (x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0) || (x.id < y.id ? -1 : 1)
  );
  await batch(db, [
    await auditStmt(db, ctx, 'tenant.exported', 'success', 'platform', null, null, reason, {
      search: a.p_search ?? null,
      status: a.p_status ?? null,
      plan: a.p_plan ?? null,
      rows: Math.min(rows.length, 5000),
      total: rows.length,
    }),
  ]);
  return { ok: true, total: rows.length, truncated: rows.length > 5000, rows: rows.slice(0, 5000) };
}

/** private.team_size */
async function teamSize(db: D1Like, shopId: string, now: string): Promise<number> {
  const r = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM shop_members WHERE shop_id = ?
        AND ((user_id IS NOT NULL AND status = 'active') OR (user_id IS NULL AND invite_expires_at > ?))`,
    shopId,
    now
  );
  return Number(r?.n ?? 0);
}

/** public.admin_get_tenant: everything about one shop, viewing it is audited. */
export async function adminGetTenant(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const shopId = uuidArg(a.p_shop_id);
  if (!(await hasPlatformPermission(db, ctx.userId, 'tenants.view'))) return denied(db, ctx, 'tenant.view', 'shop', shopId, shopId);
  const shop = shopId ? await first<Row>(db, 'SELECT * FROM shops WHERE id = ?', shopId) : null;
  if (!shop) return { ok: false, code: 'not_found' };
  const now = Date.parse(ctx.now);
  const stats = await ctx.shops.tenantStats(shopId!, ctx.now);
  const owner = await first<Row>(
    db,
    `SELECT u.id, lower(u.email) AS email, p.display_name, u.created_at, u.last_sign_in_at, u.email_confirmed_at IS NOT NULL AS email_confirmed
       FROM users u LEFT JOIN profiles p ON p.id = u.id WHERE u.id = ?`,
    shop.owner_id as string
  );
  const members = await all<Row>(
    db,
    `SELECT m.id AS member_id, m.user_id, coalesce(lower(u.email), m.invited_email) AS email, p.display_name, m.role, m.status,
            m.invite_expires_at, m.joined_at, u.last_sign_in_at, m.created_at
       FROM shop_members m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN profiles p ON p.id = m.user_id
      WHERE m.shop_id = ?`,
    shopId
  );
  members.sort(
    (x, y) =>
      Number(x.user_id === null) - Number(y.user_id === null) ||
      Number(x.role !== 'owner') - Number(y.role !== 'owner') ||
      (String(x.created_at) < String(y.created_at) ? -1 : 1)
  );
  const sub = await first<Row>(
    db,
    'SELECT plan, status, trial_ends_at, current_period_end, provider, created_at, updated_at FROM subscriptions WHERE shop_id = ?',
    shopId
  );
  const syncFailures = await first<{ n: number }>(
    db,
    'SELECT coalesce(sum(occurrences), 0) AS n FROM sync_failure_reports WHERE shop_id = ? AND last_seen > ?',
    shopId,
    new Date(now - 7 * 86_400_000).toISOString()
  );
  const emailOf = async (id: unknown) => userEmail(db, (id as string) ?? null);
  const membership = await all<Row>(db, 'SELECT * FROM membership_events WHERE shop_id = ? ORDER BY created_at DESC LIMIT 50', shopId);
  const subEvents = await all<Row>(db, 'SELECT * FROM subscription_events WHERE shop_id = ? ORDER BY occurred_at DESC LIMIT 50', shopId);
  const adminEvents = await all<Row>(
    db,
    'SELECT occurred_at, action, actor_email, reason, outcome FROM platform_audit_log WHERE shop_id = ? ORDER BY occurred_at DESC LIMIT 50',
    shopId
  );
  const result = {
    ok: true,
    shop: {
      id: shop.id,
      name: shop.name,
      status: shop.status,
      suspended_at: shop.suspended_at,
      suspension_reason: shop.suspension_reason,
      suspended_by_email: await emailOf(shop.suspended_by),
      timezone: shop.timezone,
      expiry_reminder_days: JSON.parse(String(shop.expiry_reminder_days)),
      created_at: shop.created_at,
      phone: shop.phone,
      address: shop.address,
      city: shop.city,
      province: shop.province,
      latitude: shop.latitude,
      longitude: shop.longitude,
    },
    owner: owner ? { ...owner, email_confirmed: owner.email_confirmed === 1 } : null,
    members: members.map((m) => ({
      member_id: m.member_id,
      user_id: m.user_id,
      email: m.email,
      display_name: m.display_name,
      role: m.role,
      status: m.user_id !== null ? m.status : m.invite_expires_at && Date.parse(String(m.invite_expires_at)) > now ? 'invited' : 'expired',
      joined_at: m.joined_at,
      last_sign_in_at: m.last_sign_in_at,
    })),
    outlets: await all(
      db,
      'SELECT id, name, status, created_at FROM shops WHERE owner_id = ? AND id <> ? ORDER BY created_at',
      shop.owner_id as string,
      shopId
    ),
    inventory: {
      products: stats.products,
      active_products: stats.active_products,
      archived_products: stats.archived_products,
      batches_in_stock: stats.batches_in_stock,
      units_in_stock: stats.units_in_stock,
      stock_value_at_cost: stats.stock_value_at_cost_cents / 100,
      batches_without_cost: stats.batches_without_cost,
    },
    activity: {
      last_movement_at: stats.last_movement_at,
      movements_30d: stats.movements_30d,
      sales_30d: stats.sales_30d,
      open_expiry_alerts: stats.open_expiry_alerts,
      sync_failures_7d: Number(syncFailures?.n ?? 0),
    },
    subscription: sub,
    entitlements: await shopEntitlements(db, shopId!, ctx.now),
    usage: { team_members: await teamSize(db, shopId!, ctx.now), team_limit: await entitlementLimit(db, shopId!, 'team.max_members', ctx.now) },
    history: {
      membership: await Promise.all(
        membership.map(async (e) => ({
          occurred_at: e.created_at,
          action: e.action,
          target_email: e.target_email,
          actor_email: await emailOf(e.actor_id),
          old_role: e.old_role,
          new_role: e.new_role,
        }))
      ),
      subscription: await Promise.all(
        subEvents.map(async (e) => ({
          occurred_at: e.occurred_at,
          event: e.event,
          actor_email: await emailOf(e.actor_id),
          old_plan: e.old_plan,
          new_plan: e.new_plan,
          old_status: e.old_status,
          new_status: e.new_status,
        }))
      ),
      admin: adminEvents,
    },
  };
  await batch(db, [await auditStmt(db, ctx, 'tenant.viewed', 'success', 'shop', shopId, shopId)]);
  return result;
}

/** private.find_confirmed_user */
async function findConfirmedUser(db: D1Like, email: unknown): Promise<string> {
  const e = String(email ?? '').trim().toLowerCase();
  const u = await first<{ id: string }>(db, 'SELECT id FROM users WHERE lower(email) = ? AND email_confirmed_at IS NOT NULL', e);
  if (!u) throw invalid(`No account with a confirmed email address matches ${e}.`);
  return u.id;
}

/** private.assert_not_last_superadmin */
async function assertNotLastSuperadmin(db: D1Like, userId: string): Promise<void> {
  const isSuper = await first(db, `SELECT 1 AS x FROM platform_admins WHERE user_id = ? AND role = 'superadmin' AND status = 'active'`, userId);
  const others = await first(db, `SELECT 1 AS x FROM platform_admins WHERE role = 'superadmin' AND status = 'active' AND user_id <> ?`, userId);
  if (isSuper && !others) throw invalid('The last superadmin cannot be removed or demoted.');
}

/** public.admin_grant_admin */
export async function adminGrantAdmin(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'admins.manage'))) return denied(db, ctx, 'admin.grant', 'admin');
  const reason = requireReason(a.p_reason);
  const role = a.p_role as string;
  if (!ROLES.includes(role)) throw invalid('Unknown administrator role.');
  const user = await findConfirmedUser(db, a.p_email);
  if (user === ctx.userId) throw invalid('You cannot change your own role.');
  const existing = await first<{ role: string; status: string }>(db, 'SELECT role, status FROM platform_admins WHERE user_id = ?', user);
  if (existing?.status === 'active' && existing.role === role) return { ok: true, unchanged: true, user_id: user };
  if (existing?.status === 'active' && role !== 'superadmin') await assertNotLastSuperadmin(db, user);
  await batch(db, [
    [
      `INSERT INTO platform_admins (user_id, role, status, granted_by, granted_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET role = excluded.role, status = 'active', granted_by = excluded.granted_by,
         granted_at = excluded.granted_at, revoked_by = NULL, revoked_at = NULL`,
      user,
      role,
      ctx.userId,
      ctx.now,
      ctx.now,
    ],
    await auditStmt(db, ctx, 'admin.granted', 'success', 'admin', user, null, reason, {
      email: await userEmail(db, user),
      role,
      previous_role: existing?.role ?? null,
      previous_status: existing?.status ?? null,
    }),
  ]);
  return { ok: true, unchanged: false, user_id: user };
}

/** public.admin_revoke_admin */
export async function adminRevokeAdmin(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const userId = uuidArg(a.p_user_id);
  if (!(await hasPlatformPermission(db, ctx.userId, 'admins.manage'))) return denied(db, ctx, 'admin.revoke', 'admin', userId);
  const reason = requireReason(a.p_reason);
  if (userId === ctx.userId) throw invalid('You cannot revoke your own access.');
  const existing = userId ? await first<{ role: string }>(db, `SELECT role FROM platform_admins WHERE user_id = ? AND status = 'active'`, userId) : null;
  if (!existing) return { ok: false, code: 'not_found' };
  await assertNotLastSuperadmin(db, userId!);
  await batch(db, [
    [`UPDATE platform_admins SET status = 'revoked', revoked_by = ?, revoked_at = ? WHERE user_id = ?`, ctx.userId, ctx.now, userId],
    await auditStmt(db, ctx, 'admin.revoked', 'success', 'admin', userId, null, reason, { email: await userEmail(db, userId), role: existing.role }),
  ]);
  return { ok: true };
}

/** public.admin_set_admin_role */
export async function adminSetAdminRole(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const userId = uuidArg(a.p_user_id);
  if (!(await hasPlatformPermission(db, ctx.userId, 'admins.manage'))) return denied(db, ctx, 'admin.role', 'admin', userId);
  const reason = requireReason(a.p_reason);
  const role = a.p_role as string;
  if (!ROLES.includes(role)) throw invalid('Unknown administrator role.');
  if (userId === ctx.userId) throw invalid('You cannot change your own role.');
  const existing = userId ? await first<{ role: string }>(db, `SELECT role FROM platform_admins WHERE user_id = ? AND status = 'active'`, userId) : null;
  if (!existing) return { ok: false, code: 'not_found' };
  if (existing.role === role) return { ok: true, unchanged: true };
  if (role !== 'superadmin') await assertNotLastSuperadmin(db, userId!);
  await batch(db, [
    ['UPDATE platform_admins SET role = ? WHERE user_id = ?', role, userId],
    await auditStmt(db, ctx, 'admin.role_changed', 'success', 'admin', userId, null, reason, { email: await userEmail(db, userId), before: existing.role, after: role }),
  ]);
  return { ok: true, unchanged: false };
}

/** public.admin_list_admins */
export async function adminListAdmins(db: D1Like, ctx: AdminCtx): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'admins.manage'))) return denied(db, ctx, 'admin.list');
  const rows = await all<Row>(
    db,
    `SELECT a.user_id, lower(u.email) AS email, p.display_name, a.role, a.status, a.granted_at, a.granted_by, a.revoked_at, a.revoked_by,
            u.last_sign_in_at
       FROM platform_admins a JOIN users u ON u.id = a.user_id LEFT JOIN profiles p ON p.id = a.user_id
      ORDER BY a.status, a.role, lower(u.email)`
  );
  return {
    ok: true,
    rows: await Promise.all(
      rows.map(async (r) => ({
        user_id: r.user_id,
        email: r.email,
        display_name: r.display_name,
        role: r.role,
        status: r.status,
        granted_at: r.granted_at,
        granted_by_email: await userEmail(db, r.granted_by as string | null),
        revoked_at: r.revoked_at,
        revoked_by_email: await userEmail(db, r.revoked_by as string | null),
        last_sign_in_at: r.last_sign_in_at,
        is_you: r.user_id === ctx.userId,
      }))
    ),
  };
}

/** public.admin_list_audit */
export async function adminListAudit(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'audit.view'))) return denied(db, ctx, 'audit.view');
  const action = String(a.p_action ?? '').trim().toLowerCase() || null;
  const actor = String(a.p_actor_email ?? '').trim().toLowerCase() || null;
  const limit = pageLimit(a.p_limit);
  const offset = pageOffset(a.p_offset);
  if (action !== null && !/^[a-z._]{1,60}$/.test(action)) throw invalid('Unknown action filter.');
  if (actor !== null && [...actor].length > 320) throw invalid('Email filter is too long.');
  if (a.p_outcome != null && a.p_outcome !== 'success' && a.p_outcome !== 'denied') throw invalid('Outcome must be success or denied.');
  const from = a.p_from == null ? null : new Date(String(a.p_from)).toISOString();
  const to = a.p_to == null ? null : new Date(String(a.p_to)).toISOString();
  if (from !== null && to !== null && from >= to) throw invalid('Choose a start date before the end date.');
  const shopId = uuidArg(a.p_shop_id);
  const where = `WHERE (? IS NULL OR action LIKE ? || '%') AND (? IS NULL OR actor_email = ?) AND (? IS NULL OR shop_id = ?)
                   AND (? IS NULL OR outcome = ?) AND (? IS NULL OR occurred_at >= ?) AND (? IS NULL OR occurred_at < ?)`;
  const params: SqlValue[] = [action, action, actor, actor, shopId, shopId, (a.p_outcome as string) ?? null, (a.p_outcome as string) ?? null, from, from, to, to];
  const total = Number((await first<{ n: number }>(db, `SELECT count(*) AS n FROM platform_audit_log ${where}`, ...params))?.n ?? 0);
  const rows = await all<Row>(
    db,
    `SELECT id, occurred_at, actor_id, actor_email, actor_role, action, target_type, target_id, shop_id, reason, outcome, details
       FROM platform_audit_log ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  );
  return { ok: true, total, limit, offset, rows: rows.map((r) => ({ ...r, details: JSON.parse(String(r.details)) })) };
}

/** public.admin_list_plans */
export async function adminListPlans(db: D1Like, ctx: AdminCtx): Promise<Row> {
  if (!((await hasPlatformPermission(db, ctx.userId, 'billing.view')) || (await hasPlatformPermission(db, ctx.userId, 'plans.manage')))) {
    return denied(db, ctx, 'plan.list');
  }
  const plans = await all<Row>(db, 'SELECT * FROM plans ORDER BY price_cents IS NULL, price_cents, code');
  return {
    ok: true,
    plans: await Promise.all(
      plans.map(async (p) => {
        const ent = await all<{ key: string; enabled: number; limit_value: number | null }>(db, 'SELECT key, enabled, limit_value FROM plan_entitlements WHERE plan_code = ?', String(p.code));
        return {
          ...p,
          is_active: p.is_active === 1,
          subscriptions: Number((await first<{ n: number }>(db, 'SELECT count(*) AS n FROM subscriptions WHERE plan = ?', String(p.code)))?.n ?? 0),
          entitlements: Object.fromEntries(ent.map((e) => [e.key, { enabled: e.enabled === 1, limit: e.limit_value }])),
        };
      })
    ),
    catalog: await all(db, 'SELECT key, kind, description FROM entitlement_catalog ORDER BY key'),
    features: await Promise.all(
      (await all<Row>(db, 'SELECT key, enabled, updated_at, updated_by FROM platform_features ORDER BY key')).map(async (f) => ({
        key: f.key,
        enabled: f.enabled === 1,
        updated_at: f.updated_at,
        updated_by_email: await userEmail(db, f.updated_by as string | null),
      }))
    ),
    payments: { provider_connected: false },
  };
}


/** public.admin_create_shop: a shop for a confirmed user, created by support. */
export async function adminCreateShop(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'tenants.manage'))) return denied(db, ctx, 'tenant.create');
  const reason = requireReason(a.p_reason);
  const name = String(a.p_name ?? '').trim();
  if ([...name].length < 1 || [...name].length > 120) throw invalid('Shop name is required (up to 120 characters).');
  const contact = shopContact(a.p_phone, a.p_address, a.p_city, a.p_province);
  const location = shopLocation(a.p_latitude, a.p_longitude);
  const owner = await findConfirmedUser(db, a.p_owner_email);
  const { shopId, stmts } = await newShopStatements(db, ctx, owner, name, contact, location);
  stmts.push(await auditStmt(db, ctx, 'tenant.created', 'success', 'shop', shopId, shopId, reason, { name, owner_email: await userEmail(db, owner) }));
  await batch(db, stmts);
  return { ok: true, shop_id: shopId };
}

/** public.admin_set_shop_status: suspend or reactivate; owners and managers are told. */
export async function adminSetShopStatus(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const shopId = uuidArg(a.p_shop_id);
  if (!(await hasPlatformPermission(db, ctx.userId, 'tenants.manage'))) return denied(db, ctx, 'tenant.status', 'shop', shopId, shopId);
  const reason = requireReason(a.p_reason);
  const status = a.p_status;
  if (status !== 'active' && status !== 'suspended') throw invalid('Status must be active or suspended.');
  const shop = shopId ? await first<{ status: string; name: string }>(db, 'SELECT status, name FROM shops WHERE id = ?', shopId) : null;
  if (!shop) return { ok: false, code: 'not_found' };
  if (shop.status === status) return { ok: true, unchanged: true, status };
  const suspended = status === 'suspended';
  const members = await all<{ user_id: string }>(
    db,
    `SELECT user_id FROM shop_members WHERE shop_id = ? AND user_id IS NOT NULL AND status = 'active' AND role IN ('owner', 'manager')`,
    shopId
  );
  await batch(db, [
    [
      'UPDATE shops SET status = ?, suspended_at = ?, suspended_by = ?, suspension_reason = ? WHERE id = ?',
      status,
      suspended ? ctx.now : null,
      suspended ? ctx.userId : null,
      suspended ? reason : null,
      shopId,
    ],
    await auditStmt(db, ctx, suspended ? 'tenant.suspended' : 'tenant.reactivated', 'success', 'shop', shopId, shopId, reason, {
      before: shop.status,
      after: status,
      shop_name: shop.name,
    }),
    ...members.map(
      (m): Stmt => [
        `INSERT INTO notifications (id, shop_id, user_id, type, title, body, data, created_at, updated_at) VALUES (?, ?, ?, 'system', ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        shopId,
        m.user_id,
        suspended ? 'Shop suspended' : 'Shop reactivated',
        suspended
          ? `${shop.name} is suspended. Sign-in is refused until it is reactivated. Contact SpazaStock support.`
          : `${shop.name} is active again. Waiting changes will now sync.`,
        JSON.stringify({ kind: 'shop_status', status }),
        ctx.now,
        ctx.now,
      ]
    ),
  ]);
  return { ok: true, unchanged: false, status };
}

/** public.admin_update_subscription (history row as log_subscription_event wrote it). */
export async function adminUpdateSubscription(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const shopId = uuidArg(a.p_shop_id);
  if (!(await hasPlatformPermission(db, ctx.userId, 'billing.manage'))) return denied(db, ctx, 'billing.subscription', 'subscription', shopId, shopId);
  const reason = requireReason(a.p_reason);
  const status = a.p_status as string;
  if (!['trialing', 'active', 'past_due', 'canceled'].includes(status)) throw invalid('Unknown subscription status.');
  const plan = await first<{ code: string; is_active: number; trial_days: number }>(db, 'SELECT code, is_active, trial_days FROM plans WHERE code = ?', (a.p_plan as string) ?? null);
  if (!plan) throw invalid('Unknown plan.');
  const before = shopId ? await first<Row>(db, 'SELECT * FROM subscriptions WHERE shop_id = ?', shopId) : null;
  if (!before) return { ok: false, code: 'not_found' };
  if (plan.is_active !== 1 && plan.code !== before.plan) throw invalid('This plan is not available for new subscriptions.');
  let trialEnds = a.p_trial_ends_at == null ? null : new Date(String(a.p_trial_ends_at)).toISOString();
  const periodEnd = a.p_current_period_end == null ? null : new Date(String(a.p_current_period_end)).toISOString();
  if (status === 'trialing' && trialEnds === null) {
    if (plan.trial_days === 0) throw invalid('Set a trial end date; this plan has no default trial.');
    trialEnds = new Date(Date.parse(ctx.now) + plan.trial_days * 86_400_000).toISOString();
  }
  if (status === 'past_due' && periodEnd === null) throw invalid('Past-due subscriptions need the end of the paid period.');
  const after = { plan: plan.code, status, trial_ends_at: trialEnds, current_period_end: periodEnd };
  const changed =
    after.plan !== before.plan || after.status !== before.status || after.trial_ends_at !== before.trial_ends_at || after.current_period_end !== before.current_period_end;
  const stmts: Stmt[] = [
    ['UPDATE subscriptions SET plan = ?, status = ?, trial_ends_at = ?, current_period_end = ? WHERE shop_id = ?', plan.code, status, trialEnds, periodEnd, shopId],
  ];
  if (changed) {
    stmts.push([
      `INSERT INTO subscription_events (shop_id, subscription_id, actor_id, event, old_plan, new_plan, old_status, new_status, details, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      shopId,
      String(before.id),
      ctx.userId,
      status !== before.status ? 'status_changed' : plan.code !== before.plan ? 'plan_changed' : 'updated',
      before.plan as string,
      plan.code,
      before.status as string,
      status,
      JSON.stringify({
        old_trial_ends_at: before.trial_ends_at,
        trial_ends_at: trialEnds,
        old_current_period_end: before.current_period_end,
        current_period_end: periodEnd,
      }),
      ctx.now,
    ]);
  }
  stmts.push(
    await auditStmt(db, ctx, 'billing.subscription_changed', 'success', 'subscription', String(before.id), shopId, reason, {
      before: { plan: before.plan, status: before.status, trial_ends_at: before.trial_ends_at, current_period_end: before.current_period_end },
      after,
    })
  );
  await batch(db, stmts);
  return { ok: true, effective_plan: await effectivePlan(db, shopId!, ctx.now) };
}

/** public.admin_upsert_plan: new plans start with every entitlement on and unlimited. */
export async function adminUpsertPlan(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'plans.manage'))) return denied(db, ctx, 'plan.upsert', 'plan', (a.p_code as string) ?? null);
  const reason = requireReason(a.p_reason);
  const code = String(a.p_code ?? '').trim().toLowerCase();
  const name = String(a.p_name ?? '').trim();
  const price = a.p_price_cents == null ? null : Number(a.p_price_cents);
  const trial = a.p_trial_days == null ? null : Number(a.p_trial_days);
  const grace = a.p_grace_days == null ? null : Number(a.p_grace_days);
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(code)) throw invalid('Plan codes are 2 to 32 lowercase letters, digits or underscores.');
  if ([...name].length < 1 || [...name].length > 80) throw invalid('Plan name is required (up to 80 characters).');
  if (price !== null && !(price >= 0 && price <= 100_000_000)) throw invalid('Price must be between 0 and 1,000,000.00.');
  if (!/^[A-Z]{3}$/.test(String(a.p_currency ?? ''))) throw invalid('Currency must be a three-letter code such as ZAR.');
  if (a.p_billing_interval !== 'month' && a.p_billing_interval !== 'year') throw invalid('Billing interval must be month or year.');
  if (trial === null || !(trial >= 0 && trial <= 365)) throw invalid('Trial days must be between 0 and 365.');
  if (grace === null || !(grace >= 0 && grace <= 90)) throw invalid('Grace days must be between 0 and 90.');
  if (code === 'free' && a.p_is_active !== true) throw invalid('The free plan is the fallback for every shop and cannot be deactivated.');
  const before = await first<Row>(db, 'SELECT code, name, price_cents, currency, billing_interval, trial_days, grace_days, is_active FROM plans WHERE code = ?', code);
  const active = a.p_is_active == null ? true : Boolean(a.p_is_active);
  const after = { code, name, price_cents: price, currency: a.p_currency, billing_interval: a.p_billing_interval, trial_days: trial, grace_days: grace, is_active: active };
  const stmts: Stmt[] = [
    [
      `INSERT INTO plans (code, name, price_cents, currency, billing_interval, trial_days, grace_days, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (code) DO UPDATE SET name = excluded.name, price_cents = excluded.price_cents, currency = excluded.currency,
         billing_interval = excluded.billing_interval, trial_days = excluded.trial_days, grace_days = excluded.grace_days,
         is_active = excluded.is_active`,
      code, name, price, String(a.p_currency), String(a.p_billing_interval), trial, grace, active ? 1 : 0, ctx.now, ctx.now,
    ],
  ];
  if (!before) {
    stmts.push([`INSERT OR IGNORE INTO plan_entitlements (plan_code, key, enabled, limit_value, updated_at) SELECT ?, key, 1, NULL, ? FROM entitlement_catalog`, code, ctx.now]);
  }
  stmts.push(
    await auditStmt(db, ctx, before ? 'plan.updated' : 'plan.created', 'success', 'plan', code, null, reason, {
      before: before ? { ...before, is_active: before.is_active === 1 } : null,
      after,
    })
  );
  await batch(db, stmts);
  return { ok: true, created: !before };
}

/** public.admin_set_entitlement */
export async function adminSetEntitlement(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const plan = (a.p_plan as string) ?? null;
  if (!(await hasPlatformPermission(db, ctx.userId, 'plans.manage'))) return denied(db, ctx, 'plan.entitlement', 'plan', plan);
  const reason = requireReason(a.p_reason);
  if (!(await first(db, 'SELECT 1 AS x FROM plans WHERE code = ?', plan))) throw invalid('Unknown plan.');
  const kind = (await first<{ kind: string }>(db, 'SELECT kind FROM entitlement_catalog WHERE key = ?', (a.p_key as string) ?? null))?.kind;
  if (!kind) throw invalid('Unknown entitlement.');
  if (a.p_enabled == null) throw invalid('Choose whether the entitlement is on.');
  const limit = a.p_limit == null ? null : Number(a.p_limit);
  if (kind === 'boolean' && limit !== null) throw invalid('This entitlement is on or off and takes no limit.');
  if (limit !== null && !(limit >= 0 && limit <= 1_000_000)) throw invalid('Limits must be between 0 and 1,000,000.');
  const before = await first<{ enabled: number; limit_value: number | null }>(db, 'SELECT enabled, limit_value FROM plan_entitlements WHERE plan_code = ? AND key = ?', plan, String(a.p_key));
  const enabled = Boolean(a.p_enabled);
  await batch(db, [
    [
      `INSERT INTO plan_entitlements (plan_code, key, enabled, limit_value, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (plan_code, key) DO UPDATE SET enabled = excluded.enabled, limit_value = excluded.limit_value`,
      plan, String(a.p_key), enabled ? 1 : 0, limit, ctx.now,
    ],
    await auditStmt(db, ctx, 'plan.entitlement_changed', 'success', 'plan', plan, null, reason, {
      key: a.p_key,
      before: before ? { enabled: before.enabled === 1, limit: before.limit_value } : null,
      after: { enabled, limit },
    }),
  ]);
  return { ok: true };
}

/** public.admin_set_feature: platform-wide switch for an on/off entitlement. */
export async function adminSetFeature(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const key = (a.p_key as string) ?? null;
  if (!(await hasPlatformPermission(db, ctx.userId, 'plans.manage'))) return denied(db, ctx, 'feature.change', 'feature', key);
  const reason = requireReason(a.p_reason);
  if (!(await first(db, `SELECT 1 AS x FROM entitlement_catalog WHERE key = ? AND kind = 'boolean'`, key))) throw invalid('Unknown feature.');
  if (a.p_enabled == null) throw invalid('Choose whether the feature is on.');
  const before = await first<{ enabled: number }>(db, 'SELECT enabled FROM platform_features WHERE key = ?', key);
  const enabled = Boolean(a.p_enabled);
  await batch(db, [
    [
      `INSERT INTO platform_features (key, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by`,
      key, enabled ? 1 : 0, ctx.userId, ctx.now,
    ],
    await auditStmt(db, ctx, 'feature.changed', 'success', 'feature', key, null, reason, { before: before ? before.enabled === 1 : null, after: enabled }),
  ]);
  return { ok: true };
}

const add = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  return into;
};

/** Ledger totals over [from, to) summed across every shop's object. */
async function ledgerTotals(db: D1Like, ctx: AdminCtx, from: string, to: string) {
  const shops = await all<{ id: string }>(db, 'SELECT id FROM shops');
  const per = await Promise.all(shops.map(async (s) => ({ id: s.id, m: await ctx.shops.rangeMetrics(s.id, from, to) })));
  const t = {
    movements: 0, units_in: 0, units_out: 0, sales: 0, expiry_created: 0, expiry_resolved: 0, expiry_open: 0,
    active_shops: 0, stock_by_reason: {} as Record<string, number>, units_by_reason: {} as Record<string, number>,
    expiry_by_kind: {} as Record<string, number>, expiry_by_resolution: {} as Record<string, number>,
    actors: new Set<string>(), tracks_expiry: 0, per,
  };
  for (const { m } of per) {
    t.movements += m.movements;
    t.units_in += m.units_in;
    t.units_out += m.units_out;
    t.sales += m.sales;
    t.expiry_created += m.expiry_created;
    t.expiry_resolved += m.expiry_resolved;
    t.expiry_open += m.expiry_open;
    if (m.movements > 0) t.active_shops++;
    if (m.tracks_expiry) t.tracks_expiry++;
    add(t.stock_by_reason, m.stock_by_reason);
    add(t.units_by_reason, m.units_by_reason);
    add(t.expiry_by_kind, m.expiry_by_kind);
    add(t.expiry_by_resolution, m.expiry_by_resolution);
    m.actors.forEach((x) => t.actors.add(x));
  }
  return t;
}

const countMap = async (db: D1Like, q: string, ...p: SqlValue[]) =>
  Object.fromEntries((await all<{ k: string; n: number }>(db, q, ...p)).map((r) => [r.k, Number(r.n)]));
const count = async (db: D1Like, q: string, ...p: SqlValue[]) => Number((await first<{ n: number }>(db, q, ...p))?.n ?? 0);

/** public.admin_platform_overview */
export async function adminPlatformOverview(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await platformRole(db, ctx.userId))) return denied(db, ctx, 'overview.view');
  const { from, to } = checkRange(a.p_from, a.p_to);
  const t = await ledgerTotals(db, ctx, from, to);
  return {
    ok: true,
    from,
    to,
    generated_at: ctx.now,
    shops: {
      total: await count(db, 'SELECT count(*) AS n FROM shops'),
      active: await count(db, `SELECT count(*) AS n FROM shops WHERE status = 'active'`),
      suspended: await count(db, `SELECT count(*) AS n FROM shops WHERE status = 'suspended'`),
      new: await count(db, 'SELECT count(*) AS n FROM shops WHERE created_at >= ? AND created_at < ?', from, to),
    },
    users: {
      registered: await count(db, 'SELECT count(*) AS n FROM users'),
      confirmed: await count(db, 'SELECT count(*) AS n FROM users WHERE email_confirmed_at IS NOT NULL'),
      new: await count(db, 'SELECT count(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', from, to),
    },
    subscriptions: {
      by_status: await countMap(db, 'SELECT status AS k, count(*) AS n FROM subscriptions GROUP BY status'),
      by_plan: await countMap(db, 'SELECT plan AS k, count(*) AS n FROM subscriptions GROUP BY plan'),
      active: await count(db, `SELECT count(*) AS n FROM subscriptions WHERE status = 'active'`),
      trials_active: await count(db, `SELECT count(*) AS n FROM subscriptions WHERE status = 'trialing' AND (trial_ends_at IS NULL OR trial_ends_at > ?)`, ctx.now),
      cancellations: await count(
        db,
        `SELECT count(*) AS n FROM subscription_events WHERE new_status = 'canceled' AND old_status IS NOT 'canceled' AND occurred_at >= ? AND occurred_at < ?`,
        from,
        to
      ),
    },
    stock: { movements: t.movements, units_in: t.units_in, units_out: t.units_out, active_shops: t.active_shops },
    stock_by_reason: t.stock_by_reason,
    sales: t.sales,
    expiry: {
      created: t.expiry_created,
      by_kind: t.expiry_by_kind,
      resolved: t.expiry_resolved,
      by_resolution: t.expiry_by_resolution,
      open: t.expiry_open,
    },
    errors: {
      push_failed: await count(db, `SELECT count(*) AS n FROM notifications WHERE push_status = 'failed' AND updated_at >= ? AND updated_at < ?`, from, to),
      sync_failures: await count(db, 'SELECT coalesce(sum(occurrences), 0) AS n FROM sync_failure_reports WHERE last_seen >= ? AND first_seen < ?', from, to),
      // pg_cron's run history has no equivalent yet; Cron Trigger failures are in Workers logs.
      cron_failures: null,
    },
    revenue: { available: false, reason: 'no_payment_provider' },
  };
}

/** Months (YYYY-MM-01) in the platform time zone from `first` through `last`. */
function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** public.admin_analytics */
export async function adminAnalytics(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'analytics.view'))) return denied(db, ctx, 'analytics.view');
  const { from, to } = checkRange(a.p_from, a.p_to);
  const tz = 'Africa/Johannesburg';
  const { localDate, zonedTime } = await import('../shop/context');
  const lastMonth = `${localDate(to, tz).slice(0, 7)}-01`;
  const [ly, lm] = lastMonth.split('-').map(Number);
  const firstDate = new Date(Date.UTC(ly, lm - 1 - 5, 1)).toISOString().slice(0, 10);
  const months = monthsBetween(firstDate, lastMonth);
  const firstInstant = zonedTime(firstDate, '00:00', tz);

  const shops = await all<{ id: string; created_at: string }>(db, 'SELECT id, created_at FROM shops');
  const cohortOf = new Map(
    shops
      .filter((s) => s.created_at >= firstInstant && s.created_at < to)
      .map((s) => [s.id, `${localDate(s.created_at, tz).slice(0, 7)}-01`])
  );
  const activeMonths = new Map<string, Set<string>>();
  await Promise.all(
    [...cohortOf.keys()].map(async (id) => {
      activeMonths.set(id, new Set(Object.keys(await ctx.shops.seriesCounts(id, 'active_shops', firstInstant, to, tz, 'month'))));
    })
  );
  const retention = months.map((month) => {
    const members = [...cohortOf.entries()].filter(([, m]) => m === month).map(([id]) => id);
    return {
      cohort: month.slice(0, 7),
      size: members.length,
      active: months.filter((later) => later >= month).map((later) => members.filter((id) => activeMonths.get(id)?.has(later)).length),
    };
  });

  const t = await ledgerTotals(db, ctx, from, to);
  const effective: Record<string, number> = {};
  for (const s of shops) {
    const plan = await effectivePlan(db, s.id, ctx.now);
    effective[plan] = (effective[plan] ?? 0) + 1;
  }
  const events = await all<{ old_status: string | null; new_status: string | null }>(
    db,
    'SELECT old_status, new_status FROM subscription_events WHERE occurred_at >= ? AND occurred_at < ?',
    from,
    to
  );
  return {
    ok: true,
    from,
    to,
    timezone: tz,
    tenants: {
      at_start: shops.filter((s) => s.created_at < from).length,
      at_end: shops.filter((s) => s.created_at < to).length,
      new: shops.filter((s) => s.created_at >= from && s.created_at < to).length,
    },
    usage: { active_shops: t.active_shops, active_users: t.actors.size },
    retention,
    conversion: {
      trials_started: events.filter((e) => e.new_status === 'trialing' && e.old_status !== 'trialing').length,
      trials_converted: events.filter((e) => e.old_status === 'trialing' && e.new_status === 'active').length,
      trials_lapsed: events.filter((e) => e.old_status === 'trialing' && (e.new_status === 'past_due' || e.new_status === 'canceled')).length,
    },
    plan_distribution: {
      subscribed: await countMap(db, 'SELECT plan AS k, count(*) AS n FROM subscriptions GROUP BY plan'),
      effective,
    },
    feature_adoption: {
      shops: shops.length,
      push_enabled: await count(
        db,
        `SELECT count(DISTINCT m.shop_id) AS n FROM shop_members m WHERE m.status = 'active' AND m.user_id IN (SELECT user_id FROM push_subscriptions)`
      ),
      teams: await count(
        db,
        `SELECT count(*) AS n FROM (SELECT shop_id FROM shop_members WHERE user_id IS NOT NULL AND status = 'active' GROUP BY shop_id HAVING count(*) > 1)`
      ),
      expiry_tracking: t.tracks_expiry,
    },
    stock_volumes: Object.fromEntries(
      Object.entries(t.stock_by_reason).map(([reason, movements]) => [reason, { movements, units: t.units_by_reason[reason] ?? 0 }])
    ),
    expiry: { created_by_kind: t.expiry_by_kind, resolved_by_resolution: t.expiry_by_resolution, open: t.expiry_open },
  };
}

/** public.admin_growth_series: one value per day, week or month in the platform time zone. */
export async function adminGrowthSeries(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await platformRole(db, ctx.userId))) return denied(db, ctx, 'analytics.series');
  const { from, to } = checkRange(a.p_from, a.p_to);
  const bucket = a.p_bucket as 'day' | 'week' | 'month';
  if (!['day', 'week', 'month'].includes(bucket)) throw invalid('Bucket must be day, week or month.');
  const metric = a.p_metric as string;
  if (!['shops', 'users', 'stock_movements', 'sales', 'expiry_alerts', 'active_shops'].includes(metric)) throw invalid('Unknown metric.');
  const tz = 'Africa/Johannesburg';
  const { localDate } = await import('../shop/context');
  const { bucketStart } = await import('../shop/metrics');

  const counts: Record<string, number> = {};
  if (metric === 'shops' || metric === 'users') {
    const table = metric === 'shops' ? 'shops' : 'users';
    for (const r of await all<{ created_at: string }>(db, `SELECT created_at FROM ${table} WHERE created_at >= ? AND created_at < ?`, from, to)) {
      const k = bucketStart(localDate(r.created_at, tz), bucket);
      counts[k] = (counts[k] ?? 0) + 1;
    }
  } else {
    const shops = await all<{ id: string }>(db, 'SELECT id FROM shops');
    for (const per of await Promise.all(shops.map((s) => ctx.shops.seriesCounts(s.id, metric, from, to, tz, bucket)))) add(counts, per);
  }
  // Every bucket from the one containing `from` to the one containing the last instant before `to`.
  const series: { bucket: string; value: number }[] = [];
  const last = bucketStart(localDate(new Date(Date.parse(to) - 1).toISOString(), tz), bucket);
  let cursor = bucketStart(localDate(from, tz), bucket);
  while (cursor <= last) {
    series.push({ bucket: cursor, value: counts[cursor] ?? 0 });
    const d = new Date(`${cursor}T00:00:00Z`);
    if (bucket === 'day') d.setUTCDate(d.getUTCDate() + 1);
    else if (bucket === 'week') d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return { ok: true, metric, bucket, timezone: tz, series };
}

/** public.admin_operations_health */
export async function adminOperationsHealth(db: D1Like, ctx: AdminCtx): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'operations.view'))) return denied(db, ctx, 'operations.view');
  const now = Date.parse(ctx.now);
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const sync = await all<Row>(
    db,
    `SELECT op_type, error_code, sum(occurrences) AS occurrences, count(DISTINCT shop_id) AS shops, count(DISTINCT user_id) AS users,
            max(last_seen) AS last_seen
       FROM sync_failure_reports WHERE last_seen > ? GROUP BY op_type, error_code ORDER BY sum(occurrences) DESC LIMIT 20`,
    ago(7 * 86_400_000)
  );
  return {
    ok: true,
    generated_at: ctx.now,
    // Cron Triggers keep no run history in the database; see Workers logs and Cron Events.
    scheduler: { available: false },
    push: {
      by_status_7d: await countMap(
        db,
        `SELECT push_status AS k, count(*) AS n FROM notifications WHERE created_at > ? AND type = 'expiry' GROUP BY push_status`,
        ago(7 * 86_400_000)
      ),
      due_now: await count(db, `SELECT count(*) AS n FROM notifications WHERE push_status IN ('pending', 'sending') AND push_next_at <= ?`, ctx.now),
      oldest_due_at:
        (await first<{ t: string | null }>(db, `SELECT min(push_next_at) AS t FROM notifications WHERE push_status IN ('pending', 'sending') AND push_next_at <= ?`, ctx.now))?.t ??
        null,
      failed_24h: await count(db, `SELECT count(*) AS n FROM notifications WHERE push_status = 'failed' AND updated_at > ?`, ago(86_400_000)),
      last_sent_at: (await first<{ t: string | null }>(db, `SELECT max(pushed_at) AS t FROM notifications WHERE push_status = 'sent'`))?.t ?? null,
    },
    sync: sync.map((r) => ({ ...r, occurrences: Number(r.occurrences), shops: Number(r.shops), users: Number(r.users) })),
    integrations: {
      push_keys: ctx.integrations?.push_keys ?? false,
      push_subject: ctx.integrations?.push_subject ?? false,
      scheduler_secret: true,
      project_url: true,
      payment_provider: false,
    },
  };
}

const CATEGORY_LIST = ['groceries', 'beverages', 'snacks', 'bakery', 'dairy', 'personal_care', 'household', 'airtime', 'other'];
const cleanBarcode = (v: unknown) => String(v ?? '').replace(/\s/g, '');

function optionalText(value: unknown, max: number, label: string): string | null {
  if (value === null || value === undefined) return null;
  const clean = String(value).trim() || null;
  if (clean !== null && [...clean].length > max) throw invalid(`${label} is too long (up to ${max} characters).`);
  return clean;
}

async function catalogBarcodeList(db: D1Like, id: string) {
  return all(db, 'SELECT barcode, kind, units_per_package FROM catalog_barcodes WHERE catalog_product_id = ? ORDER BY kind, barcode', id);
}

/** public.admin_search_catalog */
export async function adminSearchCatalog(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'catalog.verify'))) return denied(db, ctx, 'catalog.search', 'catalog');
  const term = [...String(a.p_query ?? '').trim()].slice(0, 80).join('');
  const limit = pageLimit(a.p_limit);
  const offset = pageOffset(a.p_offset);
  const pattern = `%${term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const where = `WHERE ? = '' OR c.name LIKE ? ESCAPE '\\' OR c.brand LIKE ? ESCAPE '\\'
                   OR EXISTS (SELECT 1 FROM catalog_barcodes b WHERE b.catalog_product_id = c.id AND b.barcode LIKE ? ESCAPE '\\')`;
  const total = await count(db, `SELECT count(*) AS n FROM catalog_products c ${where}`, term, pattern, pattern, pattern);
  const rows = await all<Row>(
    db,
    `SELECT c.id, c.name, c.brand, c.category, c.package_size, c.package_quantity, c.package_unit, c.image_url, c.image_path, c.verification_status
       FROM catalog_products c ${where} ORDER BY c.name, c.id LIMIT ? OFFSET ?`,
    term,
    pattern,
    pattern,
    pattern,
    limit,
    offset
  );
  for (const r of rows) r.barcodes = await catalogBarcodeList(db, String(r.id));
  await batch(db, [await auditStmt(db, ctx, 'catalog.search', 'success', 'catalog', null, null, null, { query: term, total })]);
  return { ok: true, total, limit, offset, rows };
}

/** public.admin_get_catalog_product */
export async function adminGetCatalogProduct(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const id = uuidArg(a.p_id);
  if (!(await hasPlatformPermission(db, ctx.userId, 'catalog.verify'))) return denied(db, ctx, 'catalog.view', 'catalog', id);
  if (!id) throw invalid('Catalog product id is required.');
  const p = await first<Row>(
    db,
    `SELECT id, name, brand, category, package_size, package_quantity, package_unit, image_url, image_path, verification_status, source, common
       FROM catalog_products WHERE id = ?`,
    id
  );
  if (!p) return { ok: false, code: 'not_found' };
  const barcodes = await catalogBarcodeList(db, id);
  await batch(db, [await auditStmt(db, ctx, 'catalog.view', 'success', 'catalog', id)]);
  return { ok: true, product: { ...p, common: p.common === 1 }, barcodes };
}

/** public.admin_save_catalog_product: create (as verified) or edit a catalog product. */
export async function adminSaveCatalogProduct(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const id = uuidArg(a.p_id);
  if (!(await hasPlatformPermission(db, ctx.userId, 'catalog.verify'))) return denied(db, ctx, 'catalog.save', 'catalog', id);
  const reason = requireReason(a.p_reason);
  const name = String(a.p_name ?? '').trim();
  const status = String(a.p_verification_status ?? '').trim();
  const quantity = a.p_package_quantity == null ? null : Number(a.p_package_quantity);
  if (name === '' || [...name].length > 200) throw invalid('Product name is required (up to 200 characters).');
  if (typeof a.p_category !== 'string' || !CATEGORY_LIST.includes(a.p_category)) throw invalid('Unknown product category.');
  if (!['external', 'user_submitted', 'verified'].includes(status)) throw invalid('Unknown verification status.');
  if (quantity !== null && !(quantity > 0)) throw invalid('Package quantity must be greater than zero.');
  const brand = optionalText(a.p_brand, 80, 'Brand');
  const size = optionalText(a.p_package_size, 40, 'Size');
  const unit = optionalText(a.p_package_unit, 16, 'Unit');
  let productId = id;
  const created = id === null;
  if (created) {
    productId = crypto.randomUUID();
    await batch(db, [
      [
        `INSERT INTO catalog_products (id, name, brand, category, package_size, package_quantity, package_unit, source, verification_status,
           created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 'verified', ?, ?, ?)`,
        productId, name, brand, a.p_category, size, quantity, unit, ctx.userId, ctx.now, ctx.now,
      ],
      await auditStmt(db, ctx, 'catalog.save', 'success', 'catalog', productId, null, reason, { created: true }),
    ]);
  } else {
    const changed = await run(
      db,
      `UPDATE catalog_products SET name = ?, brand = ?, category = ?, package_size = ?, package_quantity = ?, package_unit = ?,
              verification_status = ? WHERE id = ?`,
      name, brand, a.p_category as string, size, quantity, unit, status, productId
    );
    if (!changed) return { ok: false, code: 'not_found' };
    await batch(db, [await auditStmt(db, ctx, 'catalog.save', 'success', 'catalog', productId, null, reason, { created: false })]);
  }
  return { ok: true, created, id: productId };
}

/** public.admin_link_catalog_barcode: conflicts are answered and audited, not raised. */
export async function adminLinkCatalogBarcode(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const id = uuidArg(a.p_catalog_product_id);
  if (!(await hasPlatformPermission(db, ctx.userId, 'catalog.verify'))) return denied(db, ctx, 'catalog.barcode', 'catalog', id);
  const reason = requireReason(a.p_reason);
  const barcode = cleanBarcode(a.p_barcode);
  const kind = a.p_kind as string;
  const units = a.p_units_per_package == null ? null : Number(a.p_units_per_package);
  if (!id) throw invalid('Catalog product id is required.');
  if (barcode === '' || [...barcode].length > 64) throw invalid('Barcode is required (up to 64 characters).');
  if (!['unit', 'alternate', 'pack'].includes(kind)) throw invalid('Choose a unit, alternate or pack barcode.');
  if (kind === 'pack' && (units === null || units < 2 || units > 10_000)) throw invalid('A pack holds 2 to 10,000 units.');
  if (kind !== 'pack' && units !== null) throw invalid('Only a pack barcode has a unit count.');
  if (!(await first(db, 'SELECT 1 AS x FROM catalog_products WHERE id = ?', id))) return { ok: false, code: 'not_found' };
  const existing = await first<Row>(db, 'SELECT * FROM catalog_barcodes WHERE barcode = ?', barcode);
  if (existing && existing.catalog_product_id !== id) {
    await batch(db, [await auditStmt(db, ctx, 'catalog.barcode', 'denied', 'catalog', id, null, reason, { code: 'conflict', barcode })]);
    return { ok: false, code: 'conflict' };
  }
  if (existing) {
    await batch(db, [await auditStmt(db, ctx, 'catalog.barcode', 'success', 'catalog', id, null, reason, { barcode, unchanged: true })]);
    return { ok: true, barcode: existing, unchanged: true };
  }
  try {
    await batch(db, [
      [
        `INSERT INTO catalog_barcodes (barcode, catalog_product_id, kind, units_per_package, source, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`,
        barcode, id, kind, kind === 'pack' ? units : null, ctx.userId, ctx.now, ctx.now,
      ],
      await auditStmt(db, ctx, 'catalog.barcode', 'success', 'catalog', id, null, reason, { barcode, kind }),
    ]);
  } catch {
    await batch(db, [await auditStmt(db, ctx, 'catalog.barcode', 'denied', 'catalog', id, null, reason, { code: 'conflict', barcode })]);
    return { ok: false, code: 'conflict' };
  }
  return { ok: true, barcode: await first(db, 'SELECT * FROM catalog_barcodes WHERE barcode = ?', barcode), unchanged: false };
}

/** public.admin_unlink_catalog_barcode */
export async function adminUnlinkCatalogBarcode(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  if (!(await hasPlatformPermission(db, ctx.userId, 'catalog.verify'))) return denied(db, ctx, 'catalog.barcode_remove', 'catalog', null);
  const reason = requireReason(a.p_reason);
  const barcode = cleanBarcode(a.p_barcode);
  if (barcode === '') throw invalid('Barcode is required.');
  const link = await first<{ catalog_product_id: string }>(db, 'SELECT catalog_product_id FROM catalog_barcodes WHERE barcode = ?', barcode);
  if (!link) return { ok: false, code: 'not_found' };
  await batch(db, [
    ['DELETE FROM catalog_barcodes WHERE barcode = ?', barcode],
    await auditStmt(db, ctx, 'catalog.barcode_remove', 'success', 'catalog', link.catalog_product_id, null, reason, { barcode }),
  ]);
  return { ok: true };
}

/** public.admin_set_catalog_common */
export async function adminSetCatalogCommon(db: D1Like, ctx: AdminCtx, a: Args): Promise<Row> {
  const id = uuidArg(a.p_id);
  if (!(await hasPlatformPermission(db, ctx.userId, 'catalog.verify'))) return denied(db, ctx, 'catalog.common', 'catalog', id);
  const reason = requireReason(a.p_reason);
  if (!id || a.p_common == null) throw invalid('Catalog product and common flag are required.');
  const common = Boolean(a.p_common);
  if (!(await run(db, 'UPDATE catalog_products SET common = ? WHERE id = ?', common ? 1 : 0, id))) return { ok: false, code: 'not_found' };
  await batch(db, [await auditStmt(db, ctx, 'catalog.common', 'success', 'catalog', id, null, reason, { common })]);
  return { ok: true, common };
}

/** public.admin_set_catalog_image: needs ctx.imageExists (R2) for a new path. */
export async function adminSetCatalogImage(db: D1Like, ctx: AdminCtx & { imageExists?: (key: string) => Promise<boolean> }, a: Args): Promise<Row> {
  const id = uuidArg(a.p_id);
  if (!(await hasPlatformPermission(db, ctx.userId, 'catalog.verify'))) return denied(db, ctx, 'catalog.image', 'catalog', id);
  const reason = requireReason(a.p_reason);
  if (!id) throw invalid('Catalog product id is required.');
  if (!(await first(db, 'SELECT 1 AS x FROM catalog_products WHERE id = ?', id))) return { ok: false, code: 'not_found' };
  const path = String(a.p_image_path ?? '').trim() || null;
  if (path !== null) {
    const match = /^catalog\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(webp|jpg)$/.exec(path);
    if (match?.[1] !== id) throw invalid('This picture does not belong to that catalog product.');
    if (!ctx.imageExists || !(await ctx.imageExists(path))) throw invalid('The picture has not been uploaded.');
  }
  await batch(db, [
    ['UPDATE catalog_products SET image_path = ? WHERE id = ?', path, id],
    await auditStmt(db, ctx, 'catalog.image', 'success', 'catalog', id, null, reason, { image_path: path }),
  ]);
  return { ok: true, image_path: path };
}
