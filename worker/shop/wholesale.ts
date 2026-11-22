/** Wholesalers and wholesale orders, ported from the Postgres functions of the same names. */
import { DbError, invalid, notFound } from '../db/errors';
import { toApiRow, toApiRows, toCents, type ApiRow } from '../db/rows';
import { one, type SyncSql } from '../db/sql';
import { assertPermission, type ShopCall } from './context';
import { charLength, get, insert, isUuid, optionalTrimmed, trimmed } from './common';
import { recordStockIn } from './stock';

type Args = Record<string, unknown>;

const wholesaler = (sql: SyncSql, id: string) => toApiRow('wholesalers', get(sql, 'wholesalers', id));

/** A required uuid argument; a malformed one is refused like Postgres's invalid input (22P02). */
function uuidOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!isUuid(value)) throw new DbError('22P02', `invalid input syntax for type uuid: "${String(value)}"`);
  return value.toLowerCase();
}

/** public.upsert_wholesaler */
export function upsertWholesaler({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'orders.manage');
  const name = trimmed(a.p_name);
  const phone = optionalTrimmed(a.p_phone);
  const note = optionalTrimmed(a.p_note);
  const id = uuidOrNull(a.p_id);
  if (id === null) throw invalid('Wholesaler id is required.');
  if (charLength(name) < 1 || charLength(name) > 80) throw invalid('Enter a wholesaler name.');
  if (phone !== null && charLength(phone) > 40) throw invalid('Phone is too long.');
  if (note !== null && charLength(note) > 280) throw invalid('Note is too long.');
  const existing = get(sql, 'wholesalers', id);
  if (existing && existing.shop_id !== ctx.shopId) throw invalid('This wholesaler belongs to another shop.');
  if (existing && existing.archived_at !== null) throw invalid('This wholesaler is archived.');
  // wholesalers_active_name_idx compares lower(name); SQLite's lower() only folds ASCII.
  const clash = one(
    sql,
    'SELECT id FROM wholesalers WHERE shop_id = ? AND archived_at IS NULL AND id <> ?',
    ctx.shopId,
    id
  ) && sql.all<{ name: string }>('SELECT name FROM wholesalers WHERE shop_id = ? AND archived_at IS NULL AND id <> ?', ctx.shopId, id)
    .some((w) => w.name.toLowerCase() === name.toLowerCase());
  if (clash) throw invalid('A wholesaler with this name is already in the shop.');
  if (!existing) {
    insert(sql, 'wholesalers', { id, shop_id: ctx.shopId, name, phone, note, created_at: ctx.now, updated_at: ctx.now });
  } else {
    sql.run('UPDATE wholesalers SET name = ?, phone = ?, note = ? WHERE id = ? AND shop_id = ?', name, phone, note, id, ctx.shopId);
  }
  return wholesaler(sql, id)!;
}

/** public.archive_wholesaler */
export function archiveWholesaler({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'orders.manage');
  const id = uuidOrNull(a.p_id);
  const changed = id
    ? sql.run('UPDATE wholesalers SET archived_at = coalesce(archived_at, ?) WHERE id = ? AND shop_id = ?', ctx.now, id, ctx.shopId)
    : 0;
  if (changed === 0) throw notFound('Wholesaler not found in this shop.');
  return wholesaler(sql, id!)!;
}

function wholeQuantity(value: unknown, message: string): number {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (!/^[0-9]+$/.test(text)) throw invalid(message);
  const n = Number(text);
  if (n < 1 || n > 1_000_000) throw invalid(message);
  return n;
}

function costCents(value: unknown): number | null {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (text === '') return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) throw invalid('Estimated cost must be a number.');
  const cents = toCents(text);
  if (cents < 0) throw invalid('Estimated cost cannot be negative.');
  return cents;
}

const activeItems = (sql: SyncSql, shopId: string, orderId: string) =>
  toApiRows(
    'wholesale_order_items',
    sql.all('SELECT * FROM wholesale_order_items WHERE shop_id = ? AND order_id = ? AND removed_at IS NULL ORDER BY created_at, rowid', shopId, orderId)
  );

/** public.save_wholesale_order: create or replace a draft order and its lines. */
export function saveWholesaleOrder({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'orders.manage');
  const note = optionalTrimmed(a.p_note);
  const orderId = uuidOrNull(a.p_order_id);
  if (orderId === null) throw invalid('Order id is required.');
  if (note !== null && charLength(note) > 280) throw invalid('Note is too long.');
  const items = a.p_items;
  if (!Array.isArray(items) || items.length > 80) throw invalid('An order can hold up to 80 products.');

  const lines: { id: string; productId: string; quantity: number; cost: number | null }[] = [];
  for (const raw of items) {
    const item = (raw ?? {}) as Record<string, unknown>;
    let id: string | null;
    let productId: string | null;
    try {
      id = uuidOrNull(item.id);
      productId = uuidOrNull(item.product_id);
    } catch {
      throw invalid('Each line needs an id and a product.');
    }
    if (id === null || productId === null) throw invalid('Each line needs an id and a product.');
    if (lines.some((l) => l.id === id || l.productId === productId)) throw invalid('The same product was sent twice.');
    const quantity = wholeQuantity(item.quantity, 'Quantity must be a whole number from 1 to 1,000,000.');
    const cost = costCents(item.estimated_unit_cost);
    if (!one(sql, 'SELECT 1 AS x FROM products WHERE id = ? AND shop_id = ?', productId, ctx.shopId)) {
      throw notFound('Product not found in this shop.');
    }
    lines.push({ id, productId, quantity, cost });
  }

  const wholesalerId = uuidOrNull(a.p_wholesaler_id);
  if (
    wholesalerId !== null &&
    !one(sql, 'SELECT 1 AS x FROM wholesalers WHERE id = ? AND shop_id = ? AND archived_at IS NULL', wholesalerId, ctx.shopId)
  ) {
    throw invalid('Choose a wholesaler from this shop.');
  }
  const order = get(sql, 'wholesale_orders', orderId);
  if (order && order.shop_id !== ctx.shopId) throw invalid('This order belongs to another shop.');
  if (order && order.status !== 'draft') throw invalid('Only a draft can be changed.');
  if (!order) {
    insert(sql, 'wholesale_orders', {
      id: orderId,
      shop_id: ctx.shopId,
      wholesaler_id: wholesalerId,
      status: 'draft',
      note,
      created_at: ctx.now,
      updated_at: ctx.now,
    });
  } else {
    sql.run('UPDATE wholesale_orders SET wholesaler_id = ?, note = ? WHERE id = ? AND shop_id = ?', wholesalerId, note, orderId, ctx.shopId);
  }

  const keep = lines.map((l) => l.id);
  sql.run(
    `UPDATE wholesale_order_items SET removed_at = ?
      WHERE shop_id = ? AND order_id = ? AND removed_at IS NULL
        AND id NOT IN (${keep.map(() => '?').join(', ') || 'NULL'})`,
    ctx.now,
    ctx.shopId,
    orderId,
    ...keep
  );
  for (const line of lines) {
    const changed = sql.run(
      `UPDATE wholesale_order_items SET product_id = ?, quantity = ?, estimated_unit_cost_cents = ?, removed_at = NULL
        WHERE id = ? AND shop_id = ? AND order_id = ?`,
      line.productId,
      line.quantity,
      line.cost,
      line.id,
      ctx.shopId,
      orderId
    );
    if (changed === 0) {
      insert(sql, 'wholesale_order_items', {
        id: line.id,
        shop_id: ctx.shopId,
        order_id: orderId,
        product_id: line.productId,
        quantity: line.quantity,
        estimated_unit_cost_cents: line.cost,
        created_at: ctx.now,
        updated_at: ctx.now,
      });
    }
  }
  return {
    order: toApiRow('wholesale_orders', get(sql, 'wholesale_orders', orderId)),
    items: activeItems(sql, ctx.shopId, orderId),
  };
}

const STATUSES = ['draft', 'approved', 'ordered', 'partially_received', 'received', 'cancelled'];
const ALLOWED: Record<string, string[]> = {
  draft: ['approved', 'cancelled'],
  approved: ['ordered', 'draft', 'cancelled'],
  ordered: ['cancelled'],
  partially_received: ['cancelled'],
};

/** public.set_wholesale_order_status */
export function setWholesaleOrderStatus({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'orders.manage');
  const status = a.p_status;
  if (typeof status !== 'string' || !STATUSES.includes(status)) throw invalid('That status is not used.');
  const orderId = uuidOrNull(a.p_order_id);
  const order = orderId
    ? one<{ status: string; wholesaler_id: string | null }>(sql, 'SELECT status, wholesaler_id FROM wholesale_orders WHERE id = ? AND shop_id = ?', orderId, ctx.shopId)
    : null;
  if (!order) throw notFound('Order not found in this shop.');
  if (order.status !== status) {
    if (!(ALLOWED[order.status] ?? []).includes(status)) throw invalid('That status change is not allowed.');
    if (status !== 'draft' && status !== 'cancelled') {
      const hasLine = one(sql, 'SELECT 1 AS x FROM wholesale_order_items WHERE shop_id = ? AND order_id = ? AND removed_at IS NULL', ctx.shopId, orderId!);
      if (order.wholesaler_id === null || !hasLine) throw invalid('Choose a wholesaler and at least one product first.');
    }
    sql.run('UPDATE wholesale_orders SET status = ? WHERE id = ? AND shop_id = ?', status, orderId!, ctx.shopId);
  }
  return toApiRow('wholesale_orders', get(sql, 'wholesale_orders', orderId!))!;
}

/** public.set_wholesale_item_purchased: tick a line off while shopping. */
export function setWholesaleItemPurchased({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertPermission(ctx, 'orders.manage');
  if (a.p_item_id == null || a.p_purchased == null) throw invalid('Choose a line.');
  const itemId = uuidOrNull(a.p_item_id)!;
  const item = one<{ order_id: string; purchased_at: string | null }>(
    sql,
    'SELECT order_id, purchased_at FROM wholesale_order_items WHERE id = ? AND shop_id = ? AND removed_at IS NULL',
    itemId,
    ctx.shopId
  );
  if (!item) throw notFound('Order line not found in this shop.');
  const status = one<{ status: string }>(sql, 'SELECT status FROM wholesale_orders WHERE id = ? AND shop_id = ?', item.order_id, ctx.shopId)?.status;
  if (status === 'cancelled') throw invalid('A cancelled order cannot be changed.');
  const purchased = Boolean(a.p_purchased);
  if (purchased !== (item.purchased_at !== null)) {
    sql.run('UPDATE wholesale_order_items SET purchased_at = ? WHERE id = ? AND shop_id = ?', purchased ? ctx.now : null, itemId, ctx.shopId);
  }
  return toApiRow('wholesale_order_items', get(sql, 'wholesale_order_items', itemId))!;
}

function receiptResult(sql: SyncSql, shopId: string, receiptId: string, movementKeys?: string[]): ApiRow {
  const receipt = get(sql, 'wholesale_order_receipts', receiptId)!;
  const lines = sql.all('SELECT * FROM wholesale_order_receipt_lines WHERE receipt_id = ? ORDER BY created_at, rowid', receiptId);
  const batchIds = lines.map((l) => String(l.batch_id));
  const marks = batchIds.map(() => '?').join(', ') || 'NULL';
  const batches = sql.all(`SELECT * FROM stock_batches WHERE id IN (${marks}) ORDER BY rowid`, ...batchIds);
  const movements = movementKeys
    ? sql.all(
        `SELECT * FROM stock_movements WHERE shop_id = ? AND idempotency_key IN (${movementKeys.map(() => '?').join(', ')}) ORDER BY rowid`,
        shopId,
        ...movementKeys
      )
    : sql.all(`SELECT * FROM stock_movements WHERE shop_id = ? AND batch_id IN (${marks}) AND reason = 'stock_in' ORDER BY rowid`, shopId, ...batchIds);
  return {
    order: toApiRow('wholesale_orders', get(sql, 'wholesale_orders', String(receipt.order_id))),
    receipt: toApiRow('wholesale_order_receipts', receipt),
    lines: toApiRows('wholesale_order_receipt_lines', lines),
    batches: toApiRows('stock_batches', batches),
    movements: toApiRows('stock_movements', movements),
  };
}

/** public.receive_wholesale_order: each delivered line becomes its own stock batch. */
export function receiveWholesaleOrder(call: ShopCall, sql: SyncSql, a: Args): ApiRow {
  const { ctx } = call;
  assertPermission(ctx, 'stock.receive');
  const receiptId = uuidOrNull(a.p_receipt_id);
  const orderId = uuidOrNull(a.p_order_id);
  if (receiptId === null || orderId === null) throw invalid('Choose an order.');
  const raw = a.p_lines;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 160) throw invalid('Record at least one product.');
  const order = one<{ status: string; wholesaler_id: string | null }>(
    sql,
    'SELECT status, wholesaler_id FROM wholesale_orders WHERE id = ? AND shop_id = ?',
    orderId,
    ctx.shopId
  );
  if (!order) throw notFound('Order not found in this shop.');

  const existing = get(sql, 'wholesale_order_receipts', receiptId);
  if (existing) {
    if (existing.shop_id !== ctx.shopId || existing.order_id !== orderId) throw invalid('This receipt belongs to another order.');
    return receiptResult(sql, ctx.shopId, receiptId);
  }
  if (order.status !== 'ordered' && order.status !== 'partially_received') {
    throw invalid('Only an ordered delivery can be received.');
  }
  const supplier = order.wholesaler_id
    ? (one<{ name: string }>(sql, 'SELECT name FROM wholesalers WHERE id = ? AND shop_id = ?', order.wholesaler_id, ctx.shopId)?.name ?? null)
    : null;

  const lines: { id: string; itemId: string; batchId: string; quantity: number; expiry: string | null; productId: string; cost: number | null }[] = [];
  for (const entry of raw) {
    const line = (entry ?? {}) as Record<string, unknown>;
    let id: string | null;
    let itemId: string | null;
    let batchId: string | null;
    try {
      id = uuidOrNull(line.id);
      itemId = uuidOrNull(line.order_item_id);
      batchId = uuidOrNull(line.batch_id);
    } catch {
      throw invalid('Each delivery line needs an id.');
    }
    if (id === null || itemId === null || batchId === null) throw invalid('Each delivery line needs an id.');
    if (lines.some((l) => l.id === id || l.batchId === batchId)) throw invalid('The same delivery line was sent twice.');
    const quantity = wholeQuantity(line.quantity, 'Quantity must be a whole number from 1 to 1,000,000.');
    const expiryText = trimmed(line.expiry_date) || null;
    let expiry: string | null = null;
    if (expiryText !== null) {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(expiryText);
      const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
      if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw invalid('Expiry date must be a real date.');
      expiry = d.toISOString().slice(0, 10);
    }
    const item = one<{ product_id: string; estimated_unit_cost_cents: number | null }>(
      sql,
      'SELECT product_id, estimated_unit_cost_cents FROM wholesale_order_items WHERE id = ? AND shop_id = ? AND order_id = ? AND removed_at IS NULL',
      itemId,
      ctx.shopId,
      orderId
    );
    if (!item) throw notFound('Order line not found in this shop.');
    if (get(sql, 'stock_batches', batchId)) throw invalid('This delivery was already recorded.');
    lines.push({ id, itemId, batchId, quantity, expiry, productId: item.product_id, cost: item.estimated_unit_cost_cents });
  }

  for (const itemId of new Set(lines.map((l) => l.itemId))) {
    const ordered = one<{ quantity: number }>(sql, 'SELECT quantity FROM wholesale_order_items WHERE id = ?', itemId)!.quantity;
    const already = Number(one<{ n: number }>(sql, 'SELECT coalesce(sum(quantity), 0) AS n FROM wholesale_order_receipt_lines WHERE order_item_id = ?', itemId)!.n);
    const asked = lines.filter((l) => l.itemId === itemId).reduce((n, l) => n + l.quantity, 0);
    if (asked > ordered - already) throw invalid('That is more than is still outstanding.');
  }

  insert(sql, 'wholesale_order_receipts', {
    id: receiptId,
    shop_id: ctx.shopId,
    order_id: orderId,
    received_at: ctx.now,
    received_by: ctx.userId,
    created_at: ctx.now,
    updated_at: ctx.now,
  });
  const keys: string[] = [];
  for (const line of lines) {
    const key = `wholesale:${receiptId}:${line.id}`;
    keys.push(`stock_in:${key}`);
    recordStockIn(call, sql, {
      p_batch_id: line.batchId,
      p_shop_id: ctx.shopId,
      p_product_id: line.productId,
      p_quantity: line.quantity,
      p_expiry_date: line.expiry,
      p_cost_price_per_unit: line.cost === null ? null : line.cost / 100,
      p_received_at: ctx.now,
      p_idempotency_key: key,
      p_supplier_name: supplier,
    });
    insert(sql, 'wholesale_order_receipt_lines', {
      id: line.id,
      shop_id: ctx.shopId,
      receipt_id: receiptId,
      order_item_id: line.itemId,
      batch_id: line.batchId,
      quantity: line.quantity,
      expiry_date: line.expiry,
      created_at: ctx.now,
      updated_at: ctx.now,
    });
  }

  let outstanding = 0;
  for (const item of sql.all<{ id: string; quantity: number }>(
    'SELECT id, quantity FROM wholesale_order_items WHERE shop_id = ? AND order_id = ? AND removed_at IS NULL',
    ctx.shopId,
    orderId
  )) {
    const already = Number(one<{ n: number }>(sql, 'SELECT coalesce(sum(quantity), 0) AS n FROM wholesale_order_receipt_lines WHERE order_item_id = ?', item.id)!.n);
    outstanding += Math.max(item.quantity - already, 0);
  }
  sql.run('UPDATE wholesale_orders SET status = ? WHERE id = ? AND shop_id = ?', outstanding === 0 ? 'received' : 'partially_received', orderId, ctx.shopId);
  return receiptResult(sql, ctx.shopId, receiptId, keys);
}
