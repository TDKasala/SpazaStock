// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createDatabase, createShop, createUser, query, rpc, type User } from './harness';

let pg: PGlite;
let ownerA: User;
let ownerB: User;
let shopA: string;
let shopB: string;

beforeAll(async () => {
  pg = await createDatabase();
  ownerA = await createUser(pg);
  ownerB = await createUser(pg);
  shopA = await createShop(pg, ownerA, 'Shop A');
  shopB = await createShop(pg, ownerB, 'Shop B');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

async function addCatalog(name: string, barcode: string): Promise<string> {
  const id = randomUUID();
  await query(
    pg,
    'service',
    `insert into public.catalog_products
       (id, name, brand, category, source, verification_status, common)
     values ($1, $2, 'Ace', 'groceries', 'user', 'verified', false)`,
    [id, name]
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

describe('catalogue search indexes', () => {
  it('pages a name search, finds a barcode, and keeps the other shop’s list', async () => {
    const apple = await addCatalog('Apple juice', '6001111111111');
    await addCatalog('Apricot jam', '6001111111112');
    const bread = await addCatalog('Brown bread', '6002222222222');

    const first = await rpc<{ total: number; items: { id: string; name: string }[] }>(pg, ownerA, 'search_catalog', {
      p_shop_id: shopA,
      p_query: 'Ap',
      p_limit: 1,
      p_offset: 0,
    });
    const second = await rpc<{ total: number; items: { id: string; name: string }[] }>(pg, ownerA, 'search_catalog', {
      p_shop_id: shopA,
      p_query: 'Ap',
      p_limit: 1,
      p_offset: 1,
    });
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(first.items.map((item) => item.name)).toEqual(['Apple juice']);
    expect(second.items.map((item) => item.name)).toEqual(['Apricot jam']);
    expect(first.items[0].id).not.toBe(second.items[0].id);

    const byBarcode = await rpc<{ items: { id: string }[] }>(pg, ownerA, 'search_catalog', {
      p_shop_id: shopA,
      p_query: '6002222222222',
    });
    expect(byBarcode.items.map((item) => item.id)).toEqual([bread]);

    const byFragment = await rpc<{ items: { name: string }[] }>(pg, ownerA, 'search_catalog', {
      p_shop_id: shopA,
      p_query: 'read',
    });
    expect(byFragment.items.map((item) => item.name)).toEqual(['Brown bread']);

    await rpc(pg, ownerA, 'adopt_catalog_product', {
      p_id: randomUUID(),
      p_shop_id: shopA,
      p_catalog_product_id: apple,
      p_buying_price: null,
      p_selling_price: null,
    });
    const hidden = await rpc<{ items: { id: string }[] }>(pg, ownerA, 'search_catalog', {
      p_shop_id: shopA,
      p_query: 'Apple',
      p_in_shop: false,
    });
    const stillThere = await rpc<{ items: { id: string }[] }>(pg, ownerB, 'search_catalog', {
      p_shop_id: shopB,
      p_query: 'Apple',
      p_in_shop: false,
    });
    expect(hidden.items).toEqual([]);
    expect(stillThere.items.map((item) => item.id)).toEqual([apple]);

    const indexes = await query<{ indexname: string }>(
      pg,
      'service',
      `select indexname from pg_indexes
       where schemaname = 'public'
         and indexname in (
           'catalog_products_common_name_idx',
           'catalog_products_common_category_name_idx'
         )
       order by indexname`
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      'catalog_products_common_category_name_idx',
      'catalog_products_common_name_idx',
    ]);

    const extension = await query<{ extname: string }>(
      pg,
      'service',
      `select extname from pg_extension where extname = 'pg_trgm'`
    );
    if (extension.length > 0) {
      const trigram = await query<{ indexname: string }>(
        pg,
        'service',
        `select indexname from pg_indexes
         where indexname in (
           'catalog_products_name_trgm_idx',
           'catalog_products_brand_trgm_idx',
           'catalog_barcodes_barcode_trgm_idx'
         )
         order by indexname`
      );
      expect(trigram.map((row) => row.indexname)).toEqual([
        'catalog_barcodes_barcode_trgm_idx',
        'catalog_products_brand_trgm_idx',
        'catalog_products_name_trgm_idx',
      ]);
    }
  });
});
