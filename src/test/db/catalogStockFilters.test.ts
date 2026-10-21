// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createDatabase, createShop, createUser, query, rpc, stockIn, type User } from './harness';

let pg: PGlite;
let owner: User;
let other: User;
let shop: string;
let otherShop: string;
let bread: string;
let coke: string;

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  other = await createUser(pg);
  shop = await createShop(pg, owner, 'Filter shop');
  otherShop = await createShop(pg, other, 'Other shop');
  bread = await addCommon('Bread', 'bakery', '6001000000001');
  coke = await addCommon('Coke', 'beverages', '6001000000002');

  const sold = await rpc<{ products: { product: { id: string } }[] }>(pg, owner, 'review_shop_catalog', {
    p_shop_id: shop,
    p_decisions: [{ catalog_product_id: bread, decision: 'sell', buying_price: 8, selling_price: 12 }],
  });
  const productId = sold.products[0].product.id;
  const [{ today }] = await query<{ today: string }>(
    pg,
    'service',
    `select (timezone(coalesce(s.timezone, 'Africa/Johannesburg'), now()))::date::text as today
     from public.shops s where s.id = $1`,
    [shop]
  );
  await stockIn(pg, owner, shop, productId, 3, { expiry: shiftDate(today, 2) });
  await query(pg, 'service', 'update public.products set min_stock_units = 5 where id = $1', [productId]);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

async function addCommon(name: string, category: string, barcode: string): Promise<string> {
  const id = randomUUID();
  await query(
    pg,
    'service',
    `insert into public.catalog_products
       (id, name, category, source, verification_status, common)
     values ($1, $2, $3, 'user', 'verified', true)`,
    [id, name, category]
  );
  await query(
    pg,
    'service',
    `insert into public.catalog_barcodes (barcode, catalog_product_id, kind, source)
     values ($1, $2, 'unit', 'user')`,
    [barcode, id]
  );
  return id;
}

function shiftDate(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function names(page: { items: { name: string }[] }): string[] {
  return page.items.map((item) => item.name).sort();
}

describe('catalogue category and stock filters', () => {
  it('filters the shop catalogue page by category and stock level', async () => {
    const bakery = await rpc<{ items: { name: string }[] }>(pg, owner, 'list_shop_catalog_review', {
      p_shop_id: shop,
      p_category: 'bakery',
    });
    expect(names(bakery)).toEqual(['Bread']);

    const inStock = await rpc<{ items: { name: string }[] }>(pg, owner, 'list_shop_catalog_review', {
      p_shop_id: shop,
      p_stock: 'in',
    });
    expect(names(inStock)).toEqual(['Bread']);

    const out = await rpc<{ items: { name: string }[] }>(pg, owner, 'list_shop_catalog_review', {
      p_shop_id: shop,
      p_stock: 'out',
    });
    expect(names(out)).toEqual(['Coke']);

    const low = await rpc<{ items: { name: string }[] }>(pg, owner, 'list_shop_catalog_review', {
      p_shop_id: shop,
      p_stock: 'low',
    });
    expect(names(low)).toEqual(['Bread']);

    const expiring = await rpc<{ items: { name: string }[] }>(pg, owner, 'list_shop_catalog_review', {
      p_shop_id: shop,
      p_stock: 'expiring',
    });
    expect(names(expiring)).toEqual(['Bread']);

    const otherShopIn = await rpc<{ items: { name: string }[] }>(pg, other, 'list_shop_catalog_review', {
      p_shop_id: otherShop,
      p_stock: 'in',
    });
    expect(otherShopIn.items).toEqual([]);
  });

  it('filters shared catalogue search the same way and leaves the other shop alone', async () => {
    const drinks = await rpc<{ items: { name: string }[] }>(pg, owner, 'search_catalog', {
      p_shop_id: shop,
      p_category: 'beverages',
      p_in_shop: null,
    });
    expect(names(drinks)).toEqual(['Coke']);

    const stocked = await rpc<{ items: { name: string }[] }>(pg, owner, 'search_catalog', {
      p_shop_id: shop,
      p_stock: 'in',
      p_in_shop: null,
    });
    expect(names(stocked)).toEqual(['Bread']);

    const elsewhere = await rpc<{ items: { name: string }[] }>(pg, other, 'search_catalog', {
      p_shop_id: otherShop,
      p_stock: 'in',
      p_in_shop: null,
    });
    expect(elsewhere.items).toEqual([]);
  });
});
