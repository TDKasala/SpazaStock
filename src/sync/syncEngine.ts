import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BatchAllocation,
  ExpiryAlert,
  ExpiryAlertKind,
  ExpiryAlertResolution,
  Product,
  ProductBarcode,
  ProductCategory,
  ProductPackaging,
  Sale,
  StockBatch,
  StockDiscrepancy,
} from '../types';
import { db, getMeta, setMeta, withWriteLock, WRITE_TABLES, type OutboxItem } from '../lib/db';

export const MAX_ATTEMPTS = 10;
const PULL_PAGE_SIZE = 500;
/** Re-read a little before the cursor so rows committed out of order are not skipped. */
const PULL_OVERLAP_MS = 2 * 60 * 1000;
const SALES_HISTORY_DAYS = 7;
const PRODUCT_COLUMNS =
  'id, shop_id, barcode, name, category, buying_price, selling_price, created_at, updated_at, archived_at, brand, size';
const BATCH_COLUMNS =
  'id, shop_id, product_id, quantity, initial_quantity, expiry_date, cost_price_per_unit, received_at, updated_at, ' +
  'packaging_id, package_quantity, units_per_package, received_barcode_id';
const PACKAGING_COLUMNS = 'id, shop_id, product_id, name, units_per_package, created_at, updated_at, retired_at';
const BARCODE_COLUMNS =
  'id, shop_id, product_id, packaging_id, barcode, created_at, updated_at, unlinked_at, unlink_reason';

// Error classification ---------------------------------------------------------

export interface SyncErrorLike {
  code?: string;
  message?: string;
}

/**
 * Postgres classes 22 (bad data), 23 (constraint), 42 (permission/RLS) and P0 (raised by our
 * functions) will fail the same way every time. Anything else - network failures, timeouts,
 * expired JWTs, missing functions while migrations are pending - is worth retrying.
 */
export function isPermanentError(error: SyncErrorLike): boolean {
  const code = error.code ?? '';
  return ['22', '23', '42', 'P0'].some((prefix) => code.startsWith(prefix));
}

/** Why the server is holding changes back until an administrator or a plan change lifts it. */
export type SyncBlock = 'suspended' | 'plan_limit';

/** SP001: the shop is suspended. SP002: the shop's plan does not allow the change. */
export function blockedReason(error: SyncErrorLike): SyncBlock | null {
  if (error.code === 'SP001') return 'suspended';
  if (error.code === 'SP002') return 'plan_limit';
  return null;
}

/** How long a blocked queue waits before asking the server again. */
export const BLOCKED_RETRY_MS = 10 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 10 * 60 * 1000);
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

// Row mappers --------------------------------------------------------------------

type Row = Record<string, unknown>;

function toIso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function mapProductRow(row: Row): Product {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    barcode: String(row.barcode),
    name: String(row.name),
    category: row.category as ProductCategory,
    buyingPrice: toNumberOrNull(row.buying_price),
    sellingPrice: toNumberOrNull(row.selling_price),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    archivedAt: row.archived_at ? toIso(row.archived_at) : null,
    brand: (row.brand as string | null) ?? null,
    size: (row.size as string | null) ?? null,
  };
}

export function mapBatchRow(row: Row): StockBatch {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    productId: String(row.product_id),
    quantity: Number(row.quantity),
    initialQuantity: Number(row.initial_quantity),
    expiryDate: (row.expiry_date as string | null) ?? null,
    costPricePerUnit: toNumberOrNull(row.cost_price_per_unit),
    receivedAt: toIso(row.received_at),
    packagingId: (row.packaging_id as string | null) ?? null,
    packageQuantity: toNumberOrNull(row.package_quantity),
    unitsPerPackage: toNumberOrNull(row.units_per_package),
    receivedBarcodeId: (row.received_barcode_id as string | null) ?? null,
  };
}

export function mapPackagingRow(row: Row): ProductPackaging {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    productId: String(row.product_id),
    name: String(row.name),
    unitsPerPackage: Number(row.units_per_package),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    retiredAt: row.retired_at ? toIso(row.retired_at) : null,
  };
}

export function mapBarcodeRow(row: Row): ProductBarcode {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    productId: String(row.product_id),
    packagingId: (row.packaging_id as string | null) ?? null,
    barcode: String(row.barcode),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    unlinkedAt: row.unlinked_at ? toIso(row.unlinked_at) : null,
    unlinkReason: (row.unlink_reason as string | null) ?? null,
  };
}

/**
 * A local sale is one sale line. `header` is the server's sales row (sold_at, idempotency_key);
 * when omitted it is read from the embedded `sales` relation of a pulled sale_items row.
 */
export function mapSaleItemRow(item: Row, header?: Row): Sale {
  const sale = header ?? (item.sales as Row);
  return {
    id: String(item.id),
    shopId: String(item.shop_id),
    productId: String(item.product_id),
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
    totalAmount: Number(item.line_total),
    allocations: (item.allocations as BatchAllocation[]) ?? [],
    idempotencyKey: String(sale.idempotency_key),
    createdAt: toIso(sale.sold_at),
    voidedQuantity: Number(item.voided_quantity ?? 0),
  };
}

export function mapDiscrepancyRow(row: Row): StockDiscrepancy {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    productId: String(row.product_id),
    saleId: (row.sale_id as string | null) ?? null,
    shortfall: Number(row.shortfall),
    resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
    createdAt: toIso(row.created_at),
  };
}

export function mapExpiryAlertRow(row: Row): ExpiryAlert {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    batchId: String(row.batch_id),
    productId: String(row.product_id),
    kind: row.kind as ExpiryAlertKind,
    thresholdDays: toNumberOrNull(row.threshold_days),
    expiryDate: String(row.expiry_date),
    quantity: Number(row.quantity),
    alertDate: String(row.alert_date),
    resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
    resolution: (row.resolution as ExpiryAlertResolution | null) ?? null,
    createdAt: toIso(row.created_at),
  };
}

// Push -----------------------------------------------------------------------------

type SendOutcome =
  | { kind: 'ok'; apply?: () => Promise<void> }
  | { kind: 'retry'; error: string }
  /** Held back by the server (suspension, plan limit): kept as is, never given up on. */
  | { kind: 'blocked'; error: string; reason: SyncBlock }
  /** `apply` brings the local copy back in line with the server after a rejected change. */
  | { kind: 'fail'; error: string; code?: string; apply?: () => Promise<void> };

function outcomeFromError(error: SyncErrorLike): SendOutcome {
  const message = error.message || 'Unknown sync error';
  const reason = blockedReason(error);
  if (reason) return { kind: 'blocked', error: message, reason };
  return isPermanentError(error)
    ? { kind: 'fail', error: message, code: error.code }
    : { kind: 'retry', error: message };
}

/**
 * Moves every local reference from a device-generated product ID to the canonical server ID.
 * Happens when two devices registered the same barcode before either had synced.
 */
async function remapProduct(shopId: string, oldId: string, canonical: Product): Promise<void> {
  await db.products.delete(oldId);
  await db.products.put(canonical);
  await db.batches.where('productId').equals(oldId).modify({ productId: canonical.id });
  await db.movements.where('productId').equals(oldId).modify({ productId: canonical.id });
  await db.sales.where('productId').equals(oldId).modify({ productId: canonical.id });
  await db.discrepancies.where('productId').equals(oldId).modify({ productId: canonical.id });
  await db.expiryAlerts.where('productId').equals(oldId).modify({ productId: canonical.id });
  await db.packagings.where('productId').equals(oldId).modify({ productId: canonical.id });
  await db.barcodes.where('productId').equals(oldId).modify({ productId: canonical.id });
  await db.outbox
    .where('shopId')
    .equals(shopId)
    .modify((item: OutboxItem) => {
      if (item.type === 'stock_in' && item.payload.batch.productId === oldId) {
        item.payload.batch.productId = canonical.id;
      } else if (item.type === 'sale' && item.payload.sale.productId === oldId) {
        item.payload.sale.productId = canonical.id;
      } else if (
        (item.type === 'product_update' || item.type === 'product_archive') &&
        item.payload.productId === oldId
      ) {
        item.payload.productId = canonical.id;
      } else if (item.type === 'packaging_create' && item.payload.packaging.productId === oldId) {
        item.payload.packaging.productId = canonical.id;
      } else if (item.type === 'barcode_link' && item.payload.link.productId === oldId) {
        item.payload.link.productId = canonical.id;
      }
    });
}

/**
 * Moves references from a local barcode link to `replacement` (the same link made first on
 * another phone), or clears them when the server refused the link (null). Deliveries stay: they
 * were recorded against the product the owner confirmed, not against the barcode.
 */
async function replaceBarcodeLink(shopId: string, oldId: string, replacement: ProductBarcode | null): Promise<void> {
  await db.barcodes.delete(oldId);
  if (replacement) await db.barcodes.put(replacement);
  const newId = replacement?.id ?? null;
  await db.batches.where('shopId').equals(shopId).filter((b) => b.receivedBarcodeId === oldId).modify({
    receivedBarcodeId: newId,
  });
  const queued = await db.outbox.where('shopId').equals(shopId).toArray();
  for (const other of queued) {
    if (other.type === 'stock_in' && other.payload.batch.receivedBarcodeId === oldId) {
      other.payload.batch.receivedBarcodeId = newId;
      await db.outbox.put(other);
    } else if (other.type === 'barcode_unlink' && other.payload.barcodeId === oldId) {
      if (newId) {
        other.payload.barcodeId = newId;
        await db.outbox.put(other);
      } else {
        await db.outbox.delete(other.seq!);
      }
    }
  }
}

/**
 * After the server refused a product edit (barcode taken, role lowered, ...), the local copy holds
 * values the server never accepted. Re-read the server row so the phone shows the truth again.
 */
async function productRollback(
  client: SupabaseClient,
  shopId: string,
  productId: string
): Promise<Product | null> {
  try {
    const { data, error } = await client
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('shop_id', shopId)
      .eq('id', productId)
      .maybeSingle();
    return error || !data ? null : mapProductRow(data as unknown as Row);
  } catch {
    return null;
  }
}

/** Edits queued after `item` are already shown locally and must not be overwritten. */
async function hasLaterProductChange(item: OutboxItem, productId: string): Promise<boolean> {
  const later = await db.outbox
    .where('shopId')
    .equals(item.shopId)
    .filter(
      (other) =>
        other.seq! > item.seq! &&
        (other.type === 'product_update' || other.type === 'product_archive') &&
        other.payload.productId === productId
    )
    .count();
  return later > 0;
}

function putProductUnlessChangedLater(item: OutboxItem, product: Product): () => Promise<void> {
  return async () => {
    if (!(await hasLaterProductChange(item, product.id))) await db.products.put(product);
  };
}

async function sendProductChange(
  client: SupabaseClient,
  item: OutboxItem,
  productId: string,
  call: PromiseLike<{ data: unknown; error: SyncErrorLike | null }>
): Promise<SendOutcome> {
  const { data, error } = await call;
  if (error) {
    const outcome = outcomeFromError(error);
    if (outcome.kind !== 'fail') return outcome;
    const server = await productRollback(client, item.shopId, productId);
    return server ? { ...outcome, apply: putProductUnlessChangedLater(item, server) } : outcome;
  }
  return { kind: 'ok', apply: putProductUnlessChangedLater(item, mapProductRow(data as Row)) };
}

/**
 * Stores the server's copy of a just-pushed sale. Voids still queued behind it are already
 * counted locally, so the larger voided quantity wins until they reach the server.
 */
async function putPushedSale(sale: Sale): Promise<void> {
  const local = await db.sales.get(sale.id);
  const voidedQuantity = Math.max(sale.voidedQuantity ?? 0, local?.voidedQuantity ?? 0);
  await db.sales.put({ ...sale, voidedQuantity });
}

async function sendItem(client: SupabaseClient, item: OutboxItem): Promise<SendOutcome> {
  switch (item.type) {
    case 'product_upsert': {
      const p = item.payload.product;
      const { data, error } = await client.rpc('upsert_product', {
        p_id: p.id,
        p_shop_id: item.shopId,
        p_barcode: p.barcode,
        p_name: p.name,
        p_category: p.category,
        p_buying_price: p.buyingPrice ?? null,
        p_selling_price: p.sellingPrice ?? null,
        p_created_at: p.createdAt,
        ...(p.brand ? { p_brand: p.brand } : {}),
        ...(p.size ? { p_size: p.size } : {}),
      });
      if (error) return outcomeFromError(error);
      const canonical = mapProductRow(data as Row);
      return {
        kind: 'ok',
        apply: async () => {
          if (canonical.id !== p.id) await remapProduct(item.shopId, p.id, canonical);
          else await putProductUnlessChangedLater(item, canonical)();
        },
      };
    }

    case 'product_update': {
      const { productId, changes } = item.payload;
      return sendProductChange(
        client,
        item,
        productId,
        client.rpc('update_product', {
          p_shop_id: item.shopId,
          p_product_id: productId,
          p_barcode: changes.barcode,
          p_name: changes.name,
          p_category: changes.category,
          p_buying_price: changes.buyingPrice ?? null,
          p_selling_price: changes.sellingPrice ?? null,
          // Left out (edits queued before brand and size existed): the server keeps the values.
          // Null: the user cleared the field, sent as '' because the server treats null as "keep".
          ...(changes.brand !== undefined ? { p_brand: changes.brand ?? '' } : {}),
          ...(changes.size !== undefined ? { p_size: changes.size ?? '' } : {}),
        })
      );
    }

    case 'product_archive': {
      const { productId, archived } = item.payload;
      return sendProductChange(
        client,
        item,
        productId,
        client.rpc('set_product_archived', {
          p_shop_id: item.shopId,
          p_product_id: productId,
          p_archived: archived,
        })
      );
    }

    case 'stock_in': {
      const { batch, idempotencyKey } = item.payload;
      const base = {
        p_batch_id: batch.id,
        p_shop_id: item.shopId,
        p_product_id: batch.productId,
        p_quantity: batch.initialQuantity,
        p_expiry_date: batch.expiryDate,
        p_cost_price_per_unit: batch.costPricePerUnit ?? null,
        p_received_at: batch.receivedAt,
        p_idempotency_key: idempotencyKey ?? batch.id,
      };
      const { error } = await client.rpc('record_stock_in', {
        ...base,
        ...(batch.packagingId
          ? { p_packaging_id: batch.packagingId, p_package_quantity: batch.packageQuantity ?? null }
          : {}),
        ...(batch.receivedBarcodeId ? { p_barcode_id: batch.receivedBarcodeId } : {}),
      });
      if (!error) return { kind: 'ok' };
      // The packaging never reached the server (its creation was refused): keep the units anyway.
      if (error.code === 'P0002' && batch.packagingId) {
        const retry = await client.rpc('record_stock_in', base);
        if (!retry.error) {
          return {
            kind: 'ok',
            apply: async () => {
              await db.batches.update(batch.id, {
                packagingId: null,
                packageQuantity: null,
                unitsPerPackage: null,
                receivedBarcodeId: null,
              });
            },
          };
        }
        return outcomeFromError(retry.error);
      }
      return outcomeFromError(error);
    }

    case 'sale': {
      // Each local sale is a one-line server sale; the line reuses the sale id so pulled
      // sale_items rows map back onto the same local record.
      const { sale } = item.payload;
      const { data, error } = await client.rpc('record_sale', {
        p_sale_id: sale.id,
        p_shop_id: item.shopId,
        p_idempotency_key: sale.idempotencyKey,
        p_sold_at: sale.createdAt,
        p_items: [{ id: sale.id, product_id: sale.productId, quantity: sale.quantity, unit_price: sale.unitPrice }],
      });
      if (error) return outcomeFromError(error);
      const result = data as { sale?: Row; items?: Row[] } | null;
      const line = result?.items?.find((row) => row.id === sale.id);
      return {
        kind: 'ok',
        apply: async () => {
          if (result?.sale && line) await putPushedSale(mapSaleItemRow(line, result.sale));
        },
      };
    }

    case 'sale_void': {
      // The local sale id is also the server sale line id (see the 'sale' case).
      const { saleId, quantity, idempotencyKey, occurredAt } = item.payload;
      const { data, error } = await client.rpc('void_sale_item', {
        p_shop_id: item.shopId,
        p_sale_item_id: saleId,
        p_quantity: quantity,
        p_occurred_at: occurredAt,
        p_idempotency_key: idempotencyKey,
      });
      if (error) return outcomeFromError(error);
      const result = data as { sale?: Row; item?: Row } | null;
      return {
        kind: 'ok',
        apply: async () => {
          if (result?.sale && result.item) await putPushedSale(mapSaleItemRow(result.item, result.sale));
        },
      };
    }

    case 'discrepancy_resolve': {
      const { error } = await client
        .from('stock_discrepancies')
        .update({ resolved_at: item.payload.resolvedAt })
        .eq('id', item.payload.id);
      return error ? outcomeFromError(error) : { kind: 'ok' };
    }

    case 'expiry_resolve': {
      const { batchId, action, newExpiryDate, note, idempotencyKey, occurredAt } = item.payload;
      const { data, error } = await client.rpc('resolve_expired_batch', {
        p_shop_id: item.shopId,
        p_batch_id: batchId,
        p_action: action,
        p_new_expiry_date: newExpiryDate,
        p_note: note,
        p_occurred_at: occurredAt,
        p_idempotency_key: idempotencyKey,
      });
      if (error) return outcomeFromError(error);
      const batch = (data as { batch?: Row } | null)?.batch;
      return {
        kind: 'ok',
        apply: async () => {
          if (batch) await db.batches.put(mapBatchRow(batch));
        },
      };
    }

    case 'packaging_create': {
      const p = item.payload.packaging;
      const { data, error } = await client.rpc('create_product_packaging', {
        p_id: p.id,
        p_shop_id: item.shopId,
        p_product_id: p.productId,
        p_name: p.name,
        p_units_per_package: p.unitsPerPackage,
        p_created_at: p.createdAt,
      });
      if (error) return outcomeFromError(error);
      const packaging = mapPackagingRow(data as Row);
      return { kind: 'ok', apply: () => db.packagings.put(packaging).then(() => undefined) };
    }

    case 'packaging_retire': {
      const { data, error } = await client.rpc('retire_product_packaging', {
        p_shop_id: item.shopId,
        p_packaging_id: item.payload.packagingId,
      });
      if (error) return outcomeFromError(error);
      const packaging = mapPackagingRow(data as Row);
      return { kind: 'ok', apply: () => db.packagings.put(packaging).then(() => undefined) };
    }

    case 'barcode_link': {
      const { link } = item.payload;
      const { data, error } = await client.rpc('link_product_barcode', {
        p_id: link.id,
        p_shop_id: item.shopId,
        p_product_id: link.productId,
        p_packaging_id: link.packagingId,
        p_barcode: link.barcode,
        p_created_at: link.createdAt,
      });
      if (error) {
        const outcome = outcomeFromError(error);
        // Refused (e.g. another phone linked the barcode to something else first): the link
        // does not exist on the server, so drop it here too.
        if (outcome.kind !== 'fail') return outcome;
        return { ...outcome, apply: () => replaceBarcodeLink(item.shopId, link.id, null) };
      }
      const server = mapBarcodeRow(data as Row);
      return {
        kind: 'ok',
        apply: async () => {
          if (server.id !== link.id) await replaceBarcodeLink(item.shopId, link.id, server);
          else await db.barcodes.put(server);
        },
      };
    }

    case 'barcode_unlink': {
      const { barcodeId, reason, reverseUnsold, occurredAt } = item.payload;
      const { data, error } = await client.rpc('unlink_product_barcode', {
        p_shop_id: item.shopId,
        p_barcode_id: barcodeId,
        p_reason: reason,
        p_reverse_unsold: reverseUnsold,
        p_occurred_at: occurredAt,
      });
      if (error) return outcomeFromError(error);
      const result = data as {
        barcode?: Row;
        reversed?: Array<{ batch_id: string }>;
        kept?: Array<{ batch_id: string; quantity: number }>;
      } | null;
      return {
        kind: 'ok',
        apply: async () => {
          if (result?.barcode) await db.barcodes.put(mapBarcodeRow(result.barcode));
          // The server decides what was reversed: another phone may have sold from a delivery
          // this phone thought was untouched.
          for (const reversed of result?.reversed ?? []) {
            await db.batches.update(reversed.batch_id, { quantity: 0 });
          }
          for (const kept of result?.kept ?? []) {
            await db.batches.update(kept.batch_id, { quantity: Number(kept.quantity) });
          }
        },
      };
    }
  }
}

export interface PushResult {
  pushed: number;
  failed: number;
  /** Earliest time a retry is due, if the queue stopped on a retryable error. */
  retryAt: number | null;
  /** Set when the server is holding the queue back; nothing is lost and it resumes on its own. */
  blocked?: SyncBlock;
}

/**
 * Sends pending outbox items for the shop in the order they were created.
 * A retryable error stops the run so later items (which may depend on it) keep their order.
 */
export async function pushOutbox(
  client: SupabaseClient,
  shopId: string,
  now: number = Date.now()
): Promise<PushResult> {
  const queued = await db.outbox.where('[shopId+status]').equals([shopId, 'pending']).sortBy('seq');
  const result: PushResult = { pushed: 0, failed: 0, retryAt: null };

  for (const { seq } of queued) {
    // Re-read: an earlier item in this run may have remapped this item's product ID.
    const item = seq === undefined ? undefined : await db.outbox.get(seq);
    if (!item || item.status !== 'pending') continue;

    if (item.nextAttemptAt > now) {
      result.retryAt = item.nextAttemptAt;
      if (item.blocked) result.blocked = item.blocked;
      break;
    }

    let outcome: SendOutcome;
    try {
      outcome = await sendItem(client, item);
    } catch (err) {
      outcome = { kind: 'retry', error: messageOf(err) };
    }

    if (outcome.kind === 'ok') {
      const apply = outcome.apply;
      await withWriteLock(() =>
        db.transaction('rw', WRITE_TABLES, async () => {
          await apply?.();
          await db.outbox.delete(seq!);
        })
      );
      result.pushed++;
    } else if (outcome.kind === 'fail') {
      const apply = outcome.apply;
      await withWriteLock(() =>
        db.transaction('rw', WRITE_TABLES, async () => {
          await apply?.();
          await db.outbox.update(seq!, {
            status: 'failed',
            lastError: outcome.error,
            lastErrorCode: outcome.code ?? 'unknown',
            failureReported: false,
          });
        })
      );
      result.failed++;
    } else if (outcome.kind === 'blocked') {
      // Attempts are not counted: the change is valid and goes through once the block is lifted.
      const nextAttemptAt = now + BLOCKED_RETRY_MS;
      await db.outbox.update(seq!, { nextAttemptAt, lastError: outcome.error, blocked: outcome.reason });
      result.retryAt = nextAttemptAt;
      result.blocked = outcome.reason;
      break;
    } else {
      const attempts = item.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await db.outbox.update(seq!, { status: 'failed', attempts, lastError: outcome.error });
        result.failed++;
        continue;
      }
      const nextAttemptAt = now + backoffMs(attempts);
      await db.outbox.update(seq!, { attempts, nextAttemptAt, lastError: outcome.error, blocked: undefined });
      result.retryAt = nextAttemptAt;
      break;
    }
  }

  return result;
}

/**
 * Tells the platform which kinds of change the server refused for good, so operators can spot
 * a broken release. Only the operation type and error code are sent, never the change itself.
 * Returns how many items were reported; failures to report are retried on the next sync.
 */
export async function reportSyncFailures(client: SupabaseClient, shopId: string): Promise<number> {
  const unreported = (await db.outbox.where('[shopId+status]').equals([shopId, 'failed']).toArray()).filter(
    (item) => !item.failureReported
  );
  if (unreported.length === 0) return 0;

  const counts = new Map<string, { op_type: string; error_code: string; count: number }>();
  for (const item of unreported) {
    const code = /^[A-Za-z0-9_]{1,16}$/.test(item.lastErrorCode ?? '') ? item.lastErrorCode! : 'unknown';
    const key = `${item.type}:${code}`;
    const entry = counts.get(key) ?? { op_type: item.type, error_code: code, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }

  try {
    const { error } = await client.rpc('report_sync_failures', {
      p_shop_id: shopId,
      p_reports: [...counts.values()].slice(0, 50),
    });
    if (error) return 0;
  } catch {
    return 0;
  }
  await db.outbox.bulkUpdate(unreported.map((item) => ({ key: item.seq!, changes: { failureReported: true } })));
  return unreported.length;
}

// Pull -----------------------------------------------------------------------------

interface PullSpec {
  table: string;
  columns: string;
  initialCursor: () => string;
  apply: (rows: Row[]) => Promise<void>;
}

const PULL_SPECS: PullSpec[] = [
  {
    table: 'products',
    columns: PRODUCT_COLUMNS,
    initialCursor: () => new Date(0).toISOString(),
    apply: async (rows) => {
      await db.products.bulkPut(rows.map(mapProductRow));
    },
  },
  {
    table: 'product_packagings',
    columns: PACKAGING_COLUMNS,
    initialCursor: () => new Date(0).toISOString(),
    apply: async (rows) => {
      await db.packagings.bulkPut(rows.map(mapPackagingRow));
    },
  },
  {
    table: 'product_barcodes',
    columns: BARCODE_COLUMNS,
    initialCursor: () => new Date(0).toISOString(),
    apply: async (rows) => {
      await db.barcodes.bulkPut(rows.map(mapBarcodeRow));
    },
  },
  {
    table: 'stock_batches',
    columns: BATCH_COLUMNS,
    initialCursor: () => new Date(0).toISOString(),
    apply: async (rows) => {
      await db.batches.bulkPut(rows.map(mapBatchRow));
    },
  },
  {
    table: 'sale_items',
    columns:
      'id, shop_id, product_id, quantity, unit_price, line_total, allocations, voided_quantity, updated_at, sales(sold_at, idempotency_key)',
    initialCursor: () => new Date(Date.now() - SALES_HISTORY_DAYS * 86_400_000).toISOString(),
    apply: async (rows) => {
      await db.sales.bulkPut(rows.map((row) => mapSaleItemRow(row)));
    },
  },
  {
    table: 'stock_discrepancies',
    columns: 'id, shop_id, product_id, sale_id, shortfall, resolved_at, created_at, updated_at',
    initialCursor: () => new Date(0).toISOString(),
    apply: async (rows) => {
      await db.discrepancies.bulkPut(rows.map(mapDiscrepancyRow));
    },
  },
  {
    table: 'expiry_alerts',
    columns:
      'id, shop_id, batch_id, product_id, kind, threshold_days, expiry_date, quantity, alert_date, resolved_at, resolution, created_at, updated_at',
    initialCursor: () => new Date(0).toISOString(),
    apply: async (rows) => {
      await db.expiryAlerts.bulkPut(rows.map(mapExpiryAlertRow));
    },
  },
];

class PendingLocalChanges extends Error {}

async function hasPendingOutbox(shopId: string): Promise<boolean> {
  return (await db.outbox.where('[shopId+status]').equals([shopId, 'pending']).count()) > 0;
}

/**
 * Overwrites the local cache with server rows changed since the last pull, making stock correct
 * across devices. Skipped (and retried next sync) while local changes are still waiting to be
 * pushed, because server rows don't include them yet.
 * Returns the number of rows applied.
 */
export async function pullChanges(client: SupabaseClient, shopId: string): Promise<number> {
  if (await hasPendingOutbox(shopId)) return 0;
  let applied = 0;

  try {
    for (const spec of PULL_SPECS) {
      const cursorKey = `pull:${shopId}:${spec.table}`;
      const cursor = (await getMeta(cursorKey)) ?? spec.initialCursor();
      const since = new Date(Date.parse(cursor) - PULL_OVERLAP_MS).toISOString();
      let newestSeen = cursor;

      for (let page = 0; ; page++) {
        const from = page * PULL_PAGE_SIZE;
        const { data, error } = await client
          .from(spec.table)
          .select(spec.columns)
          .eq('shop_id', shopId)
          .gt('updated_at', since)
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + PULL_PAGE_SIZE - 1);
        if (error) throw new Error(error.message);

        const rows = (data ?? []) as unknown as Row[];
        if (rows.length > 0) {
          await withWriteLock(() =>
            db.transaction('rw', [...WRITE_TABLES, db.meta], async () => {
              if (await hasPendingOutbox(shopId)) throw new PendingLocalChanges();
              await spec.apply(rows);
            })
          );
          applied += rows.length;
          for (const row of rows) {
            const updatedAt = toIso(row.updated_at);
            if (updatedAt > newestSeen) newestSeen = updatedAt;
          }
        }
        if (rows.length < PULL_PAGE_SIZE) break;
      }

      await setMeta(cursorKey, newestSeen);
    }
  } catch (err) {
    if (err instanceof PendingLocalChanges) return applied;
    throw err;
  }

  return applied;
}
