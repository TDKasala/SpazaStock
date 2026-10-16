// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { addMember, createDatabase, createShop, createUser, errorCode, newProduct, query, rpc, type User } from './harness';

let pg: PGlite;
let owner: User;
let manager: User;
let staff: User;
let outsider: User;
let shop: string;
let otherShop: string;

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg);
  manager = await createUser(pg);
  staff = await createUser(pg);
  outsider = await createUser(pg);
  shop = await createShop(pg, owner);
  otherShop = await createShop(pg, outsider);
  await addMember(pg, owner, shop, manager, 'manager');
  await addMember(pg, owner, shop, staff, 'staff');
}, 30_000);

afterAll(async () => {
  await pg.close();
});

describe('minimum stock', () => {
  it('lets an owner set and clear the minimum, and a later edit does not wipe it', async () => {
    const product = await newProduct(pg, owner, shop);
    const set = await rpc<{ id: string; min_stock_units: number | null }>(pg, owner, 'set_product_min_stock', {
      p_shop_id: shop,
      p_product_id: product.id,
      p_min_stock: 4,
    });
    expect(set.min_stock_units).toBe(4);

    await rpc(pg, owner, 'update_product', {
      p_shop_id: shop,
      p_product_id: product.id,
      p_barcode: product.barcode,
      p_name: 'Brown bread',
      p_category: 'bakery',
      p_buying_price: 12,
      p_selling_price: 18.5,
    });
    const [row] = await query<{ min_stock_units: number | null; name: string }>(
      pg,
      owner,
      'select name, min_stock_units from public.products where id = $1',
      [product.id]
    );
    expect(row).toMatchObject({ name: 'Brown bread', min_stock_units: 4 });

    const cleared = await rpc<{ min_stock_units: number | null }>(pg, manager, 'set_product_min_stock', {
      p_shop_id: shop,
      p_product_id: product.id,
      p_min_stock: null,
    });
    expect(cleared.min_stock_units).toBeNull();
  });

  it('rejects staff, another shop, a missing product and a negative minimum', async () => {
    const product = await newProduct(pg, owner, shop);
    const foreign = await newProduct(pg, outsider, otherShop);

    expect(
      await errorCode(rpc(pg, staff, 'set_product_min_stock', { p_shop_id: shop, p_product_id: product.id, p_min_stock: 2 }))
    ).toBe('42501');
    expect(
      await errorCode(
        rpc(pg, owner, 'set_product_min_stock', { p_shop_id: otherShop, p_product_id: foreign.id, p_min_stock: 2 })
      )
    ).toBe('42501');
    expect(
      await errorCode(
        rpc(pg, owner, 'set_product_min_stock', { p_shop_id: shop, p_product_id: foreign.id, p_min_stock: 2 })
      )
    ).toBe('P0002');
    expect(
      await errorCode(rpc(pg, owner, 'set_product_min_stock', { p_shop_id: shop, p_product_id: product.id, p_min_stock: -1 }))
    ).toBe('22023');
  });
});

describe('low stock dismissal', () => {
  it('is idempotent while open, then can start again after it is cleared', async () => {
    const product = await newProduct(pg, owner, shop);
    const first = await rpc<{ id: string; dismissed_at: string; cleared_at: string | null }>(pg, staff, 'dismiss_low_stock', {
      p_shop_id: shop,
      p_product_id: product.id,
    });
    const second = await rpc<{ id: string; dismissed_at: string; cleared_at: string | null }>(pg, staff, 'dismiss_low_stock', {
      p_shop_id: shop,
      p_product_id: product.id,
    });
    expect(second).toMatchObject({ id: first.id, dismissed_at: first.dismissed_at, cleared_at: null });

    const cleared = await rpc<{ cleared_at: string | null }>(pg, owner, 'clear_low_stock_dismissal', {
      p_shop_id: shop,
      p_product_id: product.id,
    });
    expect(cleared.cleared_at).not.toBeNull();
    const again = await rpc<{ cleared_at: string | null }>(pg, owner, 'clear_low_stock_dismissal', {
      p_shop_id: shop,
      p_product_id: product.id,
    });
    expect(again.cleared_at).toBe(cleared.cleared_at);

    const reopened = await rpc<{ dismissed_at: string; cleared_at: string | null }>(pg, staff, 'dismiss_low_stock', {
      p_shop_id: shop,
      p_product_id: product.id,
    });
    expect(reopened.cleared_at).toBeNull();
    expect(reopened.dismissed_at).not.toBe(first.dismissed_at);

    const visible = await query(pg, manager, 'select id from public.low_stock_dismissals where product_id = $1', [product.id]);
    expect(visible).toHaveLength(1);
    expect(await query(pg, outsider, 'select id from public.low_stock_dismissals where product_id = $1', [product.id])).toEqual(
      []
    );
  });

  it('clears nothing when the product was never dismissed', async () => {
    const product = await newProduct(pg, owner, shop);
    const row = await rpc<{ id: string | null } | null>(pg, staff, 'clear_low_stock_dismissal', {
      p_shop_id: shop,
      p_product_id: product.id,
    });
    expect(row?.id ?? null).toBeNull();
  });
});
