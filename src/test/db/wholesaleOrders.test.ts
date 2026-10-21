// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { addMember, createDatabase, createShop, createUser, errorCode, newProduct, query, rpc, stockIn, type User } from './harness';

let pg: PGlite;
let owner: User;
let manager: User;
let staff: User;
let outsider: User;
let shop: string;
let otherShop: string;

beforeAll(async () => {
  pg = await createDatabase();
  owner = await createUser(pg, 'wholesale-owner@example.com');
  manager = await createUser(pg, 'wholesale-manager@example.com');
  staff = await createUser(pg, 'wholesale-staff@example.com');
  outsider = await createUser(pg, 'wholesale-outsider@example.com');
  shop = await createShop(pg, owner, 'Wholesale shop');
  otherShop = await createShop(pg, outsider, 'Other wholesale shop');
  await addMember(pg, owner, shop, manager, 'manager');
  await addMember(pg, owner, shop, staff, 'staff');
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

async function batchCount(shopId: string): Promise<number> {
  const [row] = await query<{ n: number }>(pg, 'service', 'select count(*)::int as n from public.stock_batches where shop_id = $1', [shopId]);
  return Number(row.n);
}

describe('wholesale orders', () => {
  it('rejects a target below the minimum and keeps the level on this shop', async () => {
    const product = await newProduct(pg, owner, shop, '6001000099001');
    await rpc(pg, owner, 'set_product_min_stock', { p_shop_id: shop, p_product_id: product.id, p_min_stock: 4 });
    const set = await rpc<{ target_stock_units: number }>(pg, manager, 'set_product_target_stock', {
      p_shop_id: shop,
      p_product_id: product.id,
      p_target: 10,
    });
    expect(set.target_stock_units).toBe(10);
    expect(
      await errorCode(rpc(pg, owner, 'set_product_target_stock', { p_shop_id: shop, p_product_id: product.id, p_target: 3 }))
    ).toBe('22023');
    expect(
      await errorCode(rpc(pg, staff, 'set_product_target_stock', { p_shop_id: shop, p_product_id: product.id, p_target: 8 }))
    ).toBe('42501');
    const foreign = await newProduct(pg, outsider, otherShop, '6001000099002');
    expect(
      await errorCode(rpc(pg, owner, 'set_product_target_stock', { p_shop_id: otherShop, p_product_id: foreign.id, p_target: 5 }))
    ).toBe('42501');
  });

  it('saves an order without changing stock, and a repeat does not duplicate lines', async () => {
    const product = await newProduct(pg, owner, shop, '6001000099003');
    const second = await newProduct(pg, owner, shop, '6001000099004');
    await stockIn(pg, owner, shop, product.id, 6, { expiry: '2026-12-01' });
    const before = await batchCount(shop);
    const wholesalerId = randomUUID();
    await rpc(pg, owner, 'upsert_wholesaler', {
      p_id: wholesalerId,
      p_shop_id: shop,
      p_name: 'Metro Cash',
      p_phone: '0115550100',
      p_note: null,
    });
    const hidden = await query<{ n: number }>(pg, outsider, 'select count(*)::int as n from public.wholesalers where shop_id = $1', [shop]);
    expect(hidden[0].n).toBe(0);

    const orderId = randomUUID();
    const firstLine = randomUUID();
    const secondLine = randomUUID();
    const saved = await rpc<{ order: { status: string }; items: Array<{ id: string }> }>(pg, owner, 'save_wholesale_order', {
      p_shop_id: shop,
      p_order_id: orderId,
      p_wholesaler_id: wholesalerId,
      p_note: null,
      p_items: [
        { id: firstLine, product_id: product.id, quantity: 4 },
        { id: secondLine, product_id: second.id, quantity: 2 },
      ],
    });
    expect(saved.order.status).toBe('draft');
    expect(saved.items).toHaveLength(2);
    expect(await batchCount(shop)).toBe(before);

    const again = await rpc<{ items: Array<{ id: string; quantity: number }> }>(pg, owner, 'save_wholesale_order', {
      p_shop_id: shop,
      p_order_id: orderId,
      p_wholesaler_id: wholesalerId,
      p_note: null,
      p_items: [{ id: firstLine, product_id: product.id, quantity: 4 }],
    });
    expect(again.items.map((item) => item.id)).toEqual([firstLine]);
    const [active] = await query<{ n: number }>(
      pg,
      owner,
      'select count(*)::int as n from public.wholesale_order_items where order_id = $1 and removed_at is null',
      [orderId]
    );
    expect(active.n).toBe(1);

    expect(await errorCode(rpc(pg, staff, 'save_wholesale_order', {
      p_shop_id: shop,
      p_order_id: randomUUID(),
      p_wholesaler_id: null,
      p_note: null,
      p_items: [],
    }))).toBe('42501');

    const approved = await rpc<{ status: string }>(pg, manager, 'set_wholesale_order_status', {
      p_shop_id: shop,
      p_order_id: orderId,
      p_status: 'approved',
    });
    expect(approved.status).toBe('approved');
    expect(await errorCode(rpc(pg, owner, 'set_wholesale_order_status', {
      p_shop_id: shop,
      p_order_id: orderId,
      p_status: 'received',
    }))).toBe('22023');
    await rpc(pg, owner, 'set_wholesale_order_status', { p_shop_id: shop, p_order_id: orderId, p_status: 'ordered' });
    const received = await rpc<{ status: string }>(pg, owner, 'set_wholesale_order_status', {
      p_shop_id: shop,
      p_order_id: orderId,
      p_status: 'received',
    });
    expect(received.status).toBe('received');
    expect(await batchCount(shop)).toBe(before);
    const [onHand] = await query<{ n: number }>(
      pg,
      owner,
      'select coalesce(sum(quantity), 0)::int as n from public.stock_batches where product_id = $1',
      [product.id]
    );
    expect(onHand.n).toBe(6);
  });
});
