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
  create table auth.users (id uuid primary key, email text);
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
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return pg;
}

export async function createUser(pg: PGlite, email: string = `${randomUUID().slice(0, 8)}@example.com`): Promise<User> {
  const id = randomUUID();
  await pg.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
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
  const [row] = await query<{ id: string }>(pg, owner, 'insert into public.shops (name) values ($1) returning id', [name]);
  return row.id;
}

/** Invites `user` to the shop and has them accept, returning the membership id. */
export async function addMember(
  pg: PGlite,
  owner: User,
  shopId: string,
  user: User,
  role: 'owner' | 'manager' | 'staff'
): Promise<string> {
  const invite = await rpc<{ id: string }>(pg, owner, 'invite_shop_member', {
    p_shop_id: shopId,
    p_email: user.email,
    p_role: role,
  });
  await rpc(pg, user, 'accept_pending_invites');
  return invite.id;
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
  options: { key?: string; saleId?: string } = {}
): Promise<SaleResult> {
  return rpc(pg, caller, 'record_sale', {
    p_sale_id: options.saleId ?? randomUUID(),
    p_shop_id: shopId,
    p_idempotency_key: options.key ?? randomUUID(),
    p_sold_at: new Date().toISOString(),
    p_items: lines.map((l) => ({ id: l.id ?? randomUUID(), unit_price: 18.5, ...l })),
  });
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
