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

async function picturedProduct(name: string, barcode: string, common: boolean): Promise<{ id: string; imagePath: string }> {
  const id = randomUUID();
  const imagePath = `catalog/${id}.webp`;
  await query(
    pg,
    'service',
    `insert into public.catalog_products
       (id, name, brand, category, package_size, source, verification_status, common, image_path)
     values ($1, $2, 'Ace', 'groceries', '2.5kg', 'user', 'verified', $3, $4)`,
    [id, name, common, imagePath]
  );
  await query(
    pg,
    'service',
    `insert into public.catalog_barcodes (barcode, catalog_product_id, kind, source)
     values ($1, $2, 'unit', 'user')`,
    [barcode, id]
  );
  return { id, imagePath };
}

async function shopImage(shopId: string, catalogProductId: string): Promise<string | null> {
  const rows = await query<{ image_path: string | null }>(
    pg,
    'service',
    `select image_path from public.products
     where shop_id = $1 and catalog_product_id = $2 and archived_at is null`,
    [shopId, catalogProductId]
  );
  return rows[0]?.image_path ?? null;
}

describe('catalogue image pointer', () => {
  it('stores the shared path on a new shop row and leaves an existing picture alone', async () => {
    const maize = await picturedProduct('Pictured maize', '6001087354101', false);
    const oil = await picturedProduct('External oil', '6001087354102', false);
    await query(pg, 'service', 'update public.catalog_products set image_path = null, image_url = $2 where id = $1', [
      oil.id,
      'https://example.com/oil.jpg',
    ]);

    const adopted = await rpc<{ created: boolean; product: { image_path: string | null } }>(
      pg,
      ownerA,
      'adopt_catalog_product',
      {
        p_id: randomUUID(),
        p_shop_id: shopA,
        p_catalog_product_id: maize.id,
        p_buying_price: 4,
        p_selling_price: 7,
      }
    );
    expect(adopted.created).toBe(true);
    expect(adopted.product.image_path).toBe(maize.imagePath);
    expect(await shopImage(shopA, maize.id)).toBe(maize.imagePath);

    const shopPicture = `${shopA}/0123456789abcdef0123456789abcdef.webp`;
    await query(
      pg,
      'service',
      'update public.products set image_path = $1 where shop_id = $2 and catalog_product_id = $3',
      [shopPicture, shopA, maize.id]
    );
    const again = await rpc<{ created: boolean; product: { image_path: string | null; buying_price: number } }>(
      pg,
      ownerA,
      'adopt_catalog_product',
      {
        p_id: randomUUID(),
        p_shop_id: shopA,
        p_catalog_product_id: maize.id,
        p_buying_price: null,
        p_selling_price: null,
      }
    );
    expect(again.created).toBe(false);
    expect(again.product.image_path).toBe(shopPicture);
    expect(Number(again.product.buying_price)).toBe(4);

    const urlOnly = await rpc<{ product: { image_path: string | null } }>(pg, ownerA, 'adopt_catalog_product', {
      p_id: randomUUID(),
      p_shop_id: shopA,
      p_catalog_product_id: oil.id,
      p_buying_price: null,
      p_selling_price: null,
    });
    expect(urlOnly.product.image_path).toBeNull();

    const [{ copies }] = await query<{ copies: number }>(
      pg,
      'service',
      'select count(*)::int as copies from storage.objects'
    );
    expect(copies).toBe(0);
    const [{ batches }] = await query<{ batches: number }>(
      pg,
      'service',
      'select count(*)::int as batches from public.stock_batches'
    );
    expect(batches).toBe(0);
  });

  it('hides a product only for the shop that already has it', async () => {
    const maize = await query<{ id: string; name: string }>(
      pg,
      'service',
      `select id, name from public.catalog_products where name = 'Pictured maize'`
    );
    const hidden = await rpc<{ total: number; items: { id: string }[] }>(pg, ownerA, 'search_catalog', {
      p_shop_id: shopA,
      p_query: 'Pictured maize',
      p_in_shop: false,
    });
    expect(hidden.total).toBe(0);
    expect(hidden.items).toEqual([]);

    const visible = await rpc<{ total: number; items: { id: string }[] }>(pg, ownerB, 'search_catalog', {
      p_shop_id: shopB,
      p_query: 'Pictured maize',
      p_in_shop: false,
    });
    expect(visible.items.map((item) => item.id)).toEqual([maize[0].id]);

    const kept = await rpc<{ items: { id: string }[] }>(pg, ownerA, 'search_catalog', {
      p_shop_id: shopA,
      p_query: 'Pictured maize',
    });
    expect(kept.items.map((item) => item.id)).toEqual([maize[0].id]);

    const added = await rpc<{ created: boolean; product: { image_path: string | null; shop_id: string } }>(
      pg,
      ownerB,
      'adopt_catalog_product',
      {
        p_id: randomUUID(),
        p_shop_id: shopB,
        p_catalog_product_id: maize[0].id,
        p_buying_price: 8,
        p_selling_price: 12,
      }
    );
    expect(added.created).toBe(true);
    expect(added.product.shop_id).toBe(shopB);
    expect(added.product.image_path).toBe(`catalog/${maize[0].id}.webp`);
    expect(await shopImage(shopA, maize[0].id)).toBe(`${shopA}/0123456789abcdef0123456789abcdef.webp`);
  });

  it('copies the shared path when a shop confirms or sells a pictured product', async () => {
    const rice = await picturedProduct('Pictured rice', '6001087354103', true);
    const sugar = await picturedProduct('Pictured sugar', '6001087354104', true);

    const review = await rpc<{ items: { id: string; image_path: string | null; image_url: string | null }[] }>(
      pg,
      ownerA,
      'list_shop_catalog_review',
      { p_shop_id: shopA, p_query: 'Pictured rice' }
    );
    expect(review.items[0]).toMatchObject({ id: rice.id, image_path: rice.imagePath, image_url: null });

    await rpc(pg, ownerA, 'review_shop_catalog', {
      p_shop_id: shopA,
      p_decisions: [{ catalog_product_id: rice.id, decision: 'sell', buying_price: 3, selling_price: 5 }],
    });
    expect(await shopImage(shopA, rice.id)).toBe(rice.imagePath);

    await rpc(pg, ownerB, 'confirm_shop_catalog', {
      p_shop_id: shopB,
      p_selections: [{ catalog_product_id: sugar.id, buying_price: 2, selling_price: 4 }],
    });
    expect(await shopImage(shopB, sugar.id)).toBe(sugar.imagePath);

    const [{ copies }] = await query<{ copies: number }>(
      pg,
      'service',
      'select count(*)::int as copies from storage.objects'
    );
    expect(copies).toBe(0);
  });
});
