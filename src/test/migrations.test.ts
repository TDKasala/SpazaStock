// @vitest-environment node
/**
 * Runs the real Supabase migrations on PGlite (Postgres compiled to WebAssembly) with small
 * stand-ins for Supabase's `auth` schema and API roles, then exercises RLS and the write RPCs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite, type Transaction } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations');

const SUPABASE_STANDINS = `
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;

  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
`;

let pg: PGlite;
const alice = randomUUID();
const bob = randomUUID();
let aliceShop: string;
let bobShop: string;

/** Runs `fn` as an API caller: signed in as `userId`, or anonymous when null. */
async function as<T>(userId: string | null, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return pg.transaction(async (tx) => {
    await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    return fn(tx);
  });
}

async function rpc<T = Record<string, unknown>>(
  userId: string | null,
  fn: string,
  args: Record<string, unknown>
): Promise<T> {
  const names = Object.keys(args);
  // to_jsonb mirrors how PostgREST serialises both jsonb and composite (row) results.
  const sql = `select to_jsonb(public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})) as result`;
  const { rows } = await as(userId, (tx) => tx.query<{ result: T }>(sql, Object.values(args)));
  return rows[0].result;
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

async function newProduct(userId: string, shopId: string, barcode: string = randomUUID().slice(0, 13)) {
  return rpc<{ id: string }>(userId, 'upsert_product', {
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

async function stockIn(
  userId: string,
  shopId: string,
  productId: string,
  quantity: number,
  expiry: string | null,
  batchId: string = randomUUID()
) {
  return rpc<{ duplicate: boolean; total_quantity: number }>(userId, 'record_stock_in', {
    p_batch_id: batchId,
    p_movement_id: randomUUID(),
    p_shop_id: shopId,
    p_product_id: productId,
    p_quantity: quantity,
    p_expiry_date: expiry,
    p_cost_price_per_unit: null,
    p_received_at: new Date().toISOString(),
    p_idempotency_key: null,
  });
}

async function sell(
  userId: string,
  shopId: string,
  productId: string,
  quantity: number,
  key: string = randomUUID(),
  saleId: string = randomUUID()
) {
  return rpc<{
    duplicate: boolean;
    shortfall: number;
    total_quantity: number;
    sale: { id: string; total_amount: number; allocations: Array<{ quantityDeducted: number; batchExpiryDate: string | null }> };
  }>(userId, 'record_sale', {
    p_sale_id: saleId,
    p_movement_id: randomUUID(),
    p_shop_id: shopId,
    p_product_id: productId,
    p_quantity: quantity,
    p_unit_price: 18.5,
    p_idempotency_key: key,
    p_sold_at: new Date().toISOString(),
  });
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SUPABASE_STANDINS);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  await pg.query('insert into auth.users (id) values ($1), ($2)', [alice, bob]);

  const create = (userId: string, name: string) =>
    as(userId, (tx) => tx.query<{ id: string }>('insert into public.shops (name) values ($1) returning id', [name]));
  aliceShop = (await create(alice, "Alice's Spaza")).rows[0].id;
  bobShop = (await create(bob, "Bob's Spaza")).rows[0].id;
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('row level security', () => {
  it('shows each owner only their own shop', async () => {
    const { rows } = await as(alice, (tx) => tx.query<{ id: string }>('select id from public.shops'));
    expect(rows.map((r) => r.id)).toEqual([aliceShop]);
  });

  it('stops a user creating a shop for someone else', async () => {
    const code = await errorCode(
      as(alice, (tx) => tx.query('insert into public.shops (owner_id, name) values ($1, $2)', [bob, 'Fake']))
    );
    expect(code).toBe('42501');
  });

  it("stops a user writing into another owner's shop through the RPCs", async () => {
    expect(await errorCode(newProduct(alice, bobShop))).toBe('42501');

    const bobProduct = await newProduct(bob, bobShop);
    expect(await errorCode(stockIn(alice, bobShop, bobProduct.id, 5, null))).toBe('P0002');
    expect(await errorCode(sell(alice, bobShop, bobProduct.id, 1))).toBe('P0002');
  });

  it('hides all data and the write API from anonymous callers', async () => {
    expect(await errorCode(as(null, (tx) => tx.query('select * from public.products')))).toBe('42501');
    expect(await errorCode(newProduct(null as unknown as string, aliceShop))).toBe('42501');
  });

  it('keeps sales append-only', async () => {
    const product = await newProduct(alice, aliceShop);
    await stockIn(alice, aliceShop, product.id, 2, null);
    const { sale } = await sell(alice, aliceShop, product.id, 1);
    const { affectedRows } = await as(alice, (tx) =>
      tx.query('update public.sales set quantity = 99 where id = $1', [sale.id])
    );
    expect(affectedRows).toBe(0);
  });
});

describe('upsert_product', () => {
  it('is idempotent on the client id', async () => {
    const id = randomUUID();
    const args = {
      p_id: id,
      p_shop_id: aliceShop,
      p_barcode: '600 700 800',
      p_name: ' Maize Meal ',
      p_category: 'groceries',
      p_buying_price: null,
      p_selling_price: 89.99,
      p_created_at: new Date().toISOString(),
    };
    const first = await rpc<{ id: string; barcode: string; name: string }>(alice, 'upsert_product', args);
    const again = await rpc<{ id: string }>(alice, 'upsert_product', args);
    expect(first).toMatchObject({ id, barcode: '600700800', name: 'Maize Meal' });
    expect(again.id).toBe(id);
  });

  it('returns the existing product when another device registered the same barcode', async () => {
    const original = await newProduct(alice, aliceShop, '6009999000001');
    const fromOtherPhone = await newProduct(alice, aliceShop, '6009999000001');
    expect(fromOtherPhone.id).toBe(original.id);
  });

  it('rejects invalid input with a permanent error code', async () => {
    const code = await errorCode(
      rpc(alice, 'upsert_product', {
        p_id: randomUUID(),
        p_shop_id: aliceShop,
        p_barcode: '  ',
        p_name: 'x',
        p_category: 'other',
        p_buying_price: null,
        p_selling_price: null,
        p_created_at: null,
      })
    );
    expect(code).toBe('22023');
  });
});

describe('record_stock_in', () => {
  it('adds a batch once, even when the same delivery is replayed', async () => {
    const product = await newProduct(alice, aliceShop);
    const batchId = randomUUID();
    const first = await stockIn(alice, aliceShop, product.id, 12, '2026-11-01', batchId);
    const replay = await stockIn(alice, aliceShop, product.id, 12, '2026-11-01', batchId);
    expect(first).toMatchObject({ duplicate: false, total_quantity: 12 });
    expect(replay).toMatchObject({ duplicate: true, total_quantity: 12 });
  });

  it('rejects a non-positive quantity', async () => {
    const product = await newProduct(alice, aliceShop);
    expect(await errorCode(stockIn(alice, aliceShop, product.id, 0, null))).toBe('22023');
  });
});

describe('record_sale', () => {
  it('deducts first-expired-first-out and records the allocation', async () => {
    const product = await newProduct(alice, aliceShop);
    await stockIn(alice, aliceShop, product.id, 3, '2026-12-01');
    await stockIn(alice, aliceShop, product.id, 4, null);
    await stockIn(alice, aliceShop, product.id, 5, '2026-11-01');

    const result = await sell(alice, aliceShop, product.id, 7);
    expect(result).toMatchObject({ duplicate: false, shortfall: 0, total_quantity: 5 });
    expect(Number(result.sale.total_amount)).toBe(129.5);
    expect(result.sale.allocations.map((a) => [a.batchExpiryDate, a.quantityDeducted])).toEqual([
      ['2026-11-01', 5],
      ['2026-12-01', 2],
    ]);
  });

  it('does not deduct twice for a replayed sale id or idempotency key', async () => {
    const product = await newProduct(alice, aliceShop);
    await stockIn(alice, aliceShop, product.id, 10, null);
    const saleId = randomUUID();
    await sell(alice, aliceShop, product.id, 2, 'scan-1', saleId);

    const sameId = await sell(alice, aliceShop, product.id, 2, 'scan-1', saleId);
    const sameKey = await sell(alice, aliceShop, product.id, 2, 'scan-1');
    expect(sameId).toMatchObject({ duplicate: true, total_quantity: 8 });
    expect(sameKey).toMatchObject({ duplicate: true, total_quantity: 8 });
  });

  it('keeps an oversold sale and raises a discrepancy instead of failing', async () => {
    const product = await newProduct(alice, aliceShop);
    await stockIn(alice, aliceShop, product.id, 2, null);

    const result = await sell(alice, aliceShop, product.id, 5);
    expect(result).toMatchObject({ duplicate: false, shortfall: 3, total_quantity: 0 });

    const { rows } = await as(alice, (tx) =>
      tx.query<{ shortfall: number; sale_id: string }>(
        'select shortfall, sale_id from public.stock_discrepancies where product_id = $1',
        [product.id]
      )
    );
    expect(rows).toEqual([{ shortfall: 3, sale_id: result.sale.id }]);
  });

  it('lets the owner mark a discrepancy as resolved', async () => {
    const product = await newProduct(alice, aliceShop);
    await sell(alice, aliceShop, product.id, 1);
    const { affectedRows } = await as(alice, (tx) =>
      tx.query('update public.stock_discrepancies set resolved_at = now() where product_id = $1', [product.id])
    );
    expect(affectedRows).toBe(1);
  });
});
