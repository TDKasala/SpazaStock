/**
 * Who is calling a shop function, resolved by the Worker from the session and D1 before the call
 * reaches the shop's Durable Object. Replaces auth.uid(), shop_members/role_permissions lookups,
 * shop status and timezone that the Postgres functions read themselves.
 */
import { forbidden, suspended } from '../db/errors';

export type ShopRole = 'owner' | 'manager' | 'staff';

export interface ShopCtx {
  shopId: string;
  /** null for scheduled jobs running as the system. */
  userId: string | null;
  role: ShopRole | null;
  permissions: string[];
  shopActive: boolean;
  timezone: string;
  /** One clock per call, like Postgres now() inside a transaction. ISO UTC with milliseconds. */
  now: string;
}

/** A change the shop object asks the Worker to make in D1 after the call, such as notifications. */
export type ShopEffect = NotifyEffect | { kind: 'clear_catalog_prompt' };

export type NotifyEffect = {
  kind: 'notify_roles';
  roles: ShopRole[];
  type: 'low_stock' | 'expiry' | 'stock_discrepancy' | 'member' | 'system';
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  /** When set, a Web Push is queued (push_status 'pending') for this time; otherwise in-app only. */
  pushAt?: string;
};

export interface ShopCall {
  ctx: ShopCtx;
  effects: ShopEffect[];
  /**
   * Facts from outside the shop that the Worker looked up before the call: shared catalog rows
   * (D1) and whether an uploaded picture exists (R2). Each function documents what it reads.
   */
  inputs: ShopInputs;
}

export interface CatalogFact {
  id: string;
  image_path: string | null;
}

export interface ShopInputs {
  /** Catalog products referenced by the call that exist in D1, by id. */
  catalog?: Record<string, CatalogFact>;
  /** Picture paths referenced by the call that exist in R2. */
  imagesPresent?: string[];
  [key: string]: unknown;
}

export function hasShopRole(ctx: ShopCtx, roles: ShopRole[]): boolean {
  return ctx.userId !== null && ctx.role !== null && roles.includes(ctx.role);
}

export function hasPermission(ctx: ShopCtx, permission: string): boolean {
  return ctx.userId !== null && ctx.permissions.includes(permission);
}

/** private.assert_shop_role */
export function assertShopRole(ctx: ShopCtx, roles: ShopRole[]): void {
  if (!hasShopRole(ctx, roles)) throw forbidden();
  if (!ctx.shopActive) throw suspended();
}

/** private.assert_permission */
export function assertPermission(ctx: ShopCtx, permission: string): void {
  if (!hasPermission(ctx, permission)) throw forbidden();
  if (!ctx.shopActive) throw suspended();
}

/** private.shop_today: the calendar date in the shop's time zone. */
export function shopToday(ctx: ShopCtx, at: string = ctx.now): string {
  return localDate(at, ctx.timezone);
}

export function localDate(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The UTC instant of a wall-clock time on a date in a time zone ("07:00 shop time"). */
export function zonedTime(date: string, time: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset, including on a daylight-saving change.
  let guess = wanted;
  for (let i = 0; i < 2; i++) guess = wanted - offsetMs(guess, timeZone);
  return new Date(guess).toISOString();
}

function offsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - at;
}

/** Whole days from one calendar date to another (date - date in Postgres). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
