// @vitest-environment node
/**
 * The ported shop ledger (worker/shop) must answer exactly like the Postgres functions it
 * replaces: same results, same errors, same rows left behind. See diff.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPair, type Pair } from './diff';

let p: Pair;
const id = () => randomUUID();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const past = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

beforeEach(async () => {
  p = await createPair();
}, 60_000);

afterEach(async () => {
  await p?.close();
});

/** Calls both sides, requires the same outcome, and returns the Postgres answer. */
async function same(user: 'owner' | 'manager' | 'staff' | null, fn: string, args: Record<string, unknown>) {
  const r = await p.call(user ? p[user] : null, fn, args);
  expect(r.sq, `${fn} ${JSON.stringify(args)}`).toEqual(r.pg);
  return r;
}

async function sameTables() {
  const t = await p.tables();
  for (const table of Object.keys(t.pg)) expect(t.sq[table], table).toEqual(t.pg[table]);
}

async function product(barcode = id().replace(/-/g, '').slice(0, 13), price = 18.5) {
  const productId = id();
  await same('owner', 'upsert_product', {
    p_id: productId,
    p_shop_id: p.shopId,
    p_barcode: barcode,
    p_name: 'Bread',
    p_category: 'bakery',
    p_buying_price: 12,
    p_selling_price: price,
    p_created_at: past(60),
  });
  return productId;
}

async function stockIn(productId: string, quantity: number, extra: Record<string, unknown> = {}, user: 'owner' | 'staff' = 'owner') {
  const batchId = id();
  await same(user, 'record_stock_in', {
    p_batch_id: batchId,
    p_shop_id: p.shopId,
    p_product_id: productId,
    p_quantity: quantity,
    p_expiry_date: null,
    p_cost_price_per_unit: 9.5,
    p_received_at: past(30),
    p_idempotency_key: null,
    ...extra,
  });
  return batchId;
}

const sale = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  p_sale_id: id(),
  p_shop_id: p.shopId,
  p_idempotency_key: id(),
  p_sold_at: past(1),
  p_items: items,
  ...extra,
});

describe('products', () => {
  it('creates, replays by id and by barcode, and refuses bad input the same way', async () => {
    const productId = await product('6001111111111');
    await same('staff', 'upsert_product', { p_id: productId, p_shop_id: p.shopId, p_barcode: '6001111111111', p_name: 'Again', p_category: 'bakery', p_buying_price: 1, p_selling_price: 2, p_created_at: null });
    await same('staff', 'upsert_product', { p_id: id(), p_shop_id: p.shopId, p_barcode: ' 6001111 111111 ', p_name: 'Same barcode', p_category: null, p_buying_price: null, p_selling_price: null, p_created_at: null });
    await same('owner', 'upsert_product', { p_id: id(), p_shop_id: p.shopId, p_barcode: '  ', p_name: 'x', p_category: 'other', p_buying_price: 1, p_selling_price: 1, p_created_at: null });
    await same('owner', 'upsert_product', { p_id: id(), p_shop_id: p.shopId, p_barcode: '1', p_name: ' ', p_category: 'other', p_buying_price: 1, p_selling_price: 1, p_created_at: null });
    await same('owner', 'upsert_product', { p_id: id(), p_shop_id: p.shopId, p_barcode: '2', p_name: 'x', p_category: 'other', p_buying_price: -1, p_selling_price: 1, p_created_at: null });
    await same('owner', 'upsert_product', { p_id: id(), p_shop_id: p.shopId, p_barcode: '3', p_name: 'x', p_category: 'other', p_buying_price: 1, p_selling_price: 1, p_created_at: null, p_brand: 'b'.repeat(81) });
    await same(null, 'upsert_product', { p_id: id(), p_shop_id: p.shopId, p_barcode: '4', p_name: 'x', p_category: 'other', p_buying_price: 1, p_selling_price: 1, p_created_at: null });
    await sameTables();
  });

  it('updates, archives, lists and sets stock levels the same way', async () => {
    const a = await product('6002222222222');
    const b = await product('6003333333333');
    await same('manager', 'update_product', { p_shop_id: p.shopId, p_product_id: a, p_barcode: '6004444444444', p_name: ' Brown bread ', p_category: 'bakery', p_buying_price: 10.255, p_selling_price: 15.99, p_brand: ' Albany ', p_size: '700g' });
    await same('manager', 'update_product', { p_shop_id: p.shopId, p_product_id: a, p_barcode: '6003333333333', p_name: 'x', p_category: 'bakery', p_buying_price: 1, p_selling_price: 1 });
    await same('manager', 'update_product', { p_shop_id: p.shopId, p_product_id: a, p_barcode: '6004444444444', p_name: 'x', p_category: 'cars', p_buying_price: 1, p_selling_price: 1 });
    await same('staff', 'update_product', { p_shop_id: p.shopId, p_product_id: a, p_barcode: '6004444444444', p_name: 'x', p_category: 'bakery', p_buying_price: 1, p_selling_price: 1 });
    await same('manager', 'update_product', { p_shop_id: p.shopId, p_product_id: id(), p_barcode: '1', p_name: 'x', p_category: 'bakery', p_buying_price: 1, p_selling_price: 1 });
    await same('owner', 'set_product_min_stock', { p_shop_id: p.shopId, p_product_id: b, p_min_stock: 5 });
    await same('owner', 'set_product_target_stock', { p_shop_id: p.shopId, p_product_id: b, p_target: 3 });
    await same('owner', 'set_product_target_stock', { p_shop_id: p.shopId, p_product_id: b, p_target: 20 });
    await same('owner', 'set_product_min_stock', { p_shop_id: p.shopId, p_product_id: b, p_min_stock: -1 });
    await same('owner', 'set_product_listed', { p_shop_id: p.shopId, p_product_id: b, p_listed: false });
    await same('owner', 'set_product_listed', { p_shop_id: p.shopId, p_product_id: b, p_listed: null });
    await same('owner', 'set_product_archived', { p_shop_id: p.shopId, p_product_id: b, p_archived: true });
    await same('owner', 'set_product_archived', { p_shop_id: p.shopId, p_product_id: b, p_archived: true });
    await same('owner', 'set_product_archived', { p_shop_id: p.shopId, p_product_id: b, p_archived: false });
    await sameTables();
  });

  it('handles packagings and extra barcodes the same way', async () => {
    const a = await product('6005555555555');
    const b = await product('6006666666666');
    const pack = id();
    await same('owner', 'create_product_packaging', { p_id: pack, p_shop_id: p.shopId, p_product_id: a, p_name: ' Box ', p_units_per_package: 12, p_created_at: past(5), p_selling_price: 199.999 });
    await same('owner', 'create_product_packaging', { p_id: pack, p_shop_id: p.shopId, p_product_id: a, p_name: 'Box', p_units_per_package: 12, p_selling_price: 210 });
    await same('owner', 'create_product_packaging', { p_id: pack, p_shop_id: p.shopId, p_product_id: a, p_name: 'Crate', p_units_per_package: 12 });
    await same('owner', 'create_product_packaging', { p_id: id(), p_shop_id: p.shopId, p_product_id: a, p_name: 'Tiny', p_units_per_package: 1 });
    await same('owner', 'set_packaging_price', { p_shop_id: p.shopId, p_packaging_id: pack, p_selling_price: null });
    const link = id();
    await same('owner', 'link_product_barcode', { p_id: link, p_shop_id: p.shopId, p_product_id: a, p_packaging_id: pack, p_barcode: '6007777777777', p_created_at: past(4) });
    await same('owner', 'link_product_barcode', { p_id: id(), p_shop_id: p.shopId, p_product_id: a, p_packaging_id: pack, p_barcode: '6007777777777' });
    await same('owner', 'link_product_barcode', { p_id: id(), p_shop_id: p.shopId, p_product_id: b, p_packaging_id: null, p_barcode: '6007777777777' });
    await same('owner', 'link_product_barcode', { p_id: id(), p_shop_id: p.shopId, p_product_id: b, p_packaging_id: null, p_barcode: '6005555555555' });
    await same('owner', 'upsert_product', { p_id: id(), p_shop_id: p.shopId, p_barcode: '6007777777777', p_name: 'x', p_category: 'other', p_buying_price: 1, p_selling_price: 1, p_created_at: null });
    await stockIn(a, 24, { p_packaging_id: pack, p_package_quantity: 2, p_barcode_id: link });
    await stockIn(a, 10, { p_packaging_id: pack, p_package_quantity: 2 });
    await same('owner', 'unlink_product_barcode', { p_shop_id: p.shopId, p_barcode_id: link, p_reason: 'Wrong label', p_reverse_unsold: true, p_occurred_at: past(1) });
    await same('owner', 'unlink_product_barcode', { p_shop_id: p.shopId, p_barcode_id: link, p_reason: 'Again' });
    await same('owner', 'retire_product_packaging', { p_shop_id: p.shopId, p_packaging_id: pack });
    await same('owner', 'retire_product_packaging', { p_shop_id: p.shopId, p_packaging_id: pack });
    await same('owner', 'link_product_barcode', { p_id: id(), p_shop_id: p.shopId, p_product_id: a, p_packaging_id: pack, p_barcode: '6008888888888' });
    await sameTables();
  });

  it('dismisses and clears low-stock warnings the same way', async () => {
    const a = await product();
    await same('staff', 'dismiss_low_stock', { p_shop_id: p.shopId, p_product_id: a });
    await same('staff', 'dismiss_low_stock', { p_shop_id: p.shopId, p_product_id: a });
    await same('staff', 'clear_low_stock_dismissal', { p_shop_id: p.shopId, p_product_id: a });
    await same('staff', 'dismiss_low_stock', { p_shop_id: p.shopId, p_product_id: a });
    await same('staff', 'dismiss_low_stock', { p_shop_id: p.shopId, p_product_id: id() });
    await sameTables();
  });
});

describe('stock', () => {
  it('records stock-in with replays, conflicts and validation the same way', async () => {
    const a = await product();
    const batch = id();
    const args = { p_batch_id: batch, p_shop_id: p.shopId, p_product_id: a, p_quantity: 10, p_expiry_date: day(30), p_cost_price_per_unit: 0.29, p_received_at: past(10), p_idempotency_key: 'k1', p_lot_number: ' L1 ', p_supplier_name: ' Makro ' };
    await same('staff', 'record_stock_in', args);
    await same('staff', 'record_stock_in', args);
    await same('staff', 'record_stock_in', { ...args, p_idempotency_key: 'k2' });
    await same('staff', 'record_stock_in', { ...args, p_batch_id: id(), p_quantity: 0, p_idempotency_key: 'k3' });
    await same('staff', 'record_stock_in', { ...args, p_batch_id: id(), p_cost_price_per_unit: -1, p_idempotency_key: 'k4' });
    await same('staff', 'record_stock_in', { ...args, p_batch_id: id(), p_product_id: id(), p_idempotency_key: 'k5' });
    await same('staff', 'record_stock_in', { ...args, p_batch_id: id(), p_lot_number: 'x'.repeat(41), p_idempotency_key: 'k6' });
    await same('staff', 'add_stock_to_batch', { p_shop_id: p.shopId, p_batch_id: batch, p_quantity: 5, p_idempotency_key: 'add1' });
    await same('staff', 'add_stock_to_batch', { p_shop_id: p.shopId, p_batch_id: batch, p_quantity: 5, p_idempotency_key: 'add1' });
    await same('staff', 'add_stock_to_batch', { p_shop_id: p.shopId, p_batch_id: batch, p_quantity: 999_999, p_idempotency_key: 'add2' });
    await same('staff', 'add_stock_to_batch', { p_shop_id: p.shopId, p_batch_id: id(), p_quantity: 1, p_idempotency_key: 'add3' });
    await sameTables();
  });

  it('sells first-expired-first-out, skips expired batches, records shortfalls and replays the same way', async () => {
    const a = await product('6009999999991', 0.29);
    const b = await product('6009999999992', 15.99);
    await stockIn(a, 3, { p_expiry_date: day(10) });
    await stockIn(a, 4, { p_expiry_date: day(2) });
    await stockIn(a, 2, { p_expiry_date: day(-1) });
    await stockIn(a, 5);
    await stockIn(b, 1);
    const first = sale([
      { id: id(), product_id: a, quantity: 9, unit_price: 0.29 },
      { id: id(), product_id: b, quantity: 3, unit_price: 15.995 },
    ]);
    const r = await same('staff', 'record_sale', first);
    expect((r.pg.data as { shortfall: number }).shortfall).toBe(2);
    expect(r.effects).toHaveLength(1);
    await same('staff', 'record_sale', first);
    await same('staff', 'record_sale', { ...first, p_sale_id: id() });
    await same('staff', 'record_sale', sale([]));
    await same('staff', 'record_sale', sale([{ id: id(), product_id: id(), quantity: 1 }]));
    const dup = id();
    await same('staff', 'record_sale', sale([{ id: dup, product_id: a, quantity: 1 }, { id: dup, product_id: a, quantity: 1 }]));
    await same('staff', 'record_sale', sale([{ id: id(), product_id: a, quantity: 0 }]));
    await same('staff', 'record_sale', sale([{ id: id(), product_id: a, quantity: 1, unit_price: -1 }]));
    await same('staff', 'record_sale', sale([{ id: id(), product_id: a, quantity: 1 }], { p_idempotency_key: ' ' }));
    await same(null, 'record_sale', sale([{ id: id(), product_id: a, quantity: 1 }]));
    await sameTables();
  });

  it('voids sale items back into their batches, with the staff 15-minute rule, the same way', async () => {
    const a = await product();
    await stockIn(a, 2, { p_expiry_date: day(3) });
    await stockIn(a, 2, { p_expiry_date: day(5) });
    const item = id();
    const s = sale([{ id: item, product_id: a, quantity: 6, unit_price: 18.5 }]);
    await same('staff', 'record_sale', s);
    const v = (quantity: number, key: string, extra: Record<string, unknown> = {}) => ({
      p_shop_id: p.shopId,
      p_sale_item_id: item,
      p_quantity: quantity,
      p_occurred_at: new Date().toISOString(),
      p_idempotency_key: key,
      ...extra,
    });
    await same('staff', 'void_sale_item', v(1, 'v1'));
    await same('staff', 'void_sale_item', v(1, 'v1'));
    await same('staff', 'void_sale_item', v(3, 'v2'));
    await same('staff', 'void_sale_item', v(5, 'v3'));
    await same('manager', 'void_sale_item', v(2, 'v4'));
    await same('staff', 'void_sale_item', v(1, 'v5'));
    const late = id();
    await same('staff', 'record_sale', sale([{ id: late, product_id: a, quantity: 1 }], { p_sold_at: past(30) }));
    await same('staff', 'void_sale_item', { ...v(1, 'v6'), p_sale_item_id: late });
    await same('owner', 'void_sale_item', { ...v(1, 'v7'), p_sale_item_id: late });
    await sameTables();
  });

  it('adjusts stock and resolves expired batches the same way', async () => {
    const a = await product();
    const batch = await stockIn(a, 10, { p_expiry_date: day(-2) });
    const adj = (delta: number, reason: string, key: string) => ({ p_shop_id: p.shopId, p_batch_id: batch, p_quantity_delta: delta, p_reason: reason, p_occurred_at: past(2), p_idempotency_key: key });
    await same('manager', 'record_stock_adjustment', adj(-2, 'write_off_damaged', 'a1'));
    await same('manager', 'record_stock_adjustment', adj(-2, 'write_off_damaged', 'a1'));
    await same('manager', 'record_stock_adjustment', adj(2, 'write_off_damaged', 'a2'));
    await same('manager', 'record_stock_adjustment', adj(-1, 'return', 'a3'));
    await same('manager', 'record_stock_adjustment', adj(-50, 'count_correction', 'a4'));
    await same('manager', 'record_stock_adjustment', adj(1, 'theft', 'a5'));
    await same('staff', 'record_stock_adjustment', adj(1, 'adjustment', 'a6'));
    await same('manager', 'record_stock_adjustment', adj(3, 'return', 'a7'));
    await p.pg.query('select private.generate_expiry_alerts(now())');
    const res = (action: string, key: string, extra: Record<string, unknown> = {}) => ({ p_shop_id: p.shopId, p_batch_id: batch, p_action: action, p_new_expiry_date: null, p_note: ' Mouldy ', p_occurred_at: past(1), p_idempotency_key: key, ...extra });
    await same('manager', 'resolve_expired_batch', res('expiry_corrected', 'r0'));
    await same('manager', 'resolve_expired_batch', res('expiry_corrected', 'r1', { p_new_expiry_date: day(4) }));
    await same('manager', 'resolve_expired_batch', res('discarded', 'r2'));
    await same('manager', 'resolve_expired_batch', res('discarded', 'r2'));
    await same('manager', 'resolve_expired_batch', res('returned_to_supplier', 'r3'));
    await same('manager', 'resolve_expired_batch', res('eaten', 'r4'));
    const tables = await p.tables();
    // Alerts come from the Postgres generator in this test; compare everything else.
    delete tables.pg.expiry_alerts;
    delete tables.sq.expiry_alerts;
    for (const table of Object.keys(tables.pg)) expect(tables.sq[table], table).toEqual(tables.pg[table]);
  });
});
