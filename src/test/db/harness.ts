/**
 * Runs the real Supabase migrations on PGlite (Postgres compiled to WebAssembly) with small
 * stand-ins for Supabase's `auth` schema and API roles, so RLS and the database functions can be
 * exercised exactly as PostgREST would call them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite, type Transaction } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'supabase', 'migrations');

const SUPABASE_STANDINS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key,
    email text,
    email_confirmed_at timestamptz,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    last_sign_in_at timestamptz
  );
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(auth.jwt() ->> 'sub', '')::uuid
  $$;
`;

export interface User {
  id: string;
  email: string;
}

/** A signed-in user, an anonymous caller (null), or the server-side service role. */
export type Caller = User | null | 'service';

export async function createDatabase(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STANDINS);
  // *_schedule.sql needs pg_cron, pg_net and Vault, which PGlite lacks; it only schedules
  // functions that the other migrations define and these tests exercise directly.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_schedule.sql'))
    .sort();
  for (const file of files) {
    try {
      await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return pg;
}

export interface CreateUserOptions {
  /** Leaves email_confirmed_at empty, like an account whose sign-up code was never entered. */
  unconfirmed?: boolean;
  displayName?: string;
}

export async function createUser(
  pg: PGlite,
  email: string = `${randomUUID().slice(0, 8)}@example.com`,
  options: CreateUserOptions = {}
): Promise<User> {
  const id = randomUUID();
  await pg.query(
    'insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, $3, $4)',
    [
      id,
      email,
      options.unconfirmed ? null : new Date().toISOString(),
      JSON.stringify(options.displayName ? { display_name: options.displayName } : {}),
    ]
  );
  return { id, email };
}

/** Runs `fn` inside a transaction as the given API caller, like a PostgREST request. */
export async function as<T>(pg: PGlite, caller: Caller, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return pg.transaction(async (tx) => {
    if (caller === 'service') {
      await tx.exec('set local role service_role');
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })]);
    } else if (caller === null) {
      await tx.exec('set local role anon');
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })]);
    } else {
      await tx.exec('set local role authenticated');
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: caller.id, email: caller.email, role: 'authenticated' }),
      ]);
    }
    return fn(tx);
  });
}

/** Calls a public function with named arguments; results are serialised like PostgREST does. */
export async function rpc<T = Record<string, unknown>>(
  pg: PGlite,
  caller: Caller,
  fn: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const names = Object.keys(args);
  const call = `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
  const values = Object.values(args).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
  const { rows } = await as(pg, caller, (tx) =>
    tx.query<{ result: T }>(`select to_jsonb(r) as result from ${call} as r`, values)
  );
  return rows[0]?.result as T;
}

/** Resolves to the Postgres error code the promise rejects with, or undefined if it succeeds. */
export async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

export async function query<T = Record<string, unknown>>(
  pg: PGlite,
  caller: Caller,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const { rows } = await as(pg, caller, (tx) => tx.query<T>(sql, params));
  return rows;
}

// Domain helpers -------------------------------------------------------------------

export async function createShop(pg: PGlite, owner: User, name = 'Spaza'): Promise<string> {
  const shop = await rpc<{ id: string }>(pg, owner, 'create_shop', { p_name: name });
  return shop.id;
}

export interface InviteResult {
  member_id: string;
  email: string;
  role: string;
  token: string;
  expires_at: string;
}

export async function invite(
  pg: PGlite,
  owner: User,
  shopId: string,
  email: string,
  role: 'manager' | 'staff' = 'staff'
): Promise<InviteResult> {
  return rpc<InviteResult>(pg, owner, 'invite_shop_member', { p_shop_id: shopId, p_email: email, p_role: role });
}

/**
 * Invites `user` and has them accept the link, returning the membership id. Owners are invited
 * as managers and then promoted, because invites cannot grant ownership.
 */
export async function addMember(
  pg: PGlite,
  owner: User,
  shopId: string,
  user: User,
  role: 'owner' | 'manager' | 'staff'
): Promise<string> {
  const invited = await invite(pg, owner, shopId, user.email, role === 'staff' ? 'staff' : 'manager');
  await rpc(pg, user, 'accept_shop_invite', { p_token: invited.token });
  if (role === 'owner') {
    await rpc(pg, owner, 'update_member_role', { p_member_id: invited.member_id, p_role: 'owner' });
  }
  return invited.member_id;
}

export async function newProduct(
  pg: PGlite,
  caller: Caller,
  shopId: string,
  barcode: string = randomUUID().replace(/-/g, '').slice(0, 13)
): Promise<{ id: string; barcode: string }> {
  return rpc(pg, caller, 'upsert_product', {
    p_id: randomUUID(),
    p_shop_id: shopId,
    p_barcode: barcode,
    p_name: 'Bread',
    p_category: 'bakery',
    p_buying_price: 12,
    p_selling_price: 18.5,
    p_created_at: new Date().toISOString(),
  });
}

export interface StockInResult {
  batch: { id: string; quantity: number };
  duplicate: boolean;
  total_quantity: number;
}

export async function stockIn(
  pg: PGlite,
  caller: Caller,
  shopId: string,
  productId: string,
  quantity: number,
  options: { expiry?: string | null; batchId?: string; key?: string | null } = {}
): Promise<StockInResult> {
  return rpc(pg, caller, 'record_stock_in', {
    p_batch_id: options.batchId ?? randomUUID(),
    p_shop_id: shopId,
    p_product_id: productId,
    p_quantity: quantity,
    p_expiry_date: options.expiry ?? null,
    p_cost_price_per_unit: 9.5,
    p_received_at: new Date().toISOString(),
    p_idempotency_key: options.key ?? null,
  });
}

export interface SaleLine {
  id?: string;
  product_id: string;
  quantity: number;
  unit_price?: number;
}

export interface SaleResult {
  sale: { id: string; total_amount: number; item_count: number };
  items: Array<{
    id: string;
    product_id: string;
    quantity: number;
    line_total: number;
    allocations: Array<{ batchId: string; quantityDeducted: number; batchExpiryDate: string | null }>;
  }>;
  stock_totals: Record<string, number>;
  duplicate: boolean;
  shortfall: number;
}

export async function sell(
  pg: PGlite,
  caller: Caller,
  shopId: string,
  lines: SaleLine[],
  options: { key?: string; saleId?: string; soldAt?: Date } = {}
): Promise<SaleResult> {
  return rpc(pg, caller, 'record_sale', {
    p_sale_id: options.saleId ?? randomUUID(),
    p_shop_id: shopId,
    p_idempotency_key: options.key ?? randomUUID(),
    p_sold_at: (options.soldAt ?? new Date()).toISOString(),
    p_items: lines.map((l) => ({ id: l.id ?? randomUUID(), unit_price: 18.5, ...l })),
  });
}

export interface VoidResult {
  sale: { id: string };
  item: { id: string; quantity: number; voided_quantity: number };
  stock_total: number;
  duplicate: boolean;
}

export async function voidItem(
  pg: PGlite,
  caller: Caller,
  shopId: string,
  saleItemId: string,
  quantity: number,
  options: { key?: string; occurredAt?: Date } = {}
): Promise<VoidResult> {
  return rpc(pg, caller, 'void_sale_item', {
    p_shop_id: shopId,
    p_sale_item_id: saleItemId,
    p_quantity: quantity,
    p_occurred_at: (options.occurredAt ?? new Date()).toISOString(),
    p_idempotency_key: options.key ?? randomUUID(),
  });
}

// Platform administration ----------------------------------------------------------

/** A reason long enough for private.require_reason. */
export const REASON = 'Requested by the owner by email, ticket 1042';

/** The README runbook: the database owner, not an API caller, grants the first superadmin. */
export async function bootstrapSuperadmin(pg: PGlite, user: User): Promise<void> {
  await pg.query('select private.bootstrap_superadmin($1, $2)', [user.email, 'First platform administrator']);
}

export async function grantAdmin(pg: PGlite, by: User, user: User, role: string): Promise<void> {
  const result = await rpc<{ ok: boolean }>(pg, by, 'admin_grant_admin', {
    p_email: user.email,
    p_role: role,
    p_reason: REASON,
  });
  if (!result.ok) throw new Error(`Granting ${role} to ${user.email} was refused`);
}

export interface AuditRow {
  id: number;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  shop_id: string | null;
  reason: string | null;
  outcome: 'success' | 'denied';
  details: Record<string, unknown>;
}

/** Audit rows, read as the database owner (clients cannot read the log directly). */
export async function auditRows(
  pg: PGlite,
  filter: { actor?: User; action?: string; outcome?: 'success' | 'denied' } = {}
): Promise<AuditRow[]> {
  const { rows } = await pg.query<AuditRow>(
    `select * from public.platform_audit_log
     where ($1::uuid is null or actor_id = $1) and ($2::text is null or action = $2)
       and ($3::text is null or outcome = $3)
     order by id`,
    [filter.actor?.id ?? null, filter.action ?? null, filter.outcome ?? null]
  );
  return rows;
}

export async function adjust(
  pg: PGlite,
  caller: Caller,
  shopId: string,
  batchId: string,
  delta: number,
  reason: string = 'count_correction',
  key: string = randomUUID()
): Promise<{ duplicate: boolean; total_quantity: number; batch: { quantity: number } }> {
  return rpc(pg, caller, 'record_stock_adjustment', {
    p_shop_id: shopId,
    p_batch_id: batchId,
    p_quantity_delta: delta,
    p_reason: reason,
    p_occurred_at: new Date().toISOString(),
    p_idempotency_key: key,
  });
}
