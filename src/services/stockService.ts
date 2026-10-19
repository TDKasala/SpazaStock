import {
  StockBatch,
  StockMovement,
  StockInInput,
  StockInResult,
  ProductStockSummary,
  Product,
  StockDiscrepancy,
  ExpiryAlert,
  ExpiryAlertKind,
  ExpiryResolutionAction,
} from '../types';
import { db, withWriteLock } from '../lib/db';
import { newId } from '../lib/ids';
import { emitDataChanged } from '../lib/events';
import { getDaysUntilExpiry, isValidDateFormat } from '../lib/dates';
import {
  alertDedupKey,
  daysUntil,
  isBatchExpired,
  reminderStage,
  todayInZone,
  type ReminderStage,
} from '../lib/expiry';
import { canManageExpiry, getShopSettings } from '../lib/shopSettings';
import { enqueue } from '../sync/outbox';
import { getProducts } from './productService';

export { getDaysUntilExpiry, isValidDateFormat };

function sumQuantity(batches: StockBatch[]): number {
  return batches.reduce((sum, b) => sum + b.quantity, 0);
}

/** The most units one delivery can add, matching record_stock_in. */
export const MAX_STOCK_IN_UNITS = 1_000_000;

/**
 * Records a delivery as its own batch (so its expiry date is preserved) and queues it for sync.
 * Stock only ever increases additively; prior batches are never overwritten. With a packaging,
 * `quantity` counts packages and is converted to units; the batch keeps the conversion used.
 */
export async function stockIn(
  input: StockInInput,
  shopId: string
): Promise<{ result?: StockInResult; error?: string }> {
  const productId = input.productId?.trim();
  if (!productId) return { error: 'Product ID is required.' };

  if (typeof input.quantity !== 'number' || !Number.isInteger(input.quantity) || input.quantity <= 0) {
    return { error: 'Quantity must be a positive whole integer greater than zero.' };
  }
  const packagingId = input.packagingId || null;

  let expiryDate: string | null = null;
  if (input.expiryDate && input.expiryDate.trim()) {
    expiryDate = input.expiryDate.trim();
    if (!isValidDateFormat(expiryDate)) {
      return { error: 'Invalid expiry date format. Please use YYYY-MM-DD.' };
    }
  }

  if (input.costPricePerUnit != null && (Number.isNaN(input.costPricePerUnit) || input.costPricePerUnit < 0)) {
    return { error: 'Cost price cannot be negative.' };
  }
  const lotNumber = input.lotNumber?.trim() || null;
  const supplierName = input.supplierName?.trim() || null;
  if (lotNumber && lotNumber.length > 40) return { error: 'Lot number can be at most 40 characters.' };
  if (supplierName && supplierName.length > 80) return { error: 'Supplier name can be at most 80 characters.' };

  let receivedAt: string | null = null;
  if (input.receivedAt && input.receivedAt.trim()) {
    const received = input.receivedAt.trim();
    if (!isValidDateFormat(received)) {
      return { error: 'Invalid received date format. Please use YYYY-MM-DD.' };
    }
    receivedAt = `${received}T00:00:00.000Z`;
  }

  const idempotencyKey = input.idempotencyKey?.trim() || undefined;

  const outcome = await withWriteLock(() =>
    db.transaction('rw', [db.products, db.packagings, db.barcodes, db.batches, db.movements, db.outbox], async () => {
      const product = await db.products.get(productId);
      if (!product || product.shopId !== shopId) {
        return { error: 'Product not found in active shop catalog.' };
      }

      // A retired packaging is still accepted, like the server: the delivery may predate it.
      let unitsPerPackage: number | null = null;
      if (packagingId) {
        const packaging = await db.packagings.get(packagingId);
        if (!packaging || packaging.shopId !== shopId || packaging.productId !== productId) {
          return { error: 'Packaging not found for this product.' };
        }
        unitsPerPackage = packaging.unitsPerPackage;
      }
      const quantity = input.quantity * (unitsPerPackage ?? 1);
      if (quantity > MAX_STOCK_IN_UNITS) {
        return { error: 'A delivery can add at most 1,000,000 units.' };
      }

      const link = input.barcodeId ? await db.barcodes.get(input.barcodeId) : undefined;
      const receivedBarcodeId = link && link.shopId === shopId && link.productId === productId ? link.id : null;

      if (idempotencyKey) {
        const seen = await db.movements.where('[shopId+idempotencyKey]').equals([shopId, idempotencyKey]).first();
        if (seen) {
          return {
            error: 'Duplicate submission rejected: This stock delivery was already processed.',
          };
        }
      }

      const existing = await db.batches.where('[shopId+productId]').equals([shopId, productId]).toArray();
      const previousTotalQuantity = sumQuantity(existing);
      const resultingTotalQuantity = previousTotalQuantity + quantity;
      const now = new Date().toISOString();

      const batch: StockBatch = {
        id: newId(),
        shopId,
        productId,
        quantity,
        initialQuantity: quantity,
        expiryDate,
        costPricePerUnit: input.costPricePerUnit ?? product.buyingPrice ?? null,
        receivedAt: receivedAt ?? now,
        packagingId,
        packageQuantity: packagingId ? input.quantity : null,
        unitsPerPackage,
        receivedBarcodeId,
        lotNumber,
        supplierName,
      };

      const movement: StockMovement = {
        id: newId(),
        shopId,
        productId,
        batchId: batch.id,
        type: 'stock_in',
        quantityDelta: quantity,
        resultingTotalQuantity,
        idempotencyKey,
        createdAt: now,
      };

      await db.batches.add(batch);
      await db.movements.add(movement);
      await enqueue(shopId, {
        type: 'stock_in',
        payload: { batch, movementId: movement.id, idempotencyKey },
      });

      return { result: { batch, movement, previousTotalQuantity, resultingTotalQuantity } };
    })
  );

  if (outcome.result) emitDataChanged('local');
  return outcome;
}

/**
 * Adds units to a batch that is already saved. Expiry, lot, supplier, cost, and received date
 * stay as they are. The same idempotency key does not add the units twice.
 */
export async function addStockToBatch(
  input: { batchId: string; quantity: number; idempotencyKey: string },
  shopId: string
): Promise<{ result?: StockInResult; error?: string }> {
  const batchId = input.batchId?.trim();
  if (!batchId) return { error: 'Batch ID is required.' };
  if (typeof input.quantity !== 'number' || !Number.isInteger(input.quantity) || input.quantity <= 0) {
    return { error: 'Quantity must be a positive whole integer greater than zero.' };
  }
  if (input.quantity > MAX_STOCK_IN_UNITS) {
    return { error: 'A delivery can add at most 1,000,000 units.' };
  }
  const idempotencyKey = input.idempotencyKey?.trim() ?? '';
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return { error: 'Idempotency key is required.' };
  }

  const outcome = await withWriteLock(() =>
    db.transaction('rw', [db.batches, db.movements, db.outbox], async () => {
      const batch = await db.batches.get(batchId);
      if (!batch || batch.shopId !== shopId) {
        return { error: 'Batch not found in this shop.' };
      }
      if (batch.quantity + input.quantity > MAX_STOCK_IN_UNITS) {
        return { error: 'A batch can hold at most 1,000,000 units.' };
      }

      const seen = await db.movements.where('[shopId+idempotencyKey]').equals([shopId, idempotencyKey]).first();
      if (seen) {
        return { error: 'Duplicate submission rejected: This stock delivery was already processed.' };
      }

      const existing = await db.batches.where('[shopId+productId]').equals([shopId, batch.productId]).toArray();
      const previousTotalQuantity = sumQuantity(existing);
      const resultingTotalQuantity = previousTotalQuantity + input.quantity;
      const now = new Date().toISOString();
      const updated: StockBatch = {
        ...batch,
        quantity: batch.quantity + input.quantity,
        initialQuantity: batch.initialQuantity + input.quantity,
      };
      const movement: StockMovement = {
        id: newId(),
        shopId,
        productId: batch.productId,
        batchId: batch.id,
        type: 'stock_in',
        quantityDelta: input.quantity,
        resultingTotalQuantity,
        idempotencyKey,
        createdAt: now,
      };

      await db.batches.put(updated);
      await db.movements.add(movement);
      await enqueue(shopId, {
        type: 'stock_add',
        payload: { batchId: batch.id, quantity: input.quantity, idempotencyKey },
      });

      return { result: { batch: updated, movement, previousTotalQuantity, resultingTotalQuantity } };
    })
  );

  if (outcome.result) emitDataChanged('local');
  return outcome;
}

/** Batches of a product that still have units, newest delivery first. */
export async function getProductBatches(productId: string, shopId: string): Promise<StockBatch[]> {
  const batches = await db.batches.where('[shopId+productId]').equals([shopId, productId]).toArray();
  return batches.filter((b) => b.quantity > 0).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export interface BatchExpiryChange {
  batchId: string;
  expiryDate: string;
}

/**
 * Compares edited expiry dates (by batch id) with the batches. A date can be added or changed but
 * not removed, because a correction on the server always sets a date.
 */
export function batchExpiryChanges(
  batches: StockBatch[],
  drafts: Record<string, string>
): { changes: BatchExpiryChange[]; invalid: string[] } {
  const changes: BatchExpiryChange[] = [];
  const invalid: string[] = [];
  for (const batch of batches) {
    const draft = (drafts[batch.id] ?? batch.expiryDate ?? '').trim();
    if (draft === (batch.expiryDate ?? '')) continue;
    if (!draft || !isValidDateFormat(draft)) invalid.push(batch.id);
    else changes.push({ batchId: batch.id, expiryDate: draft });
  }
  return { changes, invalid };
}

/** The shop's calendar date now, in its own time zone. */
export async function getShopToday(shopId: string, now: Date = new Date()): Promise<string> {
  return todayInZone((await getShopSettings(shopId)).timezone, now);
}

/** Sellable units of a product: expired batches are excluded. */
export async function getProductTotalStock(productId: string, shopId: string): Promise<number> {
  const today = await getShopToday(shopId);
  return sumQuantity((await getProductBatches(productId, shopId)).filter((b) => !isBatchExpired(b, today)));
}

/** Every product in the shop with its sellable stock, expired stock and batch breakdown. */
export async function getAllProductsStockSummary(shopId: string): Promise<ProductStockSummary[]> {
  const [products, allBatches, today] = await Promise.all([
    getProducts(shopId),
    db.batches.where('shopId').equals(shopId).toArray(),
    getShopToday(shopId),
  ]);

  const batchesByProduct = new Map<string, StockBatch[]>();
  for (const batch of allBatches) {
    if (batch.quantity <= 0) continue;
    const list = batchesByProduct.get(batch.productId) ?? [];
    list.push(batch);
    batchesByProduct.set(batch.productId, list);
  }

  return products.map((product) => {
    const batches = batchesByProduct.get(product.id) ?? [];
    const expiryDates = batches
      .map((b) => b.expiryDate)
      .filter((d): d is string => d !== null)
      .sort();
    const earliestExpiry = expiryDates[0] ?? null;
    const days = earliestExpiry ? daysUntil(earliestExpiry, today) : null;
    const expiredQuantity = sumQuantity(batches.filter((b) => isBatchExpired(b, today)));

    return {
      product,
      totalQuantity: sumQuantity(batches) - expiredQuantity,
      expiredQuantity,
      batches,
      earliestExpiry,
      isExpired: expiredQuantity > 0,
      isExpiringSoon: days !== null && days >= 0 && days <= 7,
    };
  });
}

export type ExpiryStatus = 'expired' | 'urgent' | 'warning';

export interface ExpiryAlertItem {
  /** Batch, expiry date, kind and threshold: the same key the server deduplicates on. */
  key: string;
  /** The server's alert id once it has been generated and synced. */
  alertId: string | null;
  batch: StockBatch;
  product: Product;
  kind: ExpiryAlertKind;
  thresholdDays: number | null;
  daysUntilExpiry: number;
  status: ExpiryStatus;
}

function stageRank(stage: ReminderStage): number {
  return stage.kind === 'expired' ? -1 : stage.threshold;
}

function stageOfAlert(alert: ExpiryAlert): ReminderStage {
  return alert.kind === 'expired'
    ? { kind: 'expired', threshold: null }
    : { kind: 'reminder', threshold: alert.thresholdDays ?? 0 };
}

/**
 * Batches with stock whose expiry reminder or overdue alert is due, most urgent first. The stage
 * is computed with the same rule the server's scheduled generator uses, so it shows immediately
 * (even offline or in device-only mode); open server alerts fill in anything the rule no longer
 * covers, e.g. after the reminder days were changed.
 */
export async function getExpiryAlerts(shopId: string, now: Date = new Date()): Promise<ExpiryAlertItem[]> {
  const settings = await getShopSettings(shopId);
  const today = todayInZone(settings.timezone, now);
  const [products, batches, serverAlerts] = await Promise.all([
    getProducts(shopId),
    db.batches.where('shopId').equals(shopId).toArray(),
    db.expiryAlerts.where('shopId').equals(shopId).toArray(),
  ]);
  const productsById = new Map(products.map((p) => [p.id, p]));
  const openByBatch = new Map<string, ExpiryAlert[]>();
  const alertIdByKey = new Map<string, string>();
  for (const alert of serverAlerts) {
    alertIdByKey.set(alertDedupKey(alert.batchId, alert.expiryDate, stageOfAlert(alert)), alert.id);
    if (alert.resolvedAt) continue;
    const list = openByBatch.get(alert.batchId) ?? [];
    list.push(alert);
    openByBatch.set(alert.batchId, list);
  }

  const items: ExpiryAlertItem[] = [];
  for (const batch of batches) {
    if (batch.quantity <= 0 || !batch.expiryDate) continue;
    const product = productsById.get(batch.productId);
    if (!product) continue;

    let stage = reminderStage(batch.expiryDate, today, settings.reminderDays);
    if (!stage) {
      const open = (openByBatch.get(batch.id) ?? [])
        .filter((a) => a.expiryDate === batch.expiryDate)
        .map(stageOfAlert)
        .sort((a, b) => stageRank(a) - stageRank(b));
      stage = open[0] ?? null;
    }
    if (!stage) continue;

    const key = alertDedupKey(batch.id, batch.expiryDate, stage);
    const days = daysUntil(batch.expiryDate, today);
    items.push({
      key,
      alertId: alertIdByKey.get(key) ?? null,
      batch,
      product,
      kind: stage.kind,
      thresholdDays: stage.threshold,
      daysUntilExpiry: days,
      status: stage.kind === 'expired' ? 'expired' : days <= 7 ? 'urgent' : 'warning',
    });
  }

  return items.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry || a.product.name.localeCompare(b.product.name));
}

export type ExpiryResolveErrorCode = 'forbidden' | 'not_found' | 'invalid' | 'duplicate' | 'empty';

export interface ResolveExpiredBatchInput {
  batchId: string;
  action: ExpiryResolutionAction;
  /** Required for 'expiry_corrected'. */
  newExpiryDate?: string | null;
  note?: string | null;
  idempotencyKey?: string;
}

export interface ResolveExpiredBatchOutcome {
  result?: { batch: StockBatch; removed: number };
  error?: string;
  errorCode?: ExpiryResolveErrorCode;
}

/**
 * Removes an expired batch from stock (discarded or returned to the supplier) or corrects its
 * expiry date, and queues resolve_expired_batch, which keeps a permanent expiry_resolutions record
 * on the server. Owners and managers only, matching the server.
 */
export async function resolveExpiredBatch(
  input: ResolveExpiredBatchInput,
  shopId: string
): Promise<ResolveExpiredBatchOutcome> {
  const settings = await getShopSettings(shopId);
  if (!canManageExpiry(settings.role)) {
    return { error: 'Only an owner or manager can resolve expired stock.', errorCode: 'forbidden' };
  }
  const newExpiryDate = input.newExpiryDate?.trim() || null;
  if (input.action === 'expiry_corrected' && (!newExpiryDate || !isValidDateFormat(newExpiryDate))) {
    return { error: 'Enter the correct expiry date (YYYY-MM-DD).', errorCode: 'invalid' };
  }
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  const idempotencyKey = input.idempotencyKey?.trim() || newId();
  const movementKey = `expiry:${idempotencyKey}`;

  const outcome = await withWriteLock(() =>
    db.transaction(
      'rw',
      [db.batches, db.movements, db.expiryAlerts, db.outbox],
      async (): Promise<ResolveExpiredBatchOutcome> => {
        const batch = await db.batches.get(input.batchId);
        if (!batch || batch.shopId !== shopId) {
          return { error: 'Batch not found in this shop.', errorCode: 'not_found' };
        }

        const seenMovement = await db.movements.where('[shopId+idempotencyKey]').equals([shopId, movementKey]).count();
        const seenQueued = await db.outbox
          .where('shopId')
          .equals(shopId)
          .filter((item) => item.type === 'expiry_resolve' && item.payload.idempotencyKey === idempotencyKey)
          .count();
        if (seenMovement > 0 || seenQueued > 0) {
          return { error: 'This was already recorded.', errorCode: 'duplicate' };
        }

        const now = new Date().toISOString();
        let removed = 0;
        let updated: StockBatch;
        if (input.action === 'expiry_corrected') {
          updated = { ...batch, expiryDate: newExpiryDate };
        } else {
          if (batch.quantity <= 0) {
            return { error: 'This batch has no units left.', errorCode: 'empty' };
          }
          removed = batch.quantity;
          updated = { ...batch, quantity: 0 };
          const siblings = await db.batches.where('[shopId+productId]').equals([shopId, batch.productId]).toArray();
          const onHandAfter = sumQuantity(siblings) - removed;
          await db.movements.add({
            id: newId(),
            shopId,
            productId: batch.productId,
            batchId: batch.id,
            type: input.action === 'discarded' ? 'write_off_expired' : 'supplier_return',
            quantityDelta: -removed,
            resultingTotalQuantity: onHandAfter,
            idempotencyKey: movementKey,
            createdAt: now,
          });
        }
        await db.batches.put(updated);

        await db.expiryAlerts
          .where('batchId')
          .equals(batch.id)
          .filter((a) => !a.resolvedAt)
          .modify({ resolvedAt: now, resolution: input.action });

        await enqueue(shopId, {
          type: 'expiry_resolve',
          payload: {
            batchId: batch.id,
            action: input.action,
            newExpiryDate,
            note,
            idempotencyKey,
            occurredAt: now,
          },
        });

        return { result: { batch: updated, removed } };
      }
    )
  );

  if (outcome.result) emitDataChanged('local');
  return outcome;
}

export interface DiscrepancyAlert {
  discrepancy: StockDiscrepancy;
  product: Product;
}

/** Unresolved shortfalls reported by the server, e.g. two devices selling the same last units. */
export async function getOpenDiscrepancies(shopId: string): Promise<DiscrepancyAlert[]> {
  const [products, discrepancies] = await Promise.all([
    // A shortfall still needs a recount after its product is archived.
    getProducts(shopId, { includeArchived: true }),
    db.discrepancies.where('shopId').equals(shopId).toArray(),
  ]);
  const productsById = new Map(products.map((p) => [p.id, p]));

  return discrepancies
    .filter((d) => !d.resolvedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap((discrepancy) => {
      const product = productsById.get(discrepancy.productId);
      return product ? [{ discrepancy, product }] : [];
    });
}

/** Marks a shortfall as recounted and queues the update for sync. */
export async function resolveDiscrepancy(id: string, shopId: string): Promise<void> {
  await withWriteLock(() =>
    db.transaction('rw', db.discrepancies, db.outbox, async () => {
      const discrepancy = await db.discrepancies.get(id);
      if (!discrepancy || discrepancy.shopId !== shopId || discrepancy.resolvedAt) return;
      const resolvedAt = new Date().toISOString();
      await db.discrepancies.update(id, { resolvedAt });
      await enqueue(shopId, { type: 'discrepancy_resolve', payload: { id, resolvedAt } });
    })
  );
  emitDataChanged('local');
}
