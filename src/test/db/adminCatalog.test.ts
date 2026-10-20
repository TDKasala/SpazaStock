// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  REASON,
  auditRows,
  bootstrapSuperadmin,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  grantAdmin,
  query,
  rpc,
  stockIn,
  type User,
} from './harness';

let pg: PGlite;
let admin: User;
let support: User;
let owner: User;
let outsider: User;
let shop: string;

type Result = { ok: boolean; code?: string; [key: string]: unknown };

beforeAll(async () => {
  pg = await createDatabase();
  admin = await createUser(pg, 'catalog-admin@spazastock.test');
  support = await createUser(pg);
  owner = await createUser(pg);
  outsider = await createUser(pg);
  await bootstrapSuperadmin(pg, admin);
  await grantAdmin(pg, admin, support, 'support');
  shop = await createShop(pg, owner, 'Catalogue shop');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('admin catalogue', () => {
  it('lets a superadmin manage identity and barcodes without touching shop stock', async () => {
    const created = await rpc<Result & { id: string; created: boolean }>(pg, admin, 'admin_save_catalog_product', {
      p_id: null,
      p_name: 'Admin Rice',
      p_brand: 'Ace',
      p_category: 'groceries',
      p_package_size: '2kg',
      p_package_quantity: 2,
      p_package_unit: 'kg',
      p_verification_status: 'user_submitted',
      p_reason: REASON,
    });
    expect(created).toMatchObject({ ok: true, created: true });
    const catalogId = created.id;

    const stored = await query<{ verification_status: string; source: string }>(
      pg,
      'service',
      `select verification_status, source from catalog_products where id = $1`,
      [catalogId]
    );
    expect(stored[0]).toEqual({ verification_status: 'verified', source: 'user' });

    for (const barcode of [
      { p_barcode: '6001110000008', p_kind: 'unit', p_units_per_package: null },
      { p_barcode: '6001110000015', p_kind: 'alternate', p_units_per_package: null },
      { p_barcode: '6001110000022', p_kind: 'pack', p_units_per_package: 6 },
    ]) {
      const linked = await rpc<Result>(pg, admin, 'admin_link_catalog_barcode', {
        p_catalog_product_id: catalogId,
        p_reason: REASON,
        ...barcode,
      });
      expect(linked.ok, barcode.p_barcode).toBe(true);
    }

    const found = await rpc<Result & { rows: Array<Record<string, unknown>> }>(pg, admin, 'admin_search_catalog', {
      p_query: '6001110000015',
    });
    const hit = found.rows.find((row) => row.id === catalogId);
    expect(hit?.name).toBe('Admin Rice');
    expect(hit).not.toHaveProperty('shop_listed');
    expect(hit).not.toHaveProperty('buying_price');
    expect(hit).not.toHaveProperty('ord');
    expect(hit?.barcodes).toHaveLength(3);

    const adopted = await rpc<{ product: { id: string; name: string; selling_price: number; buying_price: number } }>(
      pg,
      owner,
      'adopt_catalog_product',
      {
        p_id: randomUUID(),
        p_shop_id: shop,
        p_catalog_product_id: catalogId,
        p_buying_price: 10,
        p_selling_price: 15,
      }
    );
    await stockIn(pg, owner, shop, adopted.product.id, 6, { expiry: '2027-04-01' });
    const shopBarcodesBefore = await query(
      pg,
      'service',
      `select barcode from product_barcodes where product_id = $1`,
      [adopted.product.id]
    );

    const renamed = await rpc<Result>(pg, admin, 'admin_save_catalog_product', {
      p_id: catalogId,
      p_name: 'Admin Rice Updated',
      p_brand: 'Tastic',
      p_category: 'groceries',
      p_package_size: '2kg',
      p_package_quantity: 2,
      p_package_unit: 'kg',
      p_verification_status: 'verified',
      p_reason: REASON,
    });
    expect(renamed.ok).toBe(true);

    const shopProduct = await query<{ name: string; buying_price: number; selling_price: number }>(
      pg,
      'service',
      `select name, buying_price, selling_price from products where id = $1`,
      [adopted.product.id]
    );
    expect(shopProduct[0].name).toBe('Admin Rice');
    expect(Number(shopProduct[0].buying_price)).toBe(10);
    expect(Number(shopProduct[0].selling_price)).toBe(15);
    const batches = await query<{ quantity: number; expiry_date: string }>(
      pg,
      'service',
      `select quantity, expiry_date::text as expiry_date from stock_batches where product_id = $1`,
      [adopted.product.id]
    );
    expect(batches.map((row) => ({ quantity: Number(row.quantity), expiry_date: row.expiry_date }))).toEqual([
      { quantity: 6, expiry_date: '2027-04-01' },
    ]);

    expect((await rpc<Result>(pg, admin, 'admin_unlink_catalog_barcode', {
      p_barcode: '6001110000015',
      p_reason: REASON,
    })).ok).toBe(true);
    expect(
      await query(pg, 'service', `select barcode from product_barcodes where product_id = $1`, [adopted.product.id])
    ).toEqual(shopBarcodesBefore);

    const imagePath = `catalog/${catalogId}.webp`;
    await pg.query(`insert into storage.objects (bucket_id, name) values ('product-images', $1)`, [imagePath]);
    const pictured = await rpc<Result & { image_path: string }>(pg, admin, 'admin_set_catalog_image', {
      p_id: catalogId,
      p_image_path: imagePath,
      p_reason: REASON,
    });
    expect(pictured).toMatchObject({ ok: true, image_path: imagePath });

    const other = await rpc<Result & { id: string }>(pg, admin, 'admin_save_catalog_product', {
      p_id: null,
      p_name: 'Other Rice',
      p_brand: null,
      p_category: 'groceries',
      p_package_size: null,
      p_package_quantity: null,
      p_package_unit: null,
      p_verification_status: 'verified',
      p_reason: REASON,
    });
    const clash = await rpc<Result>(pg, admin, 'admin_link_catalog_barcode', {
      p_catalog_product_id: other.id,
      p_barcode: '6001110000008',
      p_kind: 'unit',
      p_units_per_package: null,
      p_reason: REASON,
    });
    expect(clash).toEqual({ ok: false, code: 'conflict' });
    const denied = await auditRows(pg, { actor: admin, action: 'catalog.barcode', outcome: 'denied' });
    expect(denied.length).toBeGreaterThan(0);

    expect(
      await query(
        pg,
        'service',
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'catalog_products'
           and column_name in ('buying_price', 'quantity', 'expiry_date')`
      )
    ).toEqual([]);
  });

  it('refuses shop members, support and outsiders', async () => {
    const id = randomUUID();
    const save = {
      p_id: null,
      p_name: 'Hidden',
      p_brand: null,
      p_category: 'other',
      p_package_size: null,
      p_package_quantity: null,
      p_package_unit: null,
      p_verification_status: 'verified',
      p_reason: REASON,
    };
    for (const caller of [owner, support, outsider]) {
      expect((await rpc<Result>(pg, caller, 'admin_search_catalog', { p_query: 'Rice' })).ok).toBe(false);
      expect((await rpc<Result>(pg, caller, 'admin_save_catalog_product', save)).code).toBe('forbidden');
    }
    expect(await errorCode(rpc(pg, null, 'admin_get_catalog_product', { p_id: id }))).toBe('42501');
    expect(await errorCode(rpc(pg, admin, 'admin_save_catalog_product', { ...save, p_reason: 'short' }))).toBe('22023');
  });
});
