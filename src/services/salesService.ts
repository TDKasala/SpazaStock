import {
  Sale,
  SaleInput,
  SaleResult,
  StockBatch,
  StockMovement,
  BatchAllocation,
} from '../types';
import { db, withWriteLock } from '../lib/db';
import { newId } from '../lib/ids';
import { emitDataChanged } from '../lib/events';
import { isSameLocalDay } from '../lib/dates';
import { enqueue } from '../sync/outbox';

/**
 * First-Expired-First-Out order: dated batches by expiry ascending, then undated batches,
 * ties broken by the oldest delivery.
 */
export function sortBatchesByFEFO(batches: StockBatch[]): StockBatch[] {
  return [...batches].sort((a, b) => {
    if (a.expiryDate && b.expiryDate && a.expiryDate !== b.expiryDate) {
      return a.expiryDate.localeCompare(b.expiryDate);
    }
    if (a.expiryDate && !b.expiryDate) return -1;
    if (!a.expiryDate && b.expiryDate) return 1;
    return a.receivedAt.localeCompare(b.receivedAt);
  });
}

/**
 * Records a sale atomically against the local store and queues it for sync.
 * Deducts FEFO across batches, refuses to oversell, and rejects a repeated idempotency key.
 * Because the key is stored with the committed sale, a failed attempt (e.g. insufficient stock)
 * does not consume it.
 */
export type SaleErrorCode =
  | 'invalid_quantity'
  | 'invalid_price'
  | 'duplicate'
  | 'not_found'
  | 'insufficient_stock';

export interface RecordSaleOutcome {
  result?: SaleResult;
  error?: string;
  errorCode?: SaleErrorCode;
  /** Units on hand when the sale was refused for insufficient stock. */
  available?: number;
}

export async function recordSale(input: SaleInput, shopId: string): Promise<RecordSaleOutcome> {
  if (
    typeof input.quantity !== 'number' ||
    !Number.isInteger(input.quantity) ||
    input.quantity <= 0
  ) {
    return {
      error: 'Quantity must be a positive whole integer greater than zero.',
      errorCode: 'invalid_quantity',
    };
  }
  if (input.unitPrice != null && (Number.isNaN(input.unitPrice) || input.unitPrice < 0)) {
    return { error: 'Unit price cannot be negative.', errorCode: 'invalid_price' };
  }

  const productId = input.productId?.trim();
  const idempotencyKey = input.idempotencyKey?.trim() || newId();

  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.products, db.batches, db.movements, db.sales, db.outbox, async (): Promise<RecordSaleOutcome> => {
      const duplicate = await db.sales
        .where('[shopId+idempotencyKey]')
        .equals([shopId, idempotencyKey])
        .first();
      if (duplicate) {
        return {
          error: 'Duplicate scan rejected: This transaction was already processed.',
          errorCode: 'duplicate',
        };
      }

      const product = productId ? await db.products.get(productId) : undefined;
      if (!product || product.shopId !== shopId) {
        return { error: 'Product not found in active shop catalog.', errorCode: 'not_found' };
      }

      const batches = (
        await db.batches.where('[shopId+productId]').equals([shopId, product.id]).toArray()
      ).filter((b) => b.quantity > 0);
      const totalAvailable = batches.reduce((sum, b) => sum + b.quantity, 0);

      if (totalAvailable < input.quantity) {
        return {
          error: `Insufficient stock: Only ${totalAvailable} units available (requested ${input.quantity}). Cannot oversell.`,
          errorCode: 'insufficient_stock',
          available: totalAvailable,
        };
      }

      let remaining = input.quantity;
      const allocations: BatchAllocation[] = [];
      for (const batch of sortBatchesByFEFO(batches)) {
        if (remaining <= 0) break;
        const take = Math.min(batch.quantity, remaining);
        remaining -= take;
        await db.batches.update(batch.id, { quantity: batch.quantity - take });
        allocations.push({
          batchId: batch.id,
          quantityDeducted: take,
          batchExpiryDate: batch.expiryDate,
        });
      }

      const now = new Date().toISOString();
      const unitPrice = input.unitPrice ?? product.sellingPrice ?? 0;
      const remainingTotalStock = totalAvailable - input.quantity;

      const sale: Sale = {
        id: newId(),
        shopId,
        productId: product.id,
        quantity: input.quantity,
        unitPrice,
        totalAmount: Math.round(unitPrice * input.quantity * 100) / 100,
        allocations,
        idempotencyKey,
        createdAt: now,
      };

      const movement: StockMovement = {
        id: newId(),
        shopId,
        productId: product.id,
        batchId: allocations[0]?.batchId ?? null,
        saleId: sale.id,
        type: 'sale',
        quantityDelta: -input.quantity,
        resultingTotalQuantity: remainingTotalStock,
        idempotencyKey,
        createdAt: now,
      };

      await db.sales.add(sale);
      await db.movements.add(movement);
      await enqueue(shopId, { type: 'sale', payload: { sale, movementId: movement.id } });

      return {
        result: {
          sale,
          product,
          previousTotalStock: totalAvailable,
          remainingTotalStock,
          allocations,
          isQueuedOffline: typeof navigator !== 'undefined' && navigator.onLine === false,
        },
      };
    })
  );

  if (outcome.result) emitDataChanged('local');
  return outcome;
}

/** All sales for the shop, newest first. */
export async function getSales(shopId: string): Promise<Sale[]> {
  const sales = await db.sales
    .where('[shopId+createdAt]')
    .between([shopId, ''], [shopId, '\uffff'])
    .toArray();
  return sales.reverse();
}

/** Sales made today in the device's local time zone, newest first. */
export async function getTodaySales(shopId: string, today: Date = new Date()): Promise<Sale[]> {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
  const sales = await db.sales
    .where('[shopId+createdAt]')
    .between([shopId, start], [shopId, end])
    .toArray();
  return sales.filter((s) => isSameLocalDay(s.createdAt, today)).reverse();
}
