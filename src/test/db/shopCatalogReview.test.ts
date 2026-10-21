// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  createDatabase,
  createShop,
  createUser,
  errorCode,
  query,
  rpc,
  stockIn,
  type User,
} from './harness';

let pg: PGlite;
let ownerA: User;
let ownerB: User;
let outsider: User;
let shopA: string;
let shopB: string;
let maize: string;
let rice: string;
let sugar: string;

beforeAll(async () => {
  pg = await createDatabase();
  ownerA = await createUser(pg);
  ownerB = await createUser(pg);
  outsider = await createUser(pg);

  maize = await addCommon(pg, 'Maize meal', '6001087354019');
  rice = await addCommon(pg, 'Rice', '6001087354020');
  sugar = await addCommon(pg, 'Sugar', '6001087354031');
  await query(
    pg,
    'service',
    `insert into public.catalog_products (id, name, category, source, verification_status, common)
     values ($1, 'Rare soap', 'personal_care', 'user', 'verified', false)`,
    [randomUUID()]
  );

  shopA = await createShop(pg, ownerA, 'Shop A');
  shopB = await createShop(pg, ownerB, 'Shop B');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

async function addCommon(database: PGlite, name: string, barcode: string): Promise<string> {
  const id = randomUUID();
  await query(
    database,
    'service',
    `insert into public.catalog_products
       (id, name, brand, category, package_size, source, verification_status, common)
     values ($1, $2, 'Ace', 'groceries', '2.5kg', 'user', 'verified', true)`,
    [id, name]
  );
  await query(
    database,
    'service',
    `insert into public.catalog_barcodes (barcode, catalog_product_id, kind, source)
     values ($1, $2, 'unit', 'user')`,
    [barcode, id]
  );
  return id;
}

function review(caller: User, shopId: string, decisions: unknown[]) {
  return rpc<{ ok: boolean; products: { created: boolean }[] }>(pg, caller, 'review_shop_catalog', {
    p_shop_id: shopId,
    p_decisions: decisions,
  });
}

describe('shop catalogue review', () => {
  it('pages the common catalogue and does not copy it into a new shop', async () => {
    const [{ n }] = await query<{ n: number }>(pg, 'service', 'select count(*)::int as n from public.products');
    expect(n).toBe(0);
    const first = await rpc<{
      total: number;
      items: { name: string }[];
      progress: { total: number; open: number; selling: number; hidden: number };
    }>(pg, ownerA, 'list_shop_catalog_review', { p_shop_id: shopA, p_limit: 2, p_offset: 0 });
    expect(first.total).toBe(3);
    expect(first.items.map((item) => item.name)).toEqual(['Maize meal', 'Rice']);
    expect(first.progress).toEqual({ total: 3, open: 3, selling: 0, hidden: 0 });
    expect(JSON.stringify(first)).not.toContain('buying_price');

    const second = await rpc<{ items: { name: string }[] }>(pg, ownerA, 'list_shop_catalog_review', {
      p_shop_id: shopA,
      p_limit: 2,
      p_offset: 2,
    });
    expect(second.items.map((item) => item.name)).toEqual(['Sugar']);
  });

  it('lets two shops sell and hide the same product without sharing stock or prices', async () => {
    const hidden = await review(ownerA, shopA, [
      { catalog_product_id: maize, decision: 'hide' },
      { catalog_product_id: maize, decision: 'sell', buying_price: 99, selling_price: 99 },
    ]);
    expect(hidden.products).toHaveLength(1);
    expect(hidden.products[0].created).toBe(true);

    await review(ownerB, shopB, [{ catalog_product_id: rice, decision: 'sell', buying_price: 10, selling_price: 15 }]);

    const rows = await query<{ shop_id: string; catalog_product_id: string; buying_price: string | null; selling_price: string | null; listed: boolean }>(
      pg,
      'service',
      `select shop_id, catalog_product_id, buying_price::text, selling_price::text, listed
       from public.products order by shop_id, catalog_product_id`
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.shop_id === shopA)).toEqual({
      shop_id: shopA,
      catalog_product_id: maize,
      buying_price: null,
      selling_price: null,
      listed: false,
    });
    expect(rows.find((row) => row.shop_id === shopB)).toEqual({
      shop_id: shopB,
      catalog_product_id: rice,
      buying_price: '10.00',
      selling_price: '15.00',
      listed: true,
    });

    const [{ batches }] = await query<{ batches: number }>(pg, 'service', 'select count(*)::int as batches from public.stock_batches');
    expect(batches).toBe(0);
    const [{ pending }] = await query<{ pending: boolean }>(
      pg,
      'service',
      'select catalog_prompt_pending as pending from public.shops where id = $1',
      [shopA]
    );
    expect(pending).toBe(true);
    const [{ common }] = await query<{ common: boolean }>(
      pg,
      'service',
      'select common from public.catalog_products where id = $1',
      [maize]
    );
    expect(common).toBe(true);

    const selling = await rpc<{ items: { id: string }[]; progress: { selling: number; hidden: number; open: number } }>(
      pg,
      ownerB,
      'list_shop_catalog_review',
      { p_shop_id: shopB, p_status: 'selling' }
    );
    expect(selling.items.map((item) => item.id)).toEqual([rice]);
    expect(selling.progress).toMatchObject({ selling: 1, hidden: 0, open: 2 });
    const hiddenPage = await rpc<{ items: { id: string }[] }>(pg, ownerA, 'list_shop_catalog_review', {
      p_shop_id: shopA,
      p_status: 'hidden',
    });
    expect(hiddenPage.items.map((item) => item.id)).toEqual([maize]);
  });

  it('hides a stocked product without changing its price or deleting the batch', async () => {
    const [{ id: productId }] = await query<{ id: string }>(
      pg,
      'service',
      'select id from public.products where shop_id = $1 and catalog_product_id = $2',
      [shopB, rice]
    );
    await stockIn(pg, ownerB, shopB, productId, 4);
    await review(ownerB, shopB, [{ catalog_product_id: rice, decision: 'hide', buying_price: 1, selling_price: 2 }]);
    const [row] = await query<{ buying_price: string; selling_price: string; listed: boolean; quantity: number }>(
      pg,
      'service',
      `select p.buying_price::text, p.selling_price::text, p.listed, b.quantity
       from public.products p
       join public.stock_batches b on b.product_id = p.id
       where p.id = $1`,
      [productId]
    );
    expect(row).toEqual({ buying_price: '10.00', selling_price: '15.00', listed: false, quantity: 4 });
  });

  it('keeps the original prices when sell is repeated, including overlapping calls', async () => {
    const again = await Promise.all([
      review(ownerB, shopB, [{ catalog_product_id: rice, decision: 'sell', buying_price: 40, selling_price: 50 }]),
      review(ownerB, shopB, [{ catalog_product_id: rice, decision: 'sell', buying_price: 70, selling_price: 80 }]),
    ]);
    expect(again.every((result) => result.products.length === 1 && result.products[0].created === false)).toBe(true);
    const [row] = await query<{ buying_price: string; selling_price: string; n: number }>(
      pg,
      'service',
      `select buying_price::text, selling_price::text, (select count(*)::int from public.products where shop_id = $1) as n
       from public.products where shop_id = $1 and catalog_product_id = $2`,
      [shopB, rice]
    );
    expect(row).toMatchObject({ buying_price: '10.00', selling_price: '15.00', n: 1 });
  });

  it('refuses a product that is not common and refuses outsiders and a suspended shop', async () => {
    const [{ id: rareId }] = await query<{ id: string }>(
      pg,
      'service',
      'select id from public.catalog_products where common = false limit 1'
    );
    const before = await query<{ n: number }>(pg, 'service', 'select count(*)::int as n from public.products');
    expect(await errorCode(review(ownerA, shopA, [{ catalog_product_id: rareId, decision: 'sell' }]))).toBe('22023');
    const after = await query<{ n: number }>(pg, 'service', 'select count(*)::int as n from public.products');
    expect(after[0].n).toBe(before[0].n);
    expect(await errorCode(review(ownerA, shopA, []))).toBe('22023');

    expect(await errorCode(rpc(pg, outsider, 'list_shop_catalog_review', { p_shop_id: shopA }))).toBe('42501');
    expect(await errorCode(review(outsider, shopA, [{ catalog_product_id: sugar, decision: 'hide' }]))).toBe('42501');

    const owner = await createUser(pg);
    const suspended = await createShop(pg, owner, 'Suspended shop');
    await query(pg, 'service', `update public.shops set status = 'suspended', suspended_at = now() where id = $1`, [
      suspended,
    ]);
    expect(await errorCode(review(owner, suspended, [{ catalog_product_id: sugar, decision: 'sell' }]))).toBe('SP001');
    const listed = await rpc(pg, owner, 'list_shop_catalog_review', { p_shop_id: suspended });
    expect(listed).toMatchObject({ progress: { total: 3, open: 3 } });
  });

  it('still has no price, quantity, or expiry on the shared catalogue', async () => {
    const columns = await query<{ column_name: string }>(
      pg,
      'service',
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'catalog_products'
         and column_name in ('buying_price', 'selling_price', 'quantity', 'expiry_date', 'price')`
    );
    expect(columns).toEqual([]);
  });

  it('skip clears the prompt and does not insert products', async () => {
    const owner = await createUser(pg);
    const shop = await createShop(pg, owner, 'Skip shop');
    await review(owner, shop, [{ catalog_product_id: sugar, decision: 'sell', buying_price: 3, selling_price: 5 }]);
    const result = await rpc<{ products: unknown[] }>(pg, owner, 'confirm_shop_catalog', {
      p_shop_id: shop,
      p_selections: [],
    });
    expect(result.products).toEqual([]);
    const [{ n }] = await query<{ n: number }>(
      pg,
      'service',
      'select count(*)::int as n from public.products where shop_id = $1',
      [shop]
    );
    expect(n).toBe(1);
    const [{ pending }] = await query<{ pending: boolean }>(
      pg,
      'service',
      'select catalog_prompt_pending as pending from public.shops where id = $1',
      [shop]
    );
    expect(pending).toBe(false);
  });
});
