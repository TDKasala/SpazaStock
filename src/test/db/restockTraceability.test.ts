// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  addMember,
  createDatabase,
  createShop,
  createUser,
  errorCode,
  query,
  rpc,
  sell,
  stockIn,
  type User,
} from './harness';

let pg: PGlite;
let owner: User;
let staff: User;
let outsider: User;
let shop: string;
let otherShop: string;

function code(): string {
  return randomUUID().replace(/-/g, '').slice(0, 13);
}

async function stockOf(productId: string): Promise<number> {
  const rows = await query<{ n: number }>(
    pg,
    owner,
    'select coalesce(sum(quantity), 0)::int as n from public.stock_batches where product_id = $1',
    [productId]
  );
  return rows[0].n;
}

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  staff = await createUser(pg);
  outsider = await createUser(pg);
  shop = await createShop(pg, owner);
  otherShop = await createShop(pg, outsider);
  await addMember(pg, owner, shop, staff, 'staff');
}, 30_000);

afterAll(async () => {
  await pg.close();
});

describe('restock traceability', () => {
  it('restocks from zero with a new barcode, then a second delivery that leaves the first alone', async () => {
    const barcode = code();
    const product = await rpc<{ id: string }>(pg, owner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: barcode,
      p_name: 'Sunlight 500g',
      p_category: 'groceries',
      p_buying_price: 10,
      p_selling_price: 15,
      p_created_at: new Date().toISOString(),
    });
    expect(await stockOf(product.id)).toBe(0);

    const first = await stockIn(pg, staff, shop, product.id, 8, {
      expiry: '2026-12-01',
      cost: 9,
      lot: 'L-100',
      supplier: 'Metro',
    });
    expect(first.duplicate).toBe(false);
    expect(first.total_quantity).toBe(8);

    const second = await stockIn(pg, staff, shop, product.id, 5, {
      expiry: '2027-03-01',
      cost: 11,
      lot: 'L-240',
      supplier: 'Makro',
    });
    expect(second.batch.id).not.toBe(first.batch.id);
    expect(second.total_quantity).toBe(13);

    const batches = await query<{
      id: string;
      quantity: number;
      expiry_date: string;
      cost_price_per_unit: number;
      lot_number: string;
      supplier_name: string;
    }>(
      pg,
      owner,
      `select id, quantity, expiry_date::text, cost_price_per_unit, lot_number, supplier_name
       from public.stock_batches where product_id = $1 order by expiry_date`,
      [product.id]
    );
    expect(batches).toEqual([
      expect.objectContaining({
        id: first.batch.id,
        quantity: 8,
        expiry_date: '2026-12-01',
        lot_number: 'L-100',
        supplier_name: 'Metro',
      }),
      expect.objectContaining({
        id: second.batch.id,
        quantity: 5,
        expiry_date: '2027-03-01',
        lot_number: 'L-240',
        supplier_name: 'Makro',
      }),
    ]);
    expect(Number(batches[0].cost_price_per_unit)).toBe(9);
    expect(Number(batches[1].cost_price_per_unit)).toBe(11);

    const alias = code();
    const link = await rpc<{ id: string; product_id: string }>(pg, owner, 'link_product_barcode', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_product_id: product.id,
      p_packaging_id: null,
      p_barcode: alias,
    });
    const again = await stockIn(pg, staff, shop, product.id, 2, { barcodeId: link.id, lot: 'L-241' });
    expect(again.total_quantity).toBe(15);
    const still = await query<{ product_id: string }>(
      pg,
      owner,
      'select product_id from public.product_barcodes where barcode = $1 and unlinked_at is null',
      [alias]
    );
    expect(still.map((row) => row.product_id)).toEqual([product.id]);
  });

  it('receives a box of 20 and sells one unit then one box', async () => {
    const product = await rpc<{ id: string }>(pg, owner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: code(),
      p_name: 'Coke 330ml',
      p_category: 'beverages',
      p_buying_price: 8,
      p_selling_price: 12,
      p_created_at: new Date().toISOString(),
    });
    const box = await rpc<{ id: string; selling_price: number }>(pg, owner, 'create_product_packaging', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_product_id: product.id,
      p_name: 'Box',
      p_units_per_package: 20,
      p_selling_price: 200,
    });
    expect(Number(box.selling_price)).toBe(200);

    const received = await stockIn(pg, staff, shop, product.id, 40, { packagingId: box.id, packages: 2 });
    expect(received.total_quantity).toBe(40);

    const one = await sell(pg, staff, shop, [{ product_id: product.id, quantity: 1, unit_price: 12 }]);
    expect(one.stock_totals[product.id]).toBe(39);
    const wholeBox = await sell(pg, staff, shop, [{ product_id: product.id, quantity: 20, unit_price: 10 }]);
    expect(wholeBox.stock_totals[product.id]).toBe(19);
    expect(wholeBox.items[0].quantity).toBe(20);
  });

  it('sells the soonest expiry first and refuses to take expired stock', async () => {
    const product = await rpc<{ id: string }>(pg, owner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: code(),
      p_name: 'Fresh milk',
      p_category: 'dairy',
      p_buying_price: 10,
      p_selling_price: 16,
      p_created_at: new Date().toISOString(),
    });
    const soon = await stockIn(pg, owner, shop, product.id, 4, { expiry: '2026-10-20', lot: 'A' });
    const later = await stockIn(pg, owner, shop, product.id, 6, { expiry: '2026-11-01', lot: 'B' });
    const sale = await sell(pg, staff, shop, [{ product_id: product.id, quantity: 5 }], {
      soldAt: new Date('2026-10-16T10:00:00Z'),
    });
    expect(sale.items[0].allocations.map((row) => [row.batchId, row.quantityDeducted])).toEqual([
      [soon.batch.id, 4],
      [later.batch.id, 1],
    ]);

    const expired = await stockIn(pg, owner, shop, product.id, 3, { expiry: '2026-10-01', lot: 'OLD' });
    const before = await stockOf(product.id);
    const refused = await sell(pg, staff, shop, [{ product_id: product.id, quantity: before + 1 }], {
      soldAt: new Date('2026-10-16T12:00:00Z'),
    });
    expect(refused.shortfall).toBeGreaterThan(0);
    const leftover = await query<{ quantity: number }>(
      pg,
      owner,
      'select quantity from public.stock_batches where id = $1',
      [expired.batch.id]
    );
    expect(leftover[0].quantity).toBe(3);
  });

  it('keeps two similar names as two products until a barcode is linked on purpose', async () => {
    const small = await rpc<{ id: string }>(pg, owner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: code(),
      p_name: 'Oros 1L',
      p_category: 'beverages',
      p_buying_price: 20,
      p_selling_price: 28,
      p_brand: 'Oros',
      p_size: '1L',
      p_created_at: new Date().toISOString(),
    });
    const large = await rpc<{ id: string }>(pg, owner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: code(),
      p_name: 'Oros 2L',
      p_category: 'beverages',
      p_buying_price: 32,
      p_selling_price: 42,
      p_brand: 'Oros',
      p_size: '2L',
      p_created_at: new Date().toISOString(),
    });
    await stockIn(pg, owner, shop, small.id, 3);
    await stockIn(pg, owner, shop, large.id, 7);
    const names = await query<{ name: string }>(
      pg,
      owner,
      'select name from public.products where shop_id = $1 and name like $2 order by name',
      [shop, 'Oros %']
    );
    expect(names.map((row) => row.name)).toEqual(['Oros 1L', 'Oros 2L']);

    await rpc(pg, owner, 'link_product_barcode', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_product_id: small.id,
      p_packaging_id: null,
      p_barcode: code(),
    });
    expect(await stockOf(small.id)).toBe(3);
    expect(await stockOf(large.id)).toBe(7);
    expect(
      (
        await query<{ n: number }>(
          pg,
          owner,
          'select count(*)::int as n from public.products where shop_id = $1 and name like $2',
          [shop, 'Oros %']
        )
      )[0].n
    ).toBe(2);
  });

  it('unlinks a barcode without deleting the sale that used the stock', async () => {
    const product = await rpc<{ id: string }>(pg, owner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: code(),
      p_name: 'Bread loaf',
      p_category: 'bakery',
      p_buying_price: 8,
      p_selling_price: 14,
      p_created_at: new Date().toISOString(),
    });
    const alias = code();
    const link = await rpc<{ id: string }>(pg, owner, 'link_product_barcode', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_product_id: product.id,
      p_packaging_id: null,
      p_barcode: alias,
    });
    await stockIn(pg, staff, shop, product.id, 4, { barcodeId: link.id });
    const sale = await sell(pg, staff, shop, [{ product_id: product.id, quantity: 1 }]);
    await rpc(pg, owner, 'unlink_product_barcode', {
      p_shop_id: shop,
      p_barcode_id: link.id,
      p_reason: 'Wrong loaf',
      p_reverse_unsold: false,
    });
    const lines = await query<{ id: string }>(pg, owner, 'select id from public.sale_items where id = $1', [
      sale.items[0].id,
    ]);
    expect(lines).toHaveLength(1);
    const gone = await query<{ unlinked_at: string | null }>(
      pg,
      owner,
      'select unlinked_at from public.product_barcodes where id = $1',
      [link.id]
    );
    expect(gone[0].unlinked_at).not.toBeNull();
  });

  it('ignores a repeated stock-in key and a cross-shop call', async () => {
    const product = await rpc<{ id: string }>(pg, owner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: code(),
      p_name: 'Rice 2kg',
      p_category: 'groceries',
      p_buying_price: 30,
      p_selling_price: 40,
      p_created_at: new Date().toISOString(),
    });
    const key = randomUUID();
    const first = await stockIn(pg, staff, shop, product.id, 6, { key, lot: 'R1' });
    const replay = await stockIn(pg, staff, shop, product.id, 6, { key, lot: 'CHANGED' });
    expect(replay.duplicate).toBe(true);
    expect(replay.batch.id).toBe(first.batch.id);
    expect(await stockOf(product.id)).toBe(6);
    const lot = await query<{ lot_number: string }>(
      pg,
      owner,
      'select lot_number from public.stock_batches where id = $1',
      [first.batch.id]
    );
    expect(lot[0].lot_number).toBe('R1');

    const before = await stockOf(product.id);
    expect(
      await errorCode(
        stockIn(pg, outsider, shop, product.id, 9, { lot: 'NOPE' })
      )
    ).toBe('42501');
    expect(await errorCode(stockIn(pg, outsider, otherShop, product.id, 9))).toBe('P0002');
    expect(await stockOf(product.id)).toBe(before);
  });

  it('lets an owner change a pack price later without rewriting a past sale', async () => {
    const product = await rpc<{ id: string }>(pg, owner, 'upsert_product', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_barcode: code(),
      p_name: 'Eggs',
      p_category: 'dairy',
      p_buying_price: 20,
      p_selling_price: 2,
      p_created_at: new Date().toISOString(),
    });
    const tray = await rpc<{ id: string }>(pg, owner, 'create_product_packaging', {
      p_id: randomUUID(),
      p_shop_id: shop,
      p_product_id: product.id,
      p_name: 'Tray',
      p_units_per_package: 6,
      p_selling_price: 18,
    });
    await stockIn(pg, owner, shop, product.id, 6);
    const sale = await sell(pg, staff, shop, [{ product_id: product.id, quantity: 6, unit_price: 3 }]);
    expect(Number(sale.items[0].line_total)).toBe(18);

    expect(await errorCode(rpc(pg, staff, 'set_packaging_price', {
      p_shop_id: shop,
      p_packaging_id: tray.id,
      p_selling_price: 24,
    }))).toBe('42501');

    const updated = await rpc<{ selling_price: number }>(pg, owner, 'set_packaging_price', {
      p_shop_id: shop,
      p_packaging_id: tray.id,
      p_selling_price: 24,
    });
    expect(Number(updated.selling_price)).toBe(24);
    const line = await query<{ line_total: number }>(
      pg,
      owner,
      'select line_total from public.sale_items where id = $1',
      [sale.items[0].id]
    );
    expect(Number(line[0].line_total)).toBe(18);
    expect(await errorCode(rpc(pg, owner, 'set_packaging_price', {
      p_shop_id: shop,
      p_packaging_id: tray.id,
      p_selling_price: -1,
    }))).toBe('22023');
  });
});
