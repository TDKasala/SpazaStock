import {
  StockBatch,
  StockMovement,
  StockInInput,
  StockInResult,
  ProductStockSummary,
  Product,
  StockDiscrepancy,
} from '../types';
import { db, withWriteLock } from '../lib/db';
import { newId } from '../lib/ids';
import { emitDataChanged } from '../lib/events';
import { getDaysUntilExpiry, isValidDateFormat } from '../lib/dates';
import { enqueue } from '../sync/outbox';
import { getProducts } from './productService';

export { getDaysUntilExpiry, isValidDateFormat };

function sumQuantity(batches: StockBatch[]): number {
  return batches.reduce((sum, b) => sum + b.quantity, 0);
}

/**
 * Records a delivery as its own batch (so its expiry date is preserved) and queues it for sync.
 * Stock only ever increases additively; prior batches are never overwritten.
 */
export async function stockIn(
  input: StockInInput,
  shopId: string
): Promise<{ result?: StockInResult; error?: string }> {
  const productId = input.productId?.trim();
  if (!productId) return { error: 'Product ID is required.' };

  if (
    typeof input.quantity !== 'number' ||
    !Number.isInteger(input.quantity) ||
    input.quantity <= 0
  ) {
    return { error: 'Quantity must be a positive whole integer greater than zero.' };
  }

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

  const idempotencyKey = input.idempotencyKey?.trim() || undefined;

  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.products, db.batches, db.movements, db.outbox, async () => {
      const product = await db.products.get(productId);
      if (!product || product.shopId !== shopId) {
        return { error: 'Product not found in active shop catalog.' };
      }

      if (idempotencyKey) {
        const seen = await db.movements
          .where('[shopId+idempotencyKey]')
          .equals([shopId, idempotencyKey])
          .first();
        if (seen) {
          return { error: 'Duplicate submission rejected: This stock delivery was already processed.' };
        }
      }

      const existing = await db.batches.where('[shopId+productId]').equals([shopId, productId]).toArray();
      const previousTotalQuantity = sumQuantity(existing);
      const resultingTotalQuantity = previousTotalQuantity + input.quantity;
      const now = new Date().toISOString();

      const batch: StockBatch = {
        id: newId(),
        shopId,
        productId,
        quantity: input.quantity,
        initialQuantity: input.quantity,
        expiryDate,
        costPricePerUnit: input.costPricePerUnit ?? product.buyingPrice ?? null,
        receivedAt: now,
      };

      const movement: StockMovement = {
        id: newId(),
        shopId,
        productId,
        batchId: batch.id,
        type: 'stock_in',
        quantityDelta: input.quantity,
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

/** Batches of a product that still have units, newest delivery first. */
export async function getProductBatches(productId: string, shopId: string): Promise<StockBatch[]> {
  const batches = await db.batches.where('[shopId+productId]').equals([shopId, productId]).toArray();
  return batches
    .filter((b) => b.quantity > 0)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export async function getProductTotalStock(productId: string, shopId: string): Promise<number> {
  return sumQuantity(await getProductBatches(productId, shopId));
}

/** Every product in the shop with its available stock and batch breakdown. */
export async function getAllProductsStockSummary(shopId: string): Promise<ProductStockSummary[]> {
  const [products, allBatches] = await Promise.all([
    getProducts(shopId),
    db.batches.where('shopId').equals(shopId).toArray(),
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
    const days = getDaysUntilExpiry(earliestExpiry);

    return {
      product,
      totalQuantity: sumQuantity(batches),
      batches,
      earliestExpiry,
      isExpired: days !== null && days < 0,
      isExpiringSoon: days !== null && days >= 0 && days <= 7,
    };
  });
}

export interface ExpiringBatchAlert {
  batch: StockBatch;
  product: Product;
  daysUntilExpiry: number;
  status: 'expired' | 'urgent' | 'warning';
}

/** Batches expiring within `thresholdDays` (or already expired), soonest first. */
export async function getExpiringBatches(
  shopId: string,
  thresholdDays: number = 30
): Promise<ExpiringBatchAlert[]> {
  const [products, batches] = await Promise.all([
    getProducts(shopId),
    db.batches.where('shopId').equals(shopId).toArray(),
  ]);
  const productsById = new Map(products.map((p) => [p.id, p]));
  const alerts: ExpiringBatchAlert[] = [];

  for (const batch of batches) {
    if (batch.quantity <= 0 || !batch.expiryDate) continue;
    const days = getDaysUntilExpiry(batch.expiryDate);
    const product = productsById.get(batch.productId);
    if (days === null || days > thresholdDays || !product) continue;

    alerts.push({
      batch,
      product,
      daysUntilExpiry: days,
      status: days < 0 ? 'expired' : days <= 7 ? 'urgent' : 'warning',
    });
  }

  return alerts.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
}

export interface DiscrepancyAlert {
  discrepancy: StockDiscrepancy;
  product: Product;
}

/** Unresolved shortfalls reported by the server, e.g. two devices selling the same last units. */
export async function getOpenDiscrepancies(shopId: string): Promise<DiscrepancyAlert[]> {
  const [products, discrepancies] = await Promise.all([
    getProducts(shopId),
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
