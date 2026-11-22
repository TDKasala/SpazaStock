/**
 * Stock ledger, ported from the Postgres functions of the same names (supabase/migrations, final
 * versions). A shop's Durable Object runs one call at a time, which replaces the row locks
 * (`for update`) and advisory locks the Postgres versions used.
 */
import { conflict, invalid, notFound, forbidden } from '../db/errors';
import { toApiRow, toApiRows, type ApiRow } from '../db/rows';
import { one, type SyncSql } from '../db/sql';
import {
  assertShopRole,
  hasShopRole,
  shopToday,
  type ShopCall,
} from './context';
import {
  charLength,
  dateArg,
  get,
  idArg,
  insert,
  intArg,
  optionalCents,
  optionalId,
  optionalTrimmed,
  productStock,
  sellableStock,
  timestampArg,
  trimmed,
  uuid,
} from './common';

type Args = Record<string, unknown>;

function quantityArg(value: unknown): number {
  const q = intArg(value);
  if (q === null || q <= 0 || q > 1_000_000) throw invalid('Quantity must be a whole number from 1 to 1,000,000.');
  return q;
}

function batchResult(sql: SyncSql, shopId: string, batchId: string | null, duplicate: boolean, total?: number): ApiRow {
  const batch = batchId ? get(sql, 'stock_batches', batchId) : null;
  return {
    batch: toApiRow('stock_batches', batch),
    duplicate,
    total_quantity: total ?? (batch ? productStock(sql, shopId, String(batch.product_id)) : 0),
  };
}

function requireProduct(sql: SyncSql, shopId: string, productId: string | null): void {
  if (!productId || !one(sql, 'SELECT 1 AS x FROM products WHERE id = ? AND shop_id = ?', productId, shopId)) {
    throw notFound('Product not found in this shop.');
  }
}

/** public.record_stock_in */
export function recordStockIn({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertShopRole(ctx, ['owner', 'manager', 'staff']);
  const shopId = ctx.shopId;
  if (a.p_batch_id === null || a.p_batch_id === undefined) throw invalid('Batch id is required.');
  const batchId = idArg(a.p_batch_id, 'Batch id is required.');
  const productId = optionalId(a.p_product_id);
  const key = `stock_in:${optionalTrimmed(a.p_idempotency_key) ?? batchId}`;
  const lot = optionalTrimmed(a.p_lot_number);
  const supplier = optionalTrimmed(a.p_supplier_name);
  const quantity = quantityArg(a.p_quantity);
  const cost = optionalCents(a.p_cost_price_per_unit);
  if (cost !== null && cost < 0) throw invalid('Purchase cost cannot be negative.');
  if (charLength(key) > 300) throw invalid('Idempotency key is too long.');
  const packagingId = optionalId(a.p_packaging_id);
  const packages = intArg(a.p_package_quantity);
  if ((packagingId === null) !== (packages === null)) {
    throw invalid('A packaging needs a number of packages, and the other way round.');
  }
  if (lot !== null && charLength(lot) > 40) throw invalid('Lot number can be at most 40 characters.');
  if (supplier !== null && charLength(supplier) > 80) throw invalid('Supplier name can be at most 80 characters.');

  requireProduct(sql, shopId, productId);

  const existing = one<{ batch_id: string }>(
    sql,
    'SELECT batch_id FROM stock_movements WHERE shop_id = ? AND idempotency_key = ?',
    shopId,
    key
  );
  if (existing) return batchResult(sql, shopId, existing.batch_id, true, productStock(sql, shopId, productId!));

  const sameId = get(sql, 'stock_batches', batchId);
  if (sameId) {
    if (sameId.shop_id !== shopId || sameId.product_id !== productId) {
      throw conflict('This batch id is already used elsewhere.');
    }
    return batchResult(sql, shopId, batchId, true, productStock(sql, shopId, productId!));
  }

  let units: number | null = null;
  if (packagingId !== null) {
    const packaging = one<{ units_per_package: number }>(
      sql,
      'SELECT units_per_package FROM product_packagings WHERE id = ? AND shop_id = ? AND product_id = ?',
      packagingId,
      shopId,
      productId!
    );
    if (!packaging) throw notFound('Packaging not found for this product.');
    units = packaging.units_per_package;
    if (packages! <= 0 || packages! * units !== quantity) {
      throw invalid(`Quantity must be ${packages} packages × ${units} units.`);
    }
  }

  const barcodeId = optionalId(a.p_barcode_id);
  const barcode = barcodeId
    ? one<{ id: string }>(
        sql,
        'SELECT id FROM product_barcodes WHERE id = ? AND shop_id = ? AND product_id = ?',
        barcodeId,
        shopId,
        productId!
      )
    : null;

  const receivedAt = timestampArg(a.p_received_at, ctx.now);
  insert(sql, 'stock_batches', {
    id: batchId,
    shop_id: shopId,
    product_id: productId!,
    quantity,
    initial_quantity: quantity,
    expiry_date: dateArg(a.p_expiry_date),
    cost_price_per_unit_cents: cost,
    received_at: receivedAt,
    received_by: ctx.userId,
    packaging_id: packagingId,
    package_quantity: packages,
    units_per_package: units,
    received_barcode_id: barcode?.id ?? null,
    lot_number: lot,
    supplier_name: supplier,
    created_at: ctx.now,
    updated_at: ctx.now,
  });

  const total = productStock(sql, shopId, productId!);
  insert(sql, 'stock_movements', {
    id: uuid(),
    shop_id: shopId,
    product_id: productId!,
    batch_id: batchId,
    reason: 'stock_in',
    quantity_delta: quantity,
    resulting_total_quantity: total,
    idempotency_key: key,
    actor_id: ctx.userId,
    occurred_at: receivedAt,
    created_at: ctx.now,
    updated_at: ctx.now,
  });
  return batchResult(sql, shopId, batchId, false, total);
}

/** public.add_stock_to_batch */
export function addStockToBatch({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertShopRole(ctx, ['owner', 'manager', 'staff']);
  const shopId = ctx.shopId;
  const key = `stock_add:${optionalTrimmed(a.p_idempotency_key) ?? ''}`;
  if (a.p_batch_id === null || a.p_batch_id === undefined) throw invalid('Batch id is required.');
  const batchId = idArg(a.p_batch_id, 'Batch id is required.');
  const quantity = quantityArg(a.p_quantity);
  if (key === 'stock_add:' || charLength(key) > 300) throw invalid('Idempotency key is required.');

  const batch = one<{ product_id: string; quantity: number }>(
    sql,
    'SELECT product_id, quantity FROM stock_batches WHERE id = ? AND shop_id = ?',
    batchId,
    shopId
  );
  if (!batch) throw notFound('Batch not found in this shop.');

  const existing = one<{ batch_id: string }>(
    sql,
    'SELECT batch_id FROM stock_movements WHERE shop_id = ? AND idempotency_key = ?',
    shopId,
    key
  );
  if (existing) return batchResult(sql, shopId, existing.batch_id, true);

  if (batch.quantity + quantity > 1_000_000) throw invalid('A batch can hold at most 1,000,000 units.');
  sql.run(
    'UPDATE stock_batches SET quantity = quantity + ?, initial_quantity = initial_quantity + ? WHERE id = ?',
    quantity,
    quantity,
    batchId
  );
  const total = productStock(sql, shopId, batch.product_id);
  insert(sql, 'stock_movements', {
    id: uuid(),
    shop_id: shopId,
    product_id: batch.product_id,
    batch_id: batchId,
    reason: 'stock_in',
    quantity_delta: quantity,
    resulting_total_quantity: total,
    idempotency_key: key,
    actor_id: ctx.userId,
    occurred_at: ctx.now,
    created_at: ctx.now,
    updated_at: ctx.now,
  });
  return batchResult(sql, shopId, batchId, false, total);
}

const ADJUSTMENT_REASONS = ['adjustment', 'write_off_expired', 'write_off_damaged', 'count_correction', 'return'];

/** public.record_stock_adjustment */
export function recordStockAdjustment({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertShopRole(ctx, ['owner', 'manager']);
  const shopId = ctx.shopId;
  const rawKey = trimmed(a.p_idempotency_key);
  const key = `adjustment:${rawKey}`;
  if (rawKey === '' || charLength(key) > 300) throw invalid('Idempotency key is required (up to 288 characters).');
  const delta = intArg(a.p_quantity_delta);
  if (delta === null || delta === 0 || Math.abs(delta) > 1_000_000) {
    throw invalid('Quantity change must be a non-zero whole number up to 1,000,000.');
  }
  const reason = a.p_reason;
  if (typeof reason !== 'string' || !ADJUSTMENT_REASONS.includes(reason)) throw invalid('Unknown adjustment reason.');
  if ((reason === 'write_off_expired' || reason === 'write_off_damaged') && delta > 0) {
    throw invalid('A write-off must reduce stock.');
  }
  if (reason === 'return' && delta < 0) throw invalid('A return must add stock.');

  const batchId = optionalId(a.p_batch_id);
  const batch = batchId
    ? one<{ product_id: string; quantity: number }>(
        sql,
        'SELECT product_id, quantity FROM stock_batches WHERE id = ? AND shop_id = ?',
        batchId,
        shopId
      )
    : null;
  if (!batch) throw notFound('Batch not found in this shop.');

  const movement = one(sql, 'SELECT * FROM stock_movements WHERE shop_id = ? AND idempotency_key = ?', shopId, key);
  if (movement) {
    return {
      batch: toApiRow('stock_batches', get(sql, 'stock_batches', batchId!)),
      movement: toApiRow('stock_movements', movement),
      duplicate: true,
      total_quantity: productStock(sql, shopId, batch.product_id),
    };
  }
  if (batch.quantity + delta < 0) throw invalid(`Only ${batch.quantity} units are left in this batch.`);

  sql.run('UPDATE stock_batches SET quantity = quantity + ? WHERE id = ?', delta, batchId!);
  const total = productStock(sql, shopId, batch.product_id);
  const movementId = uuid();
  insert(sql, 'stock_movements', {
    id: movementId,
    shop_id: shopId,
    product_id: batch.product_id,
    batch_id: batchId!,
    reason,
    quantity_delta: delta,
    resulting_total_quantity: total,
    idempotency_key: key,
    actor_id: ctx.userId,
    occurred_at: timestampArg(a.p_occurred_at, ctx.now),
    created_at: ctx.now,
    updated_at: ctx.now,
  });
  return {
    batch: toApiRow('stock_batches', get(sql, 'stock_batches', batchId!)),
    movement: toApiRow('stock_movements', get(sql, 'stock_movements', movementId)),
    duplicate: false,
    total_quantity: total,
  };
}

interface SaleLine {
  ord: number;
  id: string;
  productId: string;
  quantity: number;
  unitPriceCents: number;
}

function saleLines(items: unknown): SaleLine[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw invalid('A sale needs 1 to 100 items.');
  const message =
    'Each item needs an id, a product, a quantity from 1 to 1,000,000 and a non-negative price.';
  const lines = items.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(message);
    const o = item as Record<string, unknown>;
    const id = o.id == null ? null : idArg(o.id, message);
    const productId = o.product_id == null ? null : idArg(o.product_id, message);
    const quantity = intArg(o.quantity);
    const unitPriceCents = optionalCents(o.unit_price) ?? 0;
    if (!id || !productId || quantity === null || quantity <= 0 || quantity > 1_000_000 || unitPriceCents < 0) {
      throw invalid(message);
    }
    return { ord: i + 1, id, productId, quantity, unitPriceCents };
  });
  if (new Set(lines.map((l) => l.id)).size !== lines.length) throw invalid('Item ids must be unique.');
  return lines;
}

function saleResult(sql: SyncSql, ctx: ShopCall['ctx'], saleId: string, duplicate: boolean, shortfall: number): ApiRow {
  const sale = get(sql, 'sales', saleId);
  const items = sql.all('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY created_at, id', saleId);
  const products = [...new Set(items.map((i) => String(i.product_id)))];
  const today = shopToday(ctx);
  return {
    sale: toApiRow('sales', sale),
    items: toApiRows('sale_items', items),
    stock_totals: Object.fromEntries(products.map((p) => [p, productStock(sql, ctx.shopId, p)])),
    sellable_totals: Object.fromEntries(products.map((p) => [p, sellableStock(sql, ctx.shopId, p, today)])),
    duplicate,
    shortfall,
  };
}

/** public.record_sale: first-expired-first-out, never below zero; a shortfall is recorded for a recount. */
export function recordSale(call: ShopCall, sql: SyncSql, a: Args): ApiRow {
  const { ctx } = call;
  assertShopRole(ctx, ['owner', 'manager', 'staff']);
  const shopId = ctx.shopId;
  const key = trimmed(a.p_idempotency_key);
  const soldAt = timestampArg(a.p_sold_at, ctx.now);
  if (a.p_sale_id === null || a.p_sale_id === undefined) throw invalid('Sale id is required.');
  const saleId = idArg(a.p_sale_id, 'Sale id is required.');
  if (key === '' || charLength(key) > 200) throw invalid('Idempotency key is required (up to 200 characters).');
  const lines = saleLines(a.p_items);

  const productIds = [...new Set(lines.map((l) => l.productId))];
  const found = sql.all<{ id: string; name: string }>(
    `SELECT id, name FROM products WHERE shop_id = ? AND id IN (${productIds.map(() => '?').join(', ')})`,
    shopId,
    ...productIds
  );
  if (found.length !== productIds.length) throw notFound('Product not found in this shop.');
  const names = new Map(found.map((p) => [p.id, p.name]));

  const existing = one<{ id: string }>(
    sql,
    'SELECT id FROM sales WHERE shop_id = ? AND (id = ? OR idempotency_key = ?) LIMIT 1',
    shopId,
    saleId,
    key
  );
  if (existing) return saleResult(sql, ctx, existing.id, true, 0);

  const today = shopToday(ctx, soldAt);
  insert(sql, 'sales', {
    id: saleId,
    shop_id: shopId,
    idempotency_key: key,
    total_amount_cents: lines.reduce((n, l) => n + l.unitPriceCents * l.quantity, 0),
    item_count: lines.length,
    sold_by: ctx.userId,
    sold_at: soldAt,
    created_at: ctx.now,
    updated_at: ctx.now,
  });

  let shortfall = 0;
  for (const line of lines) {
    insert(sql, 'sale_items', {
      id: line.id,
      shop_id: shopId,
      sale_id: saleId,
      product_id: line.productId,
      quantity: line.quantity,
      unit_price_cents: line.unitPriceCents,
      line_total_cents: line.unitPriceCents * line.quantity,
      created_at: ctx.now,
      updated_at: ctx.now,
    });

    let remaining = line.quantity;
    let total = productStock(sql, shopId, line.productId);
    const allocations: { batchId: string; quantityDeducted: number; batchExpiryDate: string | null }[] = [];
    const batches = sql.all<{ id: string; quantity: number; expiry_date: string | null }>(
      `SELECT id, quantity, expiry_date FROM stock_batches
        WHERE shop_id = ? AND product_id = ? AND quantity > 0 AND (expiry_date IS NULL OR expiry_date >= ?)
        ORDER BY expiry_date IS NULL, expiry_date, received_at, id`,
      shopId,
      line.productId,
      today
    );
    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(batch.quantity, remaining);
      remaining -= take;
      total -= take;
      sql.run('UPDATE stock_batches SET quantity = quantity - ? WHERE id = ?', take, batch.id);
      insert(sql, 'stock_movements', {
        id: uuid(),
        shop_id: shopId,
        product_id: line.productId,
        batch_id: batch.id,
        sale_id: saleId,
        sale_item_id: line.id,
        reason: 'sale',
        quantity_delta: -take,
        resulting_total_quantity: total,
        idempotency_key: `sale:${key}:${line.id}:${batch.id}`,
        actor_id: ctx.userId,
        occurred_at: soldAt,
        created_at: ctx.now,
        updated_at: ctx.now,
      });
      allocations.push({ batchId: batch.id, quantityDeducted: take, batchExpiryDate: batch.expiry_date });
    }
    sql.run('UPDATE sale_items SET allocations = ? WHERE id = ?', JSON.stringify(allocations), line.id);

    if (remaining > 0) {
      shortfall += remaining;
      insert(sql, 'stock_discrepancies', {
        id: uuid(),
        shop_id: shopId,
        product_id: line.productId,
        sale_id: saleId,
        sale_item_id: line.id,
        shortfall: remaining,
        created_at: ctx.now,
        updated_at: ctx.now,
      });
      call.effects.push({
        kind: 'notify_roles',
        roles: ['owner', 'manager'],
        type: 'stock_discrepancy',
        title: 'Stock needs a recount',
        body: `${remaining} units of ${names.get(line.productId)} were sold without recorded stock.`,
        data: { product_id: line.productId, sale_id: saleId, sale_item_id: line.id, shortfall: remaining },
      });
    }
  }
  return saleResult(sql, ctx, saleId, false, shortfall);
}

function voidResult(sql: SyncSql, saleItemId: string, duplicate: boolean): ApiRow {
  const item = get(sql, 'sale_items', saleItemId)!;
  return {
    sale: toApiRow('sales', get(sql, 'sales', String(item.sale_id))),
    item: toApiRow('sale_items', item),
    stock_total: productStock(sql, String(item.shop_id), String(item.product_id)),
    duplicate,
  };
}

/** public.void_sale_item: returns units to the batches they came from, last allocation first. */
export function voidSaleItem({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertShopRole(ctx, ['owner', 'manager', 'staff']);
  const shopId = ctx.shopId;
  const key = trimmed(a.p_idempotency_key);
  const occurredAt = timestampArg(a.p_occurred_at, ctx.now);
  if (a.p_sale_item_id === null || a.p_sale_item_id === undefined) throw invalid('Sale item id is required.');
  const itemId = idArg(a.p_sale_item_id, 'Sale item id is required.');
  if (key === '' || charLength(key) > 200) throw invalid('Idempotency key is required (up to 200 characters).');
  const quantity = quantityArg(a.p_quantity);

  const item = one<{
    id: string;
    sale_id: string;
    product_id: string;
    quantity: number;
    voided_quantity: number;
    allocations: string;
  }>(sql, 'SELECT * FROM sale_items WHERE id = ? AND shop_id = ?', itemId, shopId);
  if (!item) throw notFound('Sale item not found in this shop.');
  const sale = one<{ sold_by: string | null; sold_at: string }>(sql, 'SELECT sold_by, sold_at FROM sales WHERE id = ?', item.sale_id)!;

  const existing = one<{ sale_item_id: string }>(
    sql,
    'SELECT sale_item_id FROM sale_item_voids WHERE shop_id = ? AND idempotency_key = ?',
    shopId,
    key
  );
  if (existing) return voidResult(sql, existing.sale_item_id, true);

  if (!hasShopRole(ctx, ['owner', 'manager'])) {
    const at = Date.parse(occurredAt);
    const soldAt = Date.parse(sale.sold_at);
    if (
      sale.sold_by !== ctx.userId ||
      at < soldAt ||
      at > soldAt + 15 * 60_000 ||
      at > Date.parse(ctx.now) + 5 * 60_000
    ) {
      throw forbidden('Staff can only undo their own sales within 15 minutes.');
    }
  }
  const voidable = item.quantity - item.voided_quantity;
  if (quantity > voidable) throw invalid(`Only ${voidable} units of this sale can still be voided.`);

  const allocations = JSON.parse(item.allocations || '[]') as { batchId: string; quantityDeducted: number }[];
  const allocated = allocations.reduce((n, x) => n + Number(x.quantityDeducted ?? 0), 0);
  const shortfall = Math.max(item.quantity - allocated, 0);
  // Units already returned by earlier voids, and the units this void returns to batches.
  let skip = item.voided_quantity - Math.min(item.voided_quantity, shortfall);
  let remaining = quantity - Math.min(quantity, shortfall - Math.min(item.voided_quantity, shortfall));
  let total = productStock(sql, shopId, item.product_id);

  for (const alloc of [...allocations].reverse()) {
    if (remaining <= 0) break;
    let available = Number(alloc.quantityDeducted);
    const skipped = Math.min(skip, available);
    skip -= skipped;
    available -= skipped;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    remaining -= take;
    total += take;
    const changed = sql.run(
      'UPDATE stock_batches SET quantity = quantity + ? WHERE id = ? AND shop_id = ?',
      take,
      alloc.batchId,
      shopId
    );
    if (changed === 0) throw notFound('Batch not found in this shop.');
    insert(sql, 'stock_movements', {
      id: uuid(),
      shop_id: shopId,
      product_id: item.product_id,
      batch_id: alloc.batchId,
      sale_id: item.sale_id,
      sale_item_id: item.id,
      reason: 'return',
      quantity_delta: take,
      resulting_total_quantity: total,
      idempotency_key: `void:${key}:${alloc.batchId}`,
      actor_id: ctx.userId,
      occurred_at: occurredAt,
      created_at: ctx.now,
      updated_at: ctx.now,
    });
  }

  sql.run('UPDATE sale_items SET voided_quantity = voided_quantity + ? WHERE id = ?', quantity, item.id);
  insert(sql, 'sale_item_voids', {
    id: uuid(),
    shop_id: shopId,
    sale_id: item.sale_id,
    sale_item_id: item.id,
    quantity,
    idempotency_key: key,
    voided_by: ctx.userId,
    occurred_at: occurredAt,
    created_at: ctx.now,
  });
  return voidResult(sql, item.id, false);
}

const EXPIRY_ACTIONS = ['discarded', 'returned_to_supplier', 'expiry_corrected'];

/** public.resolve_expired_batch */
export function resolveExpiredBatch({ ctx }: ShopCall, sql: SyncSql, a: Args): ApiRow {
  assertShopRole(ctx, ['owner', 'manager']);
  const shopId = ctx.shopId;
  const key = trimmed(a.p_idempotency_key);
  const occurredAt = timestampArg(a.p_occurred_at, ctx.now);
  if (key === '' || charLength(key) > 200) throw invalid('Idempotency key is required (up to 200 characters).');
  const action = a.p_action;
  if (typeof action !== 'string' || !EXPIRY_ACTIONS.includes(action)) throw invalid('Unknown action.');
  const newExpiry = dateArg(a.p_new_expiry_date);
  if (action === 'expiry_corrected' && newExpiry === null) throw invalid('A corrected expiry date is required.');
  const note = a.p_note === null || a.p_note === undefined ? null : String(a.p_note);
  if (note !== null && charLength(note) > 500) throw invalid('Note is too long (500 characters).');

  const batchId = optionalId(a.p_batch_id);
  const batch = batchId
    ? one<{ product_id: string; quantity: number; expiry_date: string | null }>(
        sql,
        'SELECT product_id, quantity, expiry_date FROM stock_batches WHERE id = ? AND shop_id = ?',
        batchId,
        shopId
      )
    : null;
  if (!batch) throw notFound('Batch not found in this shop.');

  const existing = one(sql, 'SELECT * FROM expiry_resolutions WHERE shop_id = ? AND idempotency_key = ?', shopId, key);
  if (existing) {
    return {
      resolution: toApiRow('expiry_resolutions', existing),
      batch: toApiRow('stock_batches', get(sql, 'stock_batches', batchId!)),
      duplicate: true,
      total_quantity: productStock(sql, shopId, batch.product_id),
    };
  }

  const previous = batch.expiry_date;
  let quantity = 0;
  let movementId: string | null = null;
  if (action === 'expiry_corrected') {
    sql.run('UPDATE stock_batches SET expiry_date = ? WHERE id = ?', newExpiry, batchId!);
  } else {
    if (batch.quantity <= 0) throw invalid('This batch has no units left.');
    quantity = batch.quantity;
    sql.run('UPDATE stock_batches SET quantity = 0 WHERE id = ?', batchId!);
    const total = productStock(sql, shopId, batch.product_id);
    movementId = uuid();
    insert(sql, 'stock_movements', {
      id: movementId,
      shop_id: shopId,
      product_id: batch.product_id,
      batch_id: batchId!,
      reason: action === 'discarded' ? 'write_off_expired' : 'supplier_return',
      quantity_delta: -quantity,
      resulting_total_quantity: total,
      idempotency_key: `expiry:${key}`,
      actor_id: ctx.userId,
      occurred_at: occurredAt,
      created_at: ctx.now,
      updated_at: ctx.now,
    });
  }

  sql.run(
    'UPDATE expiry_alerts SET resolved_at = ?, resolution = ? WHERE batch_id = ? AND resolved_at IS NULL',
    ctx.now,
    action,
    batchId!
  );
  const resolutionId = uuid();
  insert(sql, 'expiry_resolutions', {
    id: resolutionId,
    shop_id: shopId,
    batch_id: batchId!,
    product_id: batch.product_id,
    action,
    quantity,
    previous_expiry_date: previous,
    new_expiry_date: action === 'expiry_corrected' ? newExpiry : previous,
    note: optionalTrimmed(note),
    movement_id: movementId,
    idempotency_key: key,
    resolved_by: ctx.userId,
    occurred_at: occurredAt,
    created_at: ctx.now,
  });
  return {
    resolution: toApiRow('expiry_resolutions', get(sql, 'expiry_resolutions', resolutionId)),
    batch: toApiRow('stock_batches', get(sql, 'stock_batches', batchId!)),
    duplicate: false,
    total_quantity: productStock(sql, shopId, batch.product_id),
  };
}
