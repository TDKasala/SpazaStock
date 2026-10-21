// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createDatabase, createShop, createUser, query, rpc, sell, stockIn, type User } from './harness';

let pg: PGlite;
let ownerA: User;
let ownerB: User;

const UNIT = '6009900000001';
const ALTERNATE = '6009900000002';
const PACK = '6009900000003';

beforeAll(async () => {
  pg = await createDatabase();
  ownerA = await createUser(pg);
  ownerB = await createUser(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe('catalogue inventory', () => {
  it('keeps one shop product, its batches, and its prices when the catalogue is confirmed again', async () => {
    const catalogId = randomUUID();
    await query(
      pg,
      'service',
      `insert into public.catalog_products
         (id, name, brand, category, package_size, source, verification_status, common)
       values ($1, 'Sunflower oil', 'Sun', 'groceries', '750ml', 'user', 'verified', true)`,
      [catalogId]
    );
    await query(
      pg,
      'service',
      `insert into public.catalog_barcodes (barcode, catalog_product_id, kind, units_per_package, source)
       values ($1, $4, 'unit', null, 'user'),
              ($2, $4, 'alternate', null, 'user'),
              ($3, $4, 'pack', 6, 'user')`,
      [UNIT, ALTERNATE, PACK, catalogId]
    );

    const shopA = await createShop(pg, ownerA, 'Shop A');
    const shopB = await createShop(pg, ownerB, 'Shop B');

    await rpc(pg, ownerA, 'review_shop_catalog', {
      p_shop_id: shopA,
      p_decisions: [{ catalog_product_id: catalogId, decision: 'sell', buying_price: 10, selling_price: 15 }],
    });

    const [product] = await query<{ id: string; barcode: string; buying_price: string; selling_price: string }>(
      pg,
      ownerA,
      `select id, barcode, buying_price::text, selling_price::text
       from public.products where shop_id = $1 and catalog_product_id = $2`,
      [shopA, catalogId]
    );
    expect(product.barcode).toBe(UNIT);
    expect(product).toMatchObject({ buying_price: '10.00', selling_price: '15.00' });

    const links = await query<{ barcode: string; units_per_package: number | null; packaging_id: string | null }>(
      pg,
      ownerA,
      `select b.barcode, g.units_per_package, b.packaging_id
       from public.product_barcodes b
       left join public.product_packagings g on g.id = b.packaging_id
       where b.product_id = $1 and b.unlinked_at is null
       order by b.barcode`,
      [product.id]
    );
    expect(links).toEqual([
      { barcode: ALTERNATE, units_per_package: null, packaging_id: null },
      { barcode: PACK, units_per_package: 6, packaging_id: expect.any(String) },
    ]);

    const early = await stockIn(pg, ownerA, shopA, product.id, 4, { expiry: '2027-01-15' });
    const packLink = links[1];
    const later = await stockIn(pg, ownerA, shopA, product.id, 6, {
      expiry: '2027-06-01',
      packagingId: packLink.packaging_id,
      packages: 1,
      barcodeId: (
        await query<{ id: string }>(
          pg,
          ownerA,
          'select id from public.product_barcodes where product_id = $1 and barcode = $2',
          [product.id, PACK]
        )
      )[0].id,
    });

    const sale = await sell(pg, ownerA, shopA, [{ product_id: product.id, quantity: 1, unit_price: 15 }]);
    expect(sale.items[0].allocations.map((row) => [row.batchId, row.quantityDeducted])).toEqual([[early.batch.id, 1]]);
    expect(sale.stock_totals[product.id]).toBe(9);

    const batches = async (shopId: string, productId: string) =>
      query<{ expiry_date: string; quantity: number }>(
        pg,
        'service',
        `select expiry_date::text, quantity
         from public.stock_batches
         where shop_id = $1 and product_id = $2
         order by expiry_date`,
        [shopId, productId]
      );
    expect(await batches(shopA, product.id)).toEqual([
      { expiry_date: '2027-01-15', quantity: 3 },
      { expiry_date: '2027-06-01', quantity: 6 },
    ]);
    expect(later.batch.id).not.toBe(early.batch.id);

    await rpc(pg, ownerA, 'review_shop_catalog', {
      p_shop_id: shopA,
      p_decisions: [{ catalog_product_id: catalogId, decision: 'sell', buying_price: 99, selling_price: 199 }],
    });
    await rpc(pg, ownerA, 'upsert_product', {
      p_id: product.id,
      p_shop_id: shopA,
      p_barcode: UNIT,
      p_name: 'Renamed by sync',
      p_category: 'groceries',
      p_buying_price: 1,
      p_selling_price: 2,
      p_created_at: new Date().toISOString(),
      p_catalog_product_id: catalogId,
    });

    const [kept] = await query<{
      name: string;
      buying_price: string;
      selling_price: string;
      n: number;
    }>(
      pg,
      ownerA,
      `select name, buying_price::text, selling_price::text,
              (select count(*)::int from public.products p2
                where p2.shop_id = products.shop_id and p2.catalog_product_id = products.catalog_product_id
                  and p2.archived_at is null) as n
       from public.products where id = $1`,
      [product.id]
    );
    expect(kept).toEqual({ name: 'Sunflower oil', buying_price: '10.00', selling_price: '15.00', n: 1 });
    expect(await batches(shopA, product.id)).toEqual([
      { expiry_date: '2027-01-15', quantity: 3 },
      { expiry_date: '2027-06-01', quantity: 6 },
    ]);

    await rpc(pg, ownerB, 'review_shop_catalog', {
      p_shop_id: shopB,
      p_decisions: [{ catalog_product_id: catalogId, decision: 'sell', buying_price: 8.5, selling_price: 11 }],
    });
    const [other] = await query<{ id: string; buying_price: string; selling_price: string }>(
      pg,
      ownerB,
      `select id, buying_price::text, selling_price::text
       from public.products where shop_id = $1 and catalog_product_id = $2`,
      [shopB, catalogId]
    );
    expect(other).toMatchObject({ buying_price: '8.50', selling_price: '11.00' });
    const otherBatch = await stockIn(pg, ownerB, shopB, other.id, 2, { expiry: '2027-03-01' });
    const otherSale = await sell(pg, ownerB, shopB, [{ product_id: other.id, quantity: 1, unit_price: 11 }]);
    expect(otherSale.stock_totals[other.id]).toBe(1);
    expect(otherBatch.batch.quantity).toBe(2);

    const seenByA = await query<{ n: number }>(
      pg,
      ownerA,
      'select count(*)::int as n from public.products where shop_id = $1',
      [shopB]
    );
    expect(seenByA[0].n).toBe(0);
    expect(await batches(shopA, product.id)).toEqual([
      { expiry_date: '2027-01-15', quantity: 3 },
      { expiry_date: '2027-06-01', quantity: 6 },
    ]);
    expect(await batches(shopB, other.id)).toEqual([{ expiry_date: '2027-03-01', quantity: 1 }]);

    await rpc(pg, ownerA, 'review_shop_catalog', {
      p_shop_id: shopA,
      p_decisions: [{ catalog_product_id: catalogId, decision: 'hide' }],
    });
    const [hidden] = await query<{ listed: boolean; buying_price: string; selling_price: string }>(
      pg,
      ownerA,
      'select listed, buying_price::text, selling_price::text from public.products where id = $1',
      [product.id]
    );
    expect(hidden).toEqual({ listed: false, buying_price: '10.00', selling_price: '15.00' });
    expect(await batches(shopA, product.id)).toEqual([
      { expiry_date: '2027-01-15', quantity: 3 },
      { expiry_date: '2027-06-01', quantity: 6 },
    ]);

    await rpc(pg, ownerA, 'review_shop_catalog', {
      p_shop_id: shopA,
      p_decisions: [{ catalog_product_id: catalogId, decision: 'sell', buying_price: 50, selling_price: 60 }],
    });
    const [shown] = await query<{ listed: boolean; buying_price: string; selling_price: string }>(
      pg,
      ownerA,
      'select listed, buying_price::text, selling_price::text from public.products where id = $1',
      [product.id]
    );
    expect(shown).toEqual({ listed: true, buying_price: '10.00', selling_price: '15.00' });
    expect(await batches(shopA, product.id)).toEqual([
      { expiry_date: '2027-01-15', quantity: 3 },
      { expiry_date: '2027-06-01', quantity: 6 },
    ]);

    const columns = await query<{ column_name: string }>(
      pg,
      'service',
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'catalog_products'
         and column_name in ('buying_price', 'selling_price', 'quantity', 'expiry_date')`
    );
    expect(columns).toEqual([]);
  });
});
