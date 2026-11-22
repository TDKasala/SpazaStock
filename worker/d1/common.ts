/** Shared pieces of the D1 (shared database) functions. */
import { all, first, type D1Like } from '../db/d1';
import { DbError, forbidden, suspended } from '../db/errors';
import type { SqlValue } from '../db/sql';
import type { ShopRole } from '../shop/context';

export interface D1Ctx {
  userId: string | null;
  email: string | null;
  /** ISO UTC with milliseconds, one clock per call. */
  now: string;
}

export interface Membership {
  member_id: string;
  role: ShopRole;
  permissions: string[];
  shop_status: 'active' | 'suspended';
  timezone: string;
  expiry_reminder_days: number[];
}

/** The caller's active membership of a shop, with its permissions, or null. */
export async function membership(db: D1Like, shopId: string, userId: string | null): Promise<Membership | null> {
  if (!userId) return null;
  const row = await first<{ member_id: string; role: ShopRole; status: string; timezone: string; days: string }>(
    db,
    `SELECT m.id AS member_id, m.role, s.status, s.timezone, s.expiry_reminder_days AS days
       FROM shop_members m JOIN shops s ON s.id = m.shop_id
      WHERE m.shop_id = ? AND m.user_id = ? AND m.status = 'active'`,
    shopId,
    userId
  );
  if (!row) return null;
  const permissions = (await all<{ permission: string }>(db, 'SELECT permission FROM role_permissions WHERE role = ?', row.role)).map(
    (r) => r.permission
  );
  return {
    member_id: row.member_id,
    role: row.role,
    permissions,
    shop_status: row.status as Membership['shop_status'],
    timezone: row.timezone,
    expiry_reminder_days: JSON.parse(row.days),
  };
}

export async function shopIsActive(db: D1Like, shopId: string): Promise<boolean> {
  const row = await first<{ status: string }>(db, 'SELECT status FROM shops WHERE id = ?', shopId);
  return row ? row.status === 'active' : true;
}

/** private.assert_shop_role */
export async function assertShopRole(db: D1Like, ctx: D1Ctx, shopId: string, roles: ShopRole[]): Promise<Membership> {
  const m = await membership(db, shopId, ctx.userId);
  if (!m || !roles.includes(m.role)) throw forbidden();
  if (m.shop_status !== 'active') throw suspended();
  return m;
}

/** private.assert_permission */
export async function assertPermission(db: D1Like, ctx: D1Ctx, shopId: string, permission: string): Promise<Membership> {
  const m = await membership(db, shopId, ctx.userId);
  if (!m || !m.permissions.includes(permission)) throw forbidden();
  if (m.shop_status !== 'active') throw suspended();
  return m;
}

export async function hasPermission(db: D1Like, ctx: D1Ctx, shopId: string, permission: string): Promise<boolean> {
  const m = await membership(db, shopId, ctx.userId);
  return Boolean(m && m.permissions.includes(permission));
}

/** private.effective_plan: the plan whose limits apply now. */
export async function effectivePlan(db: D1Like, shopId: string, now: string): Promise<string> {
  const row = await first<{ plan: string; status: string; trial_ends_at: string | null; current_period_end: string | null; grace_days: number }>(
    db,
    `SELECT s.plan, s.status, s.trial_ends_at, s.current_period_end, p.grace_days
       FROM subscriptions s JOIN plans p ON p.code = s.plan WHERE s.shop_id = ?`,
    shopId
  );
  if (!row) return 'free';
  const t = Date.parse(now);
  const ok =
    row.status === 'active' ||
    (row.status === 'trialing' && (row.trial_ends_at === null || Date.parse(row.trial_ends_at) > t)) ||
    (row.status === 'past_due' &&
      row.current_period_end !== null &&
      Date.parse(row.current_period_end) + row.grace_days * 86_400_000 > t);
  return ok ? row.plan : 'free';
}

/** private.entitled */
export async function entitled(db: D1Like, shopId: string, key: string, now: string): Promise<boolean> {
  const feature = await first<{ enabled: number }>(db, 'SELECT enabled FROM platform_features WHERE key = ?', key);
  if (feature && feature.enabled === 0) return false;
  const plan = await effectivePlan(db, shopId, now);
  const e = await first<{ enabled: number }>(db, 'SELECT enabled FROM plan_entitlements WHERE plan_code = ? AND key = ?', plan, key);
  return e ? e.enabled === 1 : true;
}

/** private.entitlement_limit: null means unlimited. */
export async function entitlementLimit(db: D1Like, shopId: string, key: string, now: string): Promise<number | null> {
  const plan = await effectivePlan(db, shopId, now);
  const e = await first<{ enabled: number; limit_value: number | null }>(
    db,
    'SELECT enabled, limit_value FROM plan_entitlements WHERE plan_code = ? AND key = ?',
    plan,
    key
  );
  if (!e) return null;
  return e.enabled === 0 ? 0 : e.limit_value;
}

/** private.shop_entitlements */
export async function shopEntitlements(db: D1Like, shopId: string, now: string) {
  return {
    plan: await effectivePlan(db, shopId, now),
    expiry_push: await entitled(db, shopId, 'expiry_push', now),
    team_max_members: await entitlementLimit(db, shopId, 'team.max_members', now),
  };
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString();

/** private.user_email */
export async function userEmail(db: D1Like, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  return (await first<{ email: string }>(db, 'SELECT lower(email) AS email FROM users WHERE id = ?', userId))?.email ?? null;
}

export type Stmt = [string, ...SqlValue[]];

export function uuidArg(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new DbError('22P02', `invalid input syntax for type uuid: "${String(value)}"`);
  }
  return value.toLowerCase();
}
