// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  bootstrapSuperadmin,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  newProduct,
  query,
  REASON,
  rpc,
  stockIn,
  type User,
} from './harness';

let pg: PGlite;
let owner: User;
let otherOwner: User;
let outsider: User;
let admin: User;
let shop: string;
let otherShop: string;

const BARCODE = '6001224760439';

interface CatalogProduct {
  id: string;
  name: string;
  brand: string | null;
  verification_status: string;
  source: string;
  package_size: string | null;
  package_quantity: number | null;
}

interface SubmitResult {
  product: CatalogProduct;
  correction_id: string | null;
  created: boolean;
}

function submit(
  caller: User,
  shopId: string,
  barcode: string,
  fields: Record<string, unknown> = {}
): Promise<SubmitResult> {
  return rpc(pg, caller, 'submit_catalog_product', {
    p_shop_id: shopId,
    p_barcode: barcode,
    p_name: 'Sunlight',
    p_category: 'household',
    p_brand: 'Sunlight',
    p_package_size: '500g',
    ...fields,
  });
}

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  otherOwner = await createUser(pg);
  outsider = await createUser(pg);
  admin = await createUser(pg);
  shop = await createShop(pg, owner, 'Shop A');
  otherShop = await createShop(pg, otherOwner, 'Shop B');
  await bootstrapSuperadmin(pg, admin);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('shared catalog', () => {
  it('returns the first catalog product when the same barcode is saved twice', async () => {
    const first = await submit(owner, shop, BARCODE);
    const second = await submit(otherOwner, otherShop, BARCODE, { p_name: 'Other name' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.product.id).toBe(first.product.id);
    expect(second.product.name).toBe('Sunlight');
  });

  it('does not change a verified product and files a correction instead', async () => {
    await query(
      pg,
      'service',
      `update catalog_products set verification_status = 'verified', source = 'user' where name = 'Sunlight'`
    );
    const saved = await submit(owner, shop, BARCODE, { p_name: 'Sunlight Powder', p_brand: 'Unilever' });
    expect(saved.product.name).toBe('Sunlight');
    expect(saved.product.verification_status).toBe('verified');
    expect(saved.correction_id).toBeTruthy();

    const rows = await query<{ proposed_name: string; status: string }>(
      pg,
      owner,
      `select proposed_name, status from catalog_corrections where id = $1`,
      [saved.correction_id]
    );
    expect(rows[0]).toMatchObject({ proposed_name: 'Sunlight Powder', status: 'pending' });
  });

  it('lets a superadmin apply a correction without dropping verification', async () => {
    const pending = await query<{ id: string }>(
      pg,
      'service',
      `select id from catalog_corrections where status = 'pending' limit 1`
    );
    const applied = await rpc<{ ok: boolean; product: CatalogProduct }>(pg, admin, 'apply_catalog_correction', {
      p_correction_id: pending[0].id,
      p_reason: REASON,
    });
    expect(applied.ok).toBe(true);
    expect(applied.product.name).toBe('Sunlight Powder');
    expect(applied.product.verification_status).toBe('verified');
  });

  it('upgrades an external row with the fields a person confirmed', async () => {
    await query(
      pg,
      'service',
      `insert into catalog_products (id, name, brand, category, source, verification_status)
       values ($1, 'Plain', null, 'groceries', 'open_food_facts', 'external')`,
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
    );
    await query(
      pg,
      'service',
      `insert into catalog_barcodes (barcode, catalog_product_id, kind, source)
       values ('5449000000996', $1, 'unit', 'open_food_facts')`,
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
    );
    const saved = await submit(owner, shop, '5449000000996', {
      p_name: 'Coke',
      p_brand: 'Coca-Cola',
      p_category: 'beverages',
      p_package_size: '330ml',
    });
    expect(saved.created).toBe(false);
    expect(saved.product).toMatchObject({
      name: 'Coke',
      brand: 'Coca-Cola',
      verification_status: 'user_submitted',
      source: 'user',
    });
  });

  it('refuses anonymous reads and writes, and hides the catalog from non-members', async () => {
    await expect(query(pg, null, `select id from catalog_products`)).rejects.toThrow();
    await expect(
      query(pg, null, `insert into catalog_products (name, category, source, verification_status) values ('X', 'other', 'user', 'user_submitted')`)
    ).rejects.toThrow();
    expect(await query(pg, outsider, `select id from catalog_products`)).toEqual([]);
    expect(await errorCode(submit(outsider, shop, '4006381333931'))).toBe('42501');
    const visible = await query(pg, owner, `select id from catalog_products`);
    expect(visible.length).toBeGreaterThan(0);
  });

  it('keeps two shops on one catalog product with their own prices and stock', async () => {
    const catalog = await submit(owner, shop, '012345678905', {
      p_name: 'Sample Can',
      p_category: 'beverages',
      p_brand: 'Sample',
      p_package_size: '330ml',
    });
    const a = await rpc<{ id: string; selling_price: number; buying_price: number; catalog_product_id: string }>(
      pg,
      owner,
      'upsert_product',
      {
        p_id: randomUUID(),
        p_shop_id: shop,
        p_barcode: '012345678905',
        p_name: 'Sample Can',
        p_category: 'beverages',
        p_buying_price: 8,
        p_selling_price: 12,
        p_created_at: new Date().toISOString(),
        p_catalog_product_id: catalog.product.id,
      }
    );
    const b = await rpc<{ id: string; selling_price: number; buying_price: number; catalog_product_id: string }>(
      pg,
      otherOwner,
      'upsert_product',
      {
        p_id: randomUUID(),
        p_shop_id: otherShop,
        p_barcode: '012345678905',
        p_name: 'Sample Can',
        p_category: 'beverages',
        p_buying_price: 5,
        p_selling_price: 9,
        p_created_at: new Date().toISOString(),
        p_catalog_product_id: catalog.product.id,
      }
    );
    expect(a.catalog_product_id).toBe(catalog.product.id);
    expect(b.catalog_product_id).toBe(catalog.product.id);
    expect(Number(a.selling_price)).toBe(12);
    expect(Number(b.selling_price)).toBe(9);
    expect(Number(a.buying_price)).not.toBe(Number(b.buying_price));

    await stockIn(pg, owner, shop, a.id, 4);
    await stockIn(pg, otherOwner, otherShop, b.id, 1);
    const totals = await query<{ shop_id: string; quantity: number }>(
      pg,
      'service',
      `select shop_id, quantity from stock_batches where product_id in ($1, $2) order by quantity desc`,
      [a.id, b.id]
    );
    expect(totals.map((row) => Number(row.quantity))).toEqual([4, 1]);
  });

  it('gives a second shop the saved name for a non-GTIN barcode and leaves its prices empty', async () => {
    const catalog = await submit(owner, shop, 'INTERNAL-1', {
      p_name: 'House Bread',
      p_category: 'bakery',
      p_brand: null,
      p_package_size: null,
    });
    const buyer = await rpc<{ name: string; selling_price: number | null; buying_price: number | null; catalog_product_id: string }>(
      pg,
      otherOwner,
      'upsert_product',
      {
        p_id: randomUUID(),
        p_shop_id: otherShop,
        p_barcode: 'INTERNAL-1',
        p_name: 'House Bread',
        p_category: 'bakery',
        p_buying_price: null,
        p_selling_price: null,
        p_created_at: new Date().toISOString(),
        p_catalog_product_id: catalog.product.id,
      }
    );
    expect(buyer.name).toBe('House Bread');
    expect(buyer.catalog_product_id).toBe(catalog.product.id);
    expect(buyer.selling_price).toBeNull();
    expect(buyer.buying_price).toBeNull();
  });

  it('links a pack barcode without creating a second catalog product', async () => {
    const catalog = await submit(owner, shop, '6001000000004', {
      p_name: 'Rice',
      p_category: 'groceries',
      p_package_size: '1kg',
    });
    await newProduct(pg, owner, shop, '6001000000004');
    await rpc(pg, owner, 'upsert_product', {
      p_id: (await query<{ id: string }>(pg, owner, `select id from products where shop_id = $1 and barcode = '6001000000004'`, [shop]))[0].id,
      p_shop_id: shop,
      p_barcode: '6001000000004',
      p_name: 'Rice',
      p_category: 'groceries',
      p_buying_price: 10,
      p_selling_price: 15,
      p_created_at: new Date().toISOString(),
      p_catalog_product_id: catalog.product.id,
    });

    const pack = await rpc<{ kind: string; catalog_product_id: string; units_per_package: number }>(
      pg,
      owner,
      'link_catalog_barcode',
      {
        p_shop_id: shop,
        p_catalog_product_id: catalog.product.id,
        p_barcode: '16001000000001',
        p_kind: 'pack',
        p_units_per_package: 6,
      }
    );
    expect(pack.catalog_product_id).toBe(catalog.product.id);
    expect(pack.kind).toBe('pack');
    expect(Number(pack.units_per_package)).toBe(6);

    const count = await query<{ n: number }>(
      pg,
      'service',
      `select count(*)::int as n from catalog_products where id = $1`,
      [catalog.product.id]
    );
    expect(count[0].n).toBe(1);
    const codes = await query<{ kind: string }>(
      pg,
      owner,
      `select kind from catalog_barcodes where catalog_product_id = $1 order by kind`,
      [catalog.product.id]
    );
    expect(codes.map((row) => row.kind)).toEqual(['pack', 'unit']);
  });

  it('refuses a pack barcode that already belongs to another catalog product', async () => {
    const other = await submit(otherOwner, otherShop, '16001000000001', {
      p_name: 'Different rice',
      p_category: 'groceries',
    });
    expect(other.created).toBe(false);
    expect(other.product.name).not.toBe('Different rice');
  });

  it('does not let a shop member apply a verified correction', async () => {
    const refused = await rpc<{ ok: boolean; code: string }>(pg, owner, 'apply_catalog_correction', {
      p_correction_id: randomUUID(),
      p_reason: REASON,
    });
    expect(refused).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('catalog membership helper', () => {
  it('staff of a shop can submit and an inactive member cannot', async () => {
    const staff = await createUser(pg);
    await addMember(pg, owner, shop, staff, 'staff');
    const saved = await submit(staff, shop, '5012345678900', { p_name: 'Staff item', p_category: 'other' });
    expect(saved.created).toBe(true);

    await query(pg, 'service', `update shop_members set status = 'deactivated' where user_id = $1`, [staff.id]);
    expect(await errorCode(submit(staff, shop, '5012345678901'))).toBe('42501');
  });
});
