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
    expect(await errorCode(rpc(pg, owner, 'set_wholesale_order_status', {
      p_shop_id: shop,
      p_order_id: orderId,
      p_status: 'received',
    }))).toBe('22023');
    expect(await batchCount(shop)).toBe(before);
    const [onHand] = await query<{ n: number }>(
      pg,
      owner,
      'select coalesce(sum(quantity), 0)::int as n from public.stock_batches where product_id = $1',
      [product.id]
    );
    expect(onHand.n).toBe(6);
  });

  it('stores a cost and a purchased tick without changing stock', async () => {
    const product = await newProduct(pg, owner, shop, '6001000099011');
    await stockIn(pg, owner, shop, product.id, 6, { expiry: '2026-12-01' });
    const before = await batchCount(shop);
    const orderId = randomUUID();
    const lineId = randomUUID();
    const saved = await rpc<{ items: Array<{ estimated_unit_cost: string | number }> }>(pg, owner, 'save_wholesale_order', {
      p_shop_id: shop,
      p_order_id: orderId,
      p_wholesaler_id: null,
      p_note: null,
      p_items: [{ id: lineId, product_id: product.id, quantity: 4, estimated_unit_cost: 12.5 }],
    });
    expect(Number(saved.items[0].estimated_unit_cost)).toBe(12.5);

    const ticked = await rpc<{ purchased_at: string | null }>(pg, owner, 'set_wholesale_item_purchased', {
      p_shop_id: shop,
      p_item_id: lineId,
      p_purchased: true,
    });
    expect(ticked.purchased_at).toBeTruthy();
    const repeated = await rpc<{ purchased_at: string | null }>(pg, owner, 'set_wholesale_item_purchased', {
      p_shop_id: shop,
      p_item_id: lineId,
      p_purchased: true,
    });
    expect(repeated.purchased_at).toBe(ticked.purchased_at);

    const resaved = await rpc<{ items: Array<{ estimated_unit_cost: string | number; purchased_at: string | null }> }>(
      pg,
      owner,
      'save_wholesale_order',
      {
        p_shop_id: shop,
        p_order_id: orderId,
        p_wholesaler_id: null,
        p_note: null,
        p_items: [{ id: lineId, product_id: product.id, quantity: 4, estimated_unit_cost: 10 }],
      }
    );
    expect(Number(resaved.items[0].estimated_unit_cost)).toBe(10);
    expect(resaved.items[0].purchased_at).toBeTruthy();
    expect(await batchCount(shop)).toBe(before);

    await rpc(pg, owner, 'set_wholesale_order_status', { p_shop_id: shop, p_order_id: orderId, p_status: 'cancelled' });
    expect(
      await errorCode(rpc(pg, owner, 'set_wholesale_item_purchased', { p_shop_id: shop, p_item_id: lineId, p_purchased: false }))
    ).toBe('22023');
    expect(
      await errorCode(rpc(pg, outsider, 'set_wholesale_item_purchased', { p_shop_id: shop, p_item_id: lineId, p_purchased: true }))
    ).toBe('42501');
    expect(
      await errorCode(rpc(pg, owner, 'save_wholesale_order', {
        p_shop_id: shop,
        p_order_id: randomUUID(),
        p_wholesaler_id: null,
        p_note: null,
        p_items: [{ id: randomUUID(), product_id: product.id, quantity: 1, estimated_unit_cost: -1 }],
      }))
    ).toBe('22023');
  });

  it('receives part of an order, then the rest, and refuses a second copy', async () => {
    const product = await newProduct(pg, owner, shop, '6001000099021');
    const wholesalerId = randomUUID();
    await rpc(pg, owner, 'upsert_wholesaler', {
      p_id: wholesalerId,
      p_shop_id: shop,
      p_name: 'Fresh Market',
      p_phone: null,
      p_note: null,
    });
    const orderId = randomUUID();
    const lineId = randomUUID();
    await rpc(pg, owner, 'save_wholesale_order', {
      p_shop_id: shop,
      p_order_id: orderId,
      p_wholesaler_id: wholesalerId,
      p_note: null,
      p_items: [{ id: lineId, product_id: product.id, quantity: 10, estimated_unit_cost: 12.5 }],
    });
    await rpc(pg, owner, 'set_wholesale_order_status', { p_shop_id: shop, p_order_id: orderId, p_status: 'approved' });
    await rpc(pg, owner, 'set_wholesale_order_status', { p_shop_id: shop, p_order_id: orderId, p_status: 'ordered' });

    const receiptId = randomUUID();
    const first = await rpc<{ order: { status: string } }>(pg, owner, 'receive_wholesale_order', {
      p_shop_id: shop,
      p_receipt_id: receiptId,
      p_order_id: orderId,
      p_lines: [{
        id: randomUUID(),
        order_item_id: lineId,
        batch_id: randomUUID(),
        quantity: 4,
        expiry_date: '2026-12-01',
      }],
    });
    expect(first.order.status).toBe('partially_received');
    const [outstanding] = await query<{ n: number }>(
      pg,
      owner,
      `select (i.quantity - coalesce(sum(l.quantity), 0))::int as n
       from public.wholesale_order_items i
       left join public.wholesale_order_receipt_lines l on l.order_item_id = i.id
       where i.id = $1
       group by i.quantity`,
      [lineId]
    );
    expect(outstanding.n).toBe(6);
    const [batch] = await query<{ quantity: number; supplier_name: string; cost_price_per_unit: string; expiry_date: string }>(
      pg,
      owner,
      `select b.quantity, b.supplier_name, b.cost_price_per_unit::text, b.expiry_date::text
       from public.stock_batches b
       join public.wholesale_order_receipt_lines l on l.batch_id = b.id
       where l.order_item_id = $1`,
      [lineId]
    );
    expect(Number(batch.quantity)).toBe(4);
    expect(batch.supplier_name).toBe('Fresh Market');
    expect(Number(batch.cost_price_per_unit)).toBe(12.5);
    expect(String(batch.expiry_date).slice(0, 10)).toBe('2026-12-01');
    const [moves] = await query<{ n: number }>(
      pg,
      owner,
      `select count(*)::int as n from public.stock_movements m
       join public.wholesale_order_receipt_lines l on l.batch_id = m.batch_id
       where l.order_item_id = $1 and m.reason = 'stock_in'`,
      [lineId]
    );
    expect(moves.n).toBe(1);

    await rpc(pg, owner, 'receive_wholesale_order', {
      p_shop_id: shop,
      p_receipt_id: receiptId,
      p_order_id: orderId,
      p_lines: [{
        id: randomUUID(),
        order_item_id: lineId,
        batch_id: randomUUID(),
        quantity: 4,
        expiry_date: '2026-12-01',
      }],
    });
    const [afterReplay] = await query<{ n: number }>(
      pg,
      owner,
      'select count(*)::int as n from public.stock_batches where product_id = $1',
      [product.id]
    );
    expect(afterReplay.n).toBe(1);

    expect(await errorCode(rpc(pg, owner, 'receive_wholesale_order', {
      p_shop_id: shop,
      p_receipt_id: randomUUID(),
      p_order_id: orderId,
      p_lines: [{ id: randomUUID(), order_item_id: lineId, batch_id: randomUUID(), quantity: 7, expiry_date: '2026-12-01' }],
    }))).toBe('22023');
    expect(await errorCode(rpc(pg, outsider, 'receive_wholesale_order', {
      p_shop_id: shop,
      p_receipt_id: randomUUID(),
      p_order_id: orderId,
      p_lines: [{ id: randomUUID(), order_item_id: lineId, batch_id: randomUUID(), quantity: 1, expiry_date: '2026-12-01' }],
    }))).toBe('42501');

    const second = await rpc<{ order: { status: string } }>(pg, owner, 'receive_wholesale_order', {
      p_shop_id: shop,
      p_receipt_id: randomUUID(),
      p_order_id: orderId,
      p_lines: [{
        id: randomUUID(),
        order_item_id: lineId,
        batch_id: randomUUID(),
        quantity: 6,
        expiry_date: '2027-01-15',
      }],
    });
    expect(second.order.status).toBe('received');
    const [batches] = await query<{ n: number; units: number }>(
      pg,
      owner,
      'select count(*)::int as n, coalesce(sum(quantity), 0)::int as units from public.stock_batches where product_id = $1',
      [product.id]
    );
    expect(batches.n).toBe(2);
    expect(batches.units).toBe(10);

    const otherOrder = randomUUID();
    const otherLine = randomUUID();
    const otherProduct = await newProduct(pg, owner, shop, '6001000099022');
    await rpc(pg, owner, 'save_wholesale_order', {
      p_shop_id: shop,
      p_order_id: otherOrder,
      p_wholesaler_id: wholesalerId,
      p_note: null,
      p_items: [{ id: otherLine, product_id: otherProduct.id, quantity: 3 }],
    });
    await rpc(pg, owner, 'set_wholesale_order_status', { p_shop_id: shop, p_order_id: otherOrder, p_status: 'approved' });
    await rpc(pg, owner, 'set_wholesale_order_status', { p_shop_id: shop, p_order_id: otherOrder, p_status: 'ordered' });
    await rpc(pg, owner, 'receive_wholesale_order', {
      p_shop_id: shop,
      p_receipt_id: randomUUID(),
      p_order_id: otherOrder,
      p_lines: [{ id: randomUUID(), order_item_id: otherLine, batch_id: randomUUID(), quantity: 1, expiry_date: null }],
    });
    const [kept] = await query<{ n: number }>(
      pg,
      owner,
      'select coalesce(sum(quantity), 0)::int as n from public.stock_batches where product_id = $1',
      [otherProduct.id]
    );
    await rpc(pg, owner, 'set_wholesale_order_status', { p_shop_id: shop, p_order_id: otherOrder, p_status: 'cancelled' });
    expect(await errorCode(rpc(pg, owner, 'receive_wholesale_order', {
      p_shop_id: shop,
      p_receipt_id: randomUUID(),
      p_order_id: otherOrder,
      p_lines: [{ id: randomUUID(), order_item_id: otherLine, batch_id: randomUUID(), quantity: 1, expiry_date: null }],
    }))).toBe('22023');
    const [still] = await query<{ n: number }>(
      pg,
      owner,
      'select coalesce(sum(quantity), 0)::int as n from public.stock_batches where product_id = $1',
      [otherProduct.id]
    );
    expect(still.n).toBe(kept.n);
    expect(still.n).toBe(1);
  });
});
