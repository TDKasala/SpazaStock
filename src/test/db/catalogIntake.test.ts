// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createDatabase, createShop, createUser, errorCode, query, rpc, stockIn, type User } from './harness';

let pg: PGlite;
let owner: User;
let outsider: User;
let shop: string;
let otherShop: string;

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  outsider = await createUser(pg);
  shop = await createShop(pg, owner, 'Intake shop');
  otherShop = await createShop(pg, outsider, 'Other shop');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

async function shopToday(shopId: string): Promise<string> {
  const [row] = await query<{ today: string }>(
    pg,
    'service',
    `select (timezone(coalesce(s.timezone, 'Africa/Johannesburg'), now()))::date::text as today
     from public.shops s where s.id = $1`,
    [shopId]
  );
  return row.today;
}

function shiftDate(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function addCatalog(name: string, barcode: string | null): Promise<string> {
  const id = randomUUID();
  await query(
    pg,
    'service',
    `insert into public.catalog_products (id, name, category, source, verification_status, common)
     values ($1, $2, 'groceries', 'user', 'verified', true)`,
    [id, name]
  );
  if (barcode) {
    await query(
      pg,
      'service',
      `insert into public.catalog_barcodes (barcode, catalog_product_id, kind, source)
       values ($1, $2, 'unit', 'user')`,
      [barcode, id]
    );
  }
  return id;
}

async function onHand(productId: string): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(
    'select coalesce(sum(quantity), 0)::int as n from public.stock_batches where product_id = $1',
    [productId]
  );
  return Number(rows[0].n);
}

function item(
  catalogId: string,
  batches: Array<{ id?: string; quantity: number; expiry: string | null }>,
  productId = randomUUID()
) {
  return {
    catalog_product_id: catalogId,
    product_id: productId,
    buying_price: 4,
    selling_price: 7,
    batches: batches.map((batch) => ({
      id: batch.id ?? randomUUID(),
      quantity: batch.quantity,
      expiry_date: batch.expiry,
    })),
  };
}

describe('confirm_catalog_intake', () => {
  it('adds two batches once, and a retry does not increase stock', async () => {
    const today = await shopToday(shop);
    const catalogId = await addCatalog('Maize meal', '6001000001111');
    const productId = randomUUID();
    const firstBatch = randomUUID();
    const secondBatch = randomUUID();
    const payload = [
      item(catalogId, [
        { id: firstBatch, quantity: 3, expiry: shiftDate(today, 20) },
        { id: secondBatch, quantity: 5, expiry: null },
      ], productId),
    ];

    const created = await rpc<{ items: Array<{ status: string; created: boolean; batches: Array<{ duplicate: boolean }> }> }>(
      pg,
      owner,
      'confirm_catalog_intake',
      { p_shop_id: shop, p_items: payload }
    );
    expect(created.items[0]).toMatchObject({ status: 'created', created: true });
    expect(created.items[0].batches.map((batch) => batch.duplicate)).toEqual([false, false]);
    expect(await onHand(productId)).toBe(8);

    const again = await rpc<{ items: Array<{ status: string; batches: Array<{ duplicate: boolean }> }> }>(
      pg,
      owner,
      'confirm_catalog_intake',
      { p_shop_id: shop, p_items: payload }
    );
    expect(again.items[0].status).toBe('duplicate');
    expect(again.items[0].batches.every((batch) => batch.duplicate)).toBe(true);
    expect(await onHand(productId)).toBe(8);

    const { rows } = await pg.query<{ n: number }>(
      'select count(*)::int as n from public.products where shop_id = $1 and catalog_product_id = $2',
      [otherShop, catalogId]
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('does not add stock to a product this shop already counted', async () => {
    const today = await shopToday(shop);
    const catalogId = await addCatalog('Rice', '6001000002222');
    const productId = randomUUID();
    await rpc(pg, owner, 'adopt_catalog_product', {
      p_id: productId,
      p_shop_id: shop,
      p_catalog_product_id: catalogId,
      p_buying_price: 10,
      p_selling_price: 15,
    });
    await stockIn(pg, owner, shop, productId, 4, { expiry: shiftDate(today, 12) });

    const result = await rpc<{ items: Array<{ status: string; batches: unknown[] }> }>(pg, owner, 'confirm_catalog_intake', {
      p_shop_id: shop,
      p_items: [item(catalogId, [{ quantity: 9, expiry: shiftDate(today, 12) }])],
    });
    expect(result.items[0].status).toBe('already_in_shop');
    expect(result.items[0].batches).toEqual([]);
    expect(await onHand(productId)).toBe(4);
  });

  it('rolls back the whole intake when a quantity is not a whole number', async () => {
    const today = await shopToday(shop);
    const good = await addCatalog('Beans', '6001000003333');
    const bad = await addCatalog('Salt', '6001000004444');
    const code = await errorCode(
      rpc(pg, owner, 'confirm_catalog_intake', {
        p_shop_id: shop,
        p_items: [
          item(good, [{ quantity: 2, expiry: shiftDate(today, 5) }]),
          item(bad, [{ quantity: 0, expiry: null }]),
        ],
      })
    );
    expect(code).toBe('22023');
    const { rows } = await pg.query<{ n: number }>(
      'select count(*)::int as n from public.products where catalog_product_id = any($1::uuid[])',
      [[good, bad]]
    );
    expect(Number(rows[0].n)).toBe(0);
    expect(await errorCode(rpc(pg, outsider, 'confirm_catalog_intake', { p_shop_id: shop, p_items: [] }))).toBe('42501');
  });

  it('rolls back an earlier product when a later one cannot be linked', async () => {
    const today = await shopToday(shop);
    const good = await addCatalog('Sugar', '6001000005555');
    const bare = await addCatalog('No barcode', null);
    const code = await errorCode(
      rpc(pg, owner, 'confirm_catalog_intake', {
        p_shop_id: shop,
        p_items: [
          item(good, [{ quantity: 2, expiry: shiftDate(today, 5) }]),
          item(bare, [{ quantity: 1, expiry: null }]),
        ],
      })
    );
    expect(code).toBe('22023');
    const { rows } = await pg.query<{ n: number }>(
      'select count(*)::int as n from public.products where shop_id = $1 and catalog_product_id = $2',
      [shop, good]
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
