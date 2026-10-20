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

  it('stores the first shared picture and leaves a later one alone', async () => {
    const saved = await submit(owner, shop, '6009668781362', { p_name: 'Excella', p_category: 'groceries', p_brand: null });
    const catalogId = saved.product.id;
    const product = await rpc<{ id: string }>(pg, owner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: '6009668781362',
      p_name: 'Excella',
      p_category: 'groceries',
      p_buying_price: null,
      p_selling_price: null,
      p_created_at: new Date().toISOString(),
      p_catalog_product_id: catalogId,
    });
    const path = `catalog/${catalogId}.webp`;
    await query(pg, 'service', `insert into storage.objects (bucket_id, name) values ('product-images', $1)`, [path]);

    expect(await rpc<string>(pg, owner, 'set_catalog_image', {
      p_shop_id: shop,
      p_catalog_product_id: catalogId,
      p_image_path: path,
    })).toBe(path);

    const otherPath = `catalog/${catalogId}.jpg`;
    await query(pg, 'service', `insert into storage.objects (bucket_id, name) values ('product-images', $1)`, [otherPath]);
    expect(await rpc<string>(pg, owner, 'set_catalog_image', {
      p_shop_id: shop,
      p_catalog_product_id: catalogId,
      p_image_path: otherPath,
    })).toBe(path);

    expect(await errorCode(rpc(pg, otherOwner, 'set_catalog_image', {
      p_shop_id: otherShop,
      p_catalog_product_id: catalogId,
      p_image_path: otherPath,
    }))).toBe('42501');

    expect(await errorCode(rpc(pg, outsider, 'set_catalog_image', {
      p_shop_id: shop,
      p_catalog_product_id: catalogId,
      p_image_path: path,
    }))).toBe('42501');

    expect(await errorCode(rpc(pg, owner, 'set_catalog_image', {
      p_shop_id: shop,
      p_catalog_product_id: catalogId,
      p_image_path: `catalog/${randomUUID()}.webp`,
    }))).toBe('22023');

    expect(product.id).toBeTruthy();
  });

  it('does not let a shop member apply a verified correction', async () => {
    const refused = await rpc<{ ok: boolean; code: string }>(pg, owner, 'apply_catalog_correction', {
      p_correction_id: randomUUID(),
      p_reason: REASON,
    });
    expect(refused).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('lets a new shop discover a master product and keep its own prices, barcodes and batches', async () => {
    const catalog = await submit(owner, shop, '6001087354019', {
      p_name: 'Shared Maize',
      p_category: 'groceries',
      p_brand: 'Ace',
      p_package_size: '2.5kg',
    });
    await rpc(pg, owner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: '6001087354019',
      p_name: 'Shared Maize',
      p_category: 'groceries',
      p_buying_price: 20,
      p_selling_price: 28,
      p_created_at: new Date().toISOString(),
      p_catalog_product_id: catalog.product.id,
    });
    await rpc(pg, owner, 'link_catalog_barcode', {
      p_shop_id: shop,
      p_catalog_product_id: catalog.product.id,
      p_barcode: '6001087354018',
      p_kind: 'alternate',
    });
    await rpc(pg, owner, 'link_catalog_barcode', {
      p_shop_id: shop,
      p_catalog_product_id: catalog.product.id,
      p_barcode: '16001087354016',
      p_kind: 'pack',
      p_units_per_package: 12,
    });

    const freshOwner = await createUser(pg);
    const fresh = await createShop(pg, freshOwner, 'New catalogue shop');
    const found = await rpc<{
      items: Array<{ id: string; shop_product_id: string | null; name: string }>;
      total: number;
    }>(pg, freshOwner, 'search_catalog', { p_shop_id: fresh, p_query: 'Shared Maize' });
    const hit = found.items.find((item) => item.id === catalog.product.id);
    expect(hit?.name).toBe('Shared Maize');
    expect(hit?.shop_product_id).toBeNull();
    expect(await query(pg, freshOwner, `select id from products where shop_id = $1`, [fresh])).toEqual([]);
    expect(await query(pg, freshOwner, `select id from stock_batches where shop_id = $1`, [fresh])).toEqual([]);

    const literalPercent = await rpc<{ items: Array<{ name: string }> }>(pg, freshOwner, 'search_catalog', {
      p_shop_id: fresh,
      p_query: '%',
    });
    expect(literalPercent.items.some((item) => item.name === 'Shared Maize')).toBe(false);

    expect(await errorCode(rpc(pg, outsider, 'search_catalog', { p_shop_id: fresh, p_query: 'Maize' }))).toBe('42501');
    await expect(rpc(pg, null, 'search_catalog', { p_shop_id: fresh, p_query: 'Maize' })).rejects.toThrow();

    const adopted = await rpc<{
      created: boolean;
      product: { id: string; selling_price: number; buying_price: number; catalog_product_id: string };
      barcodes: Array<{ barcode: string }>;
      packagings: Array<{ units_per_package: number; selling_price: number | null }>;
    }>(pg, freshOwner, 'adopt_catalog_product', {
      p_id: randomUUID(),
      p_shop_id: fresh,
      p_catalog_product_id: catalog.product.id,
      p_buying_price: 4,
      p_selling_price: 7,
    });
    expect(adopted.created).toBe(true);
    expect(adopted.product.catalog_product_id).toBe(catalog.product.id);
    expect(Number(adopted.product.selling_price)).toBe(7);
    expect(Number(adopted.product.buying_price)).toBe(4);
    expect(adopted.barcodes.map((row) => row.barcode).sort()).toEqual(['16001087354016', '6001087354018']);
    expect(adopted.packagings).toHaveLength(1);
    expect(Number(adopted.packagings[0].units_per_package)).toBe(12);
    expect(adopted.packagings[0].selling_price).toBeNull();
    expect(await query(pg, 'service', `select id from stock_batches where shop_id = $1`, [fresh])).toEqual([]);
    expect(
      await query(pg, otherOwner, `select id from product_barcodes where shop_id = $1 and barcode = '6001087354018'`, [
        otherShop,
      ])
    ).toEqual([]);

    const second = await rpc<{ created: boolean; product: { id: string; selling_price: number } }>(
      pg,
      otherOwner,
      'adopt_catalog_product',
      {
        p_id: randomUUID(),
        p_shop_id: otherShop,
        p_catalog_product_id: catalog.product.id,
        p_buying_price: 3,
        p_selling_price: 6,
      }
    );
    expect(second.created).toBe(true);
    expect(Number(second.product.selling_price)).toBe(6);
    await stockIn(pg, freshOwner, fresh, adopted.product.id, 5, { expiry: '2027-01-15' });
    await stockIn(pg, otherOwner, otherShop, second.product.id, 2, { expiry: '2027-08-01' });
    const batches = await query<{ quantity: number; expiry_date: string }>(
      pg,
      'service',
      `select quantity, expiry_date::text as expiry_date from stock_batches where product_id in ($1, $2) order by quantity desc`,
      [adopted.product.id, second.product.id]
    );
    expect(batches.map((row) => ({ quantity: Number(row.quantity), expiry_date: row.expiry_date }))).toEqual([
      { quantity: 5, expiry_date: '2027-01-15' },
      { quantity: 2, expiry_date: '2027-08-01' },
    ]);
    expect(
      await query(
        pg,
        'service',
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'catalog_products'
           and column_name in ('buying_price', 'selling_price', 'quantity', 'expiry_date')`
      )
    ).toEqual([]);
    expect(
      (await query<{ n: number }>(pg, 'service', `select count(*)::int as n from catalog_products where id = $1`, [
        catalog.product.id,
      ]))[0].n
    ).toBe(1);

    const replay = await rpc<{ created: boolean; product: { id: string; selling_price: number } }>(
      pg,
      freshOwner,
      'adopt_catalog_product',
      {
        p_id: randomUUID(),
        p_shop_id: fresh,
        p_catalog_product_id: catalog.product.id,
        p_buying_price: 99,
        p_selling_price: 99,
      }
    );
    expect(replay.created).toBe(false);
    expect(replay.product.id).toBe(adopted.product.id);
    expect(Number(replay.product.selling_price)).toBe(7);

    await query(pg, 'service', `update products set archived_at = now() where id = $1`, [adopted.product.id]);
    const hidden = await rpc<{ items: Array<{ id: string; shop_product_id: string | null }> }>(
      pg,
      freshOwner,
      'search_catalog',
      { p_shop_id: fresh, p_query: 'Shared Maize' }
    );
    expect(hidden.items.find((item) => item.id === catalog.product.id)?.shop_product_id).toBeNull();
    const archivedAdopt = await rpc<{ created: boolean; product: { id: string; archived_at: string | null; selling_price: number } }>(
      pg,
      freshOwner,
      'adopt_catalog_product',
      {
        p_id: randomUUID(),
        p_shop_id: fresh,
        p_catalog_product_id: catalog.product.id,
        p_buying_price: 1,
        p_selling_price: 1,
      }
    );
    expect(archivedAdopt.created).toBe(false);
    expect(archivedAdopt.product.id).toBe(adopted.product.id);
    expect(archivedAdopt.product.archived_at).toBeTruthy();
    expect(Number(archivedAdopt.product.selling_price)).toBe(7);
    expect(
      (await query<{ n: number }>(
        pg,
        'service',
        `select count(*)::int as n from products where shop_id = $1 and catalog_product_id = $2`,
        [fresh, catalog.product.id]
      ))[0].n
    ).toBe(1);
  });

  it('hides correction authorship and keeps other shops from reading a correction they do not use', async () => {
    const saved = await submit(owner, shop, '6009870000004', { p_name: 'Verified Soap', p_category: 'personal_care' });
    await query(
      pg,
      'service',
      `update catalog_products set verification_status = 'verified' where id = $1`,
      [saved.product.id]
    );
    const corrected = await submit(owner, shop, '6009870000004', { p_name: 'Soap Bar' });
    expect(corrected.correction_id).toBeTruthy();

    expect(
      await query(pg, otherOwner, `select proposed_name from catalog_corrections where id = $1`, [corrected.correction_id])
    ).toEqual([]);
    expect(await errorCode(query(pg, owner, `select shop_id from catalog_corrections where id = $1`, [corrected.correction_id]))).toBe(
      '42501'
    );
    expect(
      await errorCode(query(pg, owner, `select submitted_by from catalog_corrections where id = $1`, [corrected.correction_id]))
    ).toBe('42501');

    await rpc(pg, otherOwner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: otherShop,
      p_barcode: '6009870000004',
      p_name: 'Verified Soap',
      p_category: 'personal_care',
      p_buying_price: 2,
      p_selling_price: 3,
      p_created_at: new Date().toISOString(),
      p_catalog_product_id: saved.product.id,
    });
    const visible = await query<{ proposed_name: string }>(
      pg,
      otherOwner,
      `select proposed_name from catalog_corrections where id = $1`,
      [corrected.correction_id]
    );
    expect(visible[0]?.proposed_name).toBe('Soap Bar');
    expect(
      await errorCode(query(pg, otherOwner, `select shop_id from catalog_corrections where id = $1`, [corrected.correction_id]))
    ).toBe('42501');
  });

  it('lets a suspended shop search and refuses adopt', async () => {
    const catalog = await submit(owner, shop, '6001110000007', { p_name: 'Suspended Oil', p_category: 'groceries' });
    const member = await createUser(pg);
    const suspended = await createShop(pg, member, 'Suspended catalogue shop');
    await rpc(pg, admin, 'admin_set_shop_status', { p_shop_id: suspended, p_status: 'suspended', p_reason: REASON });
    const found = await rpc<{ items: Array<{ id: string }> }>(pg, member, 'search_catalog', {
      p_shop_id: suspended,
      p_query: 'Suspended Oil',
    });
    expect(found.items.some((item) => item.id === catalog.product.id)).toBe(true);
    expect(
      await errorCode(
        rpc(pg, member, 'adopt_catalog_product', {
          p_id: randomUUID(),
          p_shop_id: suspended,
          p_catalog_product_id: catalog.product.id,
          p_buying_price: 1,
          p_selling_price: 2,
        })
      )
    ).toBe('SP001');
    expect(await query(pg, member, `select id from products where shop_id = $1`, [suspended])).toEqual([]);
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

  it('does not let staff apply a catalogue correction', async () => {
    const staff = await createUser(pg);
    await addMember(pg, owner, shop, staff, 'staff');
    const refused = await rpc<{ ok: boolean; code: string }>(pg, staff, 'apply_catalog_correction', {
      p_correction_id: randomUUID(),
      p_reason: REASON,
    });
    expect(refused).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
