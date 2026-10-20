// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  bootstrapSuperadmin,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  query,
  REASON,
  rpc,
  type User,
} from './harness';

let pg: PGlite;
let ownerA: User;
let ownerB: User;
let outsider: User;
let admin: User;
let shopA: string;
let shopB: string;
let commonId: string;

const BARCODE = '6001087354019';

beforeAll(async () => {
  pg = await createDatabase();
  ownerA = await createUser(pg);
  ownerB = await createUser(pg);
  outsider = await createUser(pg);
  admin = await createUser(pg);
  await bootstrapSuperadmin(pg, admin);

  commonId = randomUUID();
  await query(
    pg,
    'service',
    `insert into public.catalog_products
       (id, name, brand, category, package_size, source, verification_status, common)
     values ($1, 'Maize meal', 'Ace', 'groceries', '2.5kg', 'user', 'verified', true)`,
    [commonId]
  );
  await query(
    pg,
    'service',
    `insert into public.catalog_barcodes (barcode, catalog_product_id, kind, source)
     values ($1, $2, 'unit', 'user')`,
    [BARCODE, commonId]
  );
  await query(
    pg,
    'service',
    `insert into public.catalog_products
       (id, name, category, source, verification_status, common)
     values ($1, 'Rare soap', 'personal_care', 'user', 'verified', false)`,
    [randomUUID()]
  );

  shopA = await createShop(pg, ownerA, 'Shop A');
  shopB = await createShop(pg, ownerB, 'Shop B');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

function confirm(caller: User, shopId: string, selections: unknown[]) {
  return rpc<{ ok: boolean; products: { created: boolean; product: { buying_price: string | null } }[] }>(
    pg,
    caller,
    'confirm_shop_catalog',
    { p_shop_id: shopId, p_selections: selections }
  );
}

describe('new shop catalogue', () => {
  it('does not copy common products into a shop when the shop is created', async () => {
    const shops = await query<{ id: string; catalog_prompt_pending: boolean }>(
      pg,
      'service',
      'select id, catalog_prompt_pending from public.shops where id in ($1, $2)',
      [shopA, shopB]
    );
    expect(shops).toHaveLength(2);
    expect(shops.every((shop) => shop.catalog_prompt_pending)).toBe(true);
    const [{ n }] = await query<{ n: number }>(pg, 'service', 'select count(*)::int as n from public.products');
    expect(n).toBe(0);
    const [{ batches }] = await query<{ batches: number }>(
      pg,
      'service',
      'select count(*)::int as batches from public.stock_batches'
    );
    expect(batches).toBe(0);
  });

  it('keeps prices, quantities and expiry off the shared catalogue', async () => {
    const columns = await query<{ column_name: string }>(
      pg,
      'service',
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'catalog_products'
         and column_name in ('buying_price', 'selling_price', 'quantity', 'expiry_date', 'price')`
    );
    expect(columns).toEqual([]);
  });

  it('gives each shop its own product and leaves prices alone when confirm runs again', async () => {
    const first = await confirm(ownerA, shopA, [
      { catalog_product_id: commonId, buying_price: 10, selling_price: 15 },
      { catalog_product_id: commonId, buying_price: 99, selling_price: 99 },
    ]);
    expect(first.products).toHaveLength(1);
    expect(first.products[0].created).toBe(true);

    await confirm(ownerB, shopB, [{ catalog_product_id: commonId, buying_price: 12, selling_price: 18 }]);

    const again = await Promise.all([
      confirm(ownerA, shopA, [{ catalog_product_id: commonId, buying_price: 40, selling_price: 50 }]),
      confirm(ownerA, shopA, [{ catalog_product_id: commonId, buying_price: 70, selling_price: 80 }]),
    ]);
    expect(again.every((result) => result.products.length === 1 && result.products[0].created === false)).toBe(true);

    const rows = await query<{ shop_id: string; buying_price: string; selling_price: string }>(
      pg,
      'service',
      `select shop_id, buying_price::text, selling_price::text
       from public.products where catalog_product_id = $1 order by shop_id`,
      [commonId]
    );
    expect(rows).toHaveLength(2);
    const shopARow = rows.find((row) => row.shop_id === shopA);
    const shopBRow = rows.find((row) => row.shop_id === shopB);
    expect(shopARow).toMatchObject({ buying_price: '10.00', selling_price: '15.00' });
    expect(shopBRow).toMatchObject({ buying_price: '12.00', selling_price: '18.00' });

    const [{ batches }] = await query<{ batches: number }>(
      pg,
      'service',
      'select count(*)::int as batches from public.stock_batches'
    );
    expect(batches).toBe(0);
    const [{ pending }] = await query<{ pending: boolean }>(
      pg,
      'service',
      'select catalog_prompt_pending as pending from public.shops where id = $1',
      [shopA]
    );
    expect(pending).toBe(false);
  });

  it('lists common products without another shop’s prices', async () => {
    const listed = await rpc<{ items: { id: string; shop_product_id: string | null }[] }>(
      pg,
      ownerB,
      'list_common_catalog',
      { p_shop_id: shopB }
    );
    expect(listed.items.map((item) => item.id)).toContain(commonId);
    expect(listed.items.find((item) => item.id === commonId)?.shop_product_id).toBeTruthy();
    expect(JSON.stringify(listed)).not.toContain('buying_price');
    expect(JSON.stringify(listed)).not.toContain('15.00');
    expect(await errorCode(rpc(pg, outsider, 'list_common_catalog', { p_shop_id: shopA }))).toBe('42501');
  });

  it('skip clears the prompt and inserts nothing', async () => {
    const owner = await createUser(pg);
    const shop = await createShop(pg, owner, 'Skip shop');
    const result = await confirm(owner, shop, []);
    expect(result.products).toEqual([]);
    const [{ n }] = await query<{ n: number }>(
      pg,
      'service',
      'select count(*)::int as n from public.products where shop_id = $1',
      [shop]
    );
    expect(n).toBe(0);
    const [{ pending }] = await query<{ pending: boolean }>(
      pg,
      'service',
      'select catalog_prompt_pending as pending from public.shops where id = $1',
      [shop]
    );
    expect(pending).toBe(false);
  });

  it('refuses an outsider and a suspended shop, and does not fill an existing shop', async () => {
    expect(
      await errorCode(
        confirm(outsider, shopA, [{ catalog_product_id: commonId, buying_price: 1, selling_price: 2 }])
      )
    ).toBe('42501');

    const owner = await createUser(pg);
    const suspended = await createShop(pg, owner, 'Suspended shop');
    await query(pg, 'service', `update public.shops set status = 'suspended', suspended_at = now() where id = $1`, [
      suspended,
    ]);
    expect(
      await errorCode(confirm(owner, suspended, [{ catalog_product_id: commonId, buying_price: 1, selling_price: 2 }]))
    ).toBe('SP001');
    const [{ suspendedProducts }] = await query<{ suspendedProducts: number }>(
      pg,
      'service',
      'select count(*)::int as "suspendedProducts" from public.products where shop_id = $1',
      [suspended]
    );
    expect(suspendedProducts).toBe(0);

    const existingOwner = await createUser(pg);
    const existing = await createShop(pg, existingOwner, 'Existing shop');
    await query(pg, 'service', 'update public.shops set catalog_prompt_pending = false where id = $1', [existing]);
    await createShop(pg, ownerA, 'Later shop');
    const [{ n }] = await query<{ n: number }>(
      pg,
      'service',
      'select count(*)::int as n from public.products where shop_id = $1',
      [existing]
    );
    expect(n).toBe(0);
    const [{ pending }] = await query<{ pending: boolean }>(
      pg,
      'service',
      'select catalog_prompt_pending as pending from public.shops where id = $1',
      [existing]
    );
    expect(pending).toBe(false);
  });

  it('does not copy a product that is not marked common', async () => {
    const [{ id: rareId }] = await query<{ id: string }>(
      pg,
      'service',
      `select id from public.catalog_products where common = false limit 1`
    );
    const before = await query<{ n: number }>(pg, 'service', 'select count(*)::int as n from public.products');
    expect(
      await errorCode(confirm(ownerA, shopA, [{ catalog_product_id: rareId, buying_price: 1, selling_price: 2 }]))
    ).toBe('22023');
    const after = await query<{ n: number }>(pg, 'service', 'select count(*)::int as n from public.products');
    expect(after[0].n).toBe(before[0].n);
  });

  it('lets a superadmin change only the common flag', async () => {
    const saved = await rpc<{ ok: boolean; common: boolean }>(pg, admin, 'admin_set_catalog_common', {
      p_id: commonId,
      p_common: false,
      p_reason: REASON,
    });
    expect(saved).toMatchObject({ ok: true, common: false });
    const [row] = await query<{ name: string; common: boolean }>(
      pg,
      'service',
      'select name, common from public.catalog_products where id = $1',
      [commonId]
    );
    expect(row).toEqual({ name: 'Maize meal', common: false });
    await rpc(pg, admin, 'admin_set_catalog_common', {
      p_id: commonId,
      p_common: true,
      p_reason: REASON,
    });
    const detail = await rpc<{ ok: boolean; product: { common: boolean; name: string } }>(
      pg,
      admin,
      'admin_get_catalog_product',
      { p_id: commonId }
    );
    expect(detail.product).toMatchObject({ name: 'Maize meal', common: true });
  });
});
