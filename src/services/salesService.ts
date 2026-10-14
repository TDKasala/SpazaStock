import {
  Product,
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
import { isBatchExpired, todayInZone } from '../lib/expiry';
import { getShopSettings } from '../lib/shopSettings';
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
  /** Sellable units when the sale was refused for insufficient stock. */
  available?: number;
  /** Units on hand that could not be sold because their batch has expired. */
  expired?: number;
}

/**
 * Expired batches (expiry date before today in the shop's time zone) are never sold; the server's
 * record_sale skips them the same way.
 */
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
  const today = todayInZone((await getShopSettings(shopId)).timezone);

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

      const stocked = (
        await db.batches.where('[shopId+productId]').equals([shopId, product.id]).toArray()
      ).filter((b) => b.quantity > 0);
      const batches = stocked.filter((b) => !isBatchExpired(b, today));
      const onHand = stocked.reduce((sum, b) => sum + b.quantity, 0);
      const totalAvailable = batches.reduce((sum, b) => sum + b.quantity, 0);
      const expired = onHand - totalAvailable;

      if (totalAvailable < input.quantity) {
        return {
          error: `Insufficient stock: Only ${totalAvailable} units available (requested ${input.quantity}). Cannot oversell.`,
          errorCode: 'insufficient_stock',
          available: totalAvailable,
          expired,
        };
      }

      const now = new Date().toISOString();
      const saleId = newId();
      let remaining = input.quantity;
      // Movements record stock on hand (expired units included), matching the server ledger.
      let runningTotal = onHand;
      const allocations: BatchAllocation[] = [];
      const movements: StockMovement[] = [];
      for (const batch of sortBatchesByFEFO(batches)) {
        if (remaining <= 0) break;
        const take = Math.min(batch.quantity, remaining);
        remaining -= take;
        runningTotal -= take;
        await db.batches.update(batch.id, { quantity: batch.quantity - take });
        allocations.push({
          batchId: batch.id,
          quantityDeducted: take,
          batchExpiryDate: batch.expiryDate,
        });
        movements.push({
          id: newId(),
          shopId,
          productId: product.id,
          batchId: batch.id,
          saleId,
          type: 'sale',
          quantityDelta: -take,
          resultingTotalQuantity: runningTotal,
          idempotencyKey: `sale:${idempotencyKey}:${saleId}:${batch.id}`,
          createdAt: now,
        });
      }

      const unitPrice = input.unitPrice ?? product.sellingPrice ?? 0;
      const remainingTotalStock = totalAvailable - input.quantity;

      const sale: Sale = {
        id: saleId,
        shopId,
        productId: product.id,
        quantity: input.quantity,
        unitPrice,
        totalAmount: roundMoney(unitPrice * input.quantity),
        allocations,
        idempotencyKey,
        createdAt: now,
      };

      await db.sales.add(sale);
      await db.movements.bulkAdd(movements);
      await enqueue(shopId, { type: 'sale', payload: { sale } });

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

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** Units of the sale still counted as sold. */
export function saleNetQuantity(sale: Pick<Sale, 'quantity' | 'voidedQuantity'>): number {
  return sale.quantity - (sale.voidedQuantity ?? 0);
}

/** Amount of the sale still counted as revenue. */
export function saleNetAmount(sale: Pick<Sale, 'quantity' | 'voidedQuantity' | 'unitPrice' | 'totalAmount'>): number {
  if (!sale.voidedQuantity) return sale.totalAmount;
  return roundMoney(sale.unitPrice * saleNetQuantity(sale));
}

export interface VoidReturn {
  batchId: string;
  quantity: number;
}

/**
 * Where voided units go, determined only by the sale's allocations and voided quantity (the
 * server's void_sale_item follows the same rule): units never taken from a batch (an oversell
 * shortfall) are voided first, then units go back to their batches, last allocation first.
 * The caller must ensure `quantity` does not exceed the sale's net quantity.
 */
export function planVoidReturns(
  sale: Pick<Sale, 'quantity' | 'allocations' | 'voidedQuantity'>,
  quantity: number
): VoidReturn[] {
  const voided = sale.voidedQuantity ?? 0;
  const allocated = sale.allocations.reduce((sum, a) => sum + a.quantityDeducted, 0);
  const shortfall = Math.max(sale.quantity - allocated, 0);
  const voidedFromShortfall = Math.min(voided, shortfall);
  let skip = voided - voidedFromShortfall;
  let remaining = quantity - Math.min(quantity, shortfall - voidedFromShortfall);

  const returns: VoidReturn[] = [];
  for (const allocation of [...sale.allocations].reverse()) {
    if (remaining <= 0) break;
    let available = allocation.quantityDeducted;
    const skipped = Math.min(skip, available);
    skip -= skipped;
    available -= skipped;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    remaining -= take;
    returns.push({ batchId: allocation.batchId, quantity: take });
  }
  return returns;
}

export type VoidErrorCode = 'invalid_quantity' | 'duplicate' | 'not_found' | 'over_void';

export interface VoidSaleInput {
  saleId: string;
  quantity: number;
  idempotencyKey?: string;
}

export interface VoidSaleResult {
  sale: Sale;
  product: Product;
  returns: VoidReturn[];
  remainingTotalStock: number;
}

export interface VoidSaleOutcome {
  result?: VoidSaleResult;
  error?: string;
  errorCode?: VoidErrorCode;
  /** Units of the sale that could still be voided when the void was refused. */
  available?: number;
}

/**
 * Voids (undoes) units of a recorded sale: the units go back to the batches they came from and
 * the void is queued for sync. Idempotent on the key, like recordSale.
 */
export async function voidSale(input: VoidSaleInput, shopId: string): Promise<VoidSaleOutcome> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    return { error: 'Quantity must be a positive whole number.', errorCode: 'invalid_quantity' };
  }
  const idempotencyKey = input.idempotencyKey?.trim() || newId();
  const today = todayInZone((await getShopSettings(shopId)).timezone);

  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.products, db.batches, db.movements, db.sales, db.outbox, async (): Promise<VoidSaleOutcome> => {
      const sale = await db.sales.get(input.saleId);
      if (!sale || sale.shopId !== shopId) {
        return { error: 'Sale not found in this shop.', errorCode: 'not_found' };
      }

      const candidateKeys = sale.allocations.map((a) => [shopId, `void:${idempotencyKey}:${a.batchId}`]);
      const seenMovement =
        candidateKeys.length > 0 &&
        (await db.movements.where('[shopId+idempotencyKey]').anyOf(candidateKeys).count()) > 0;
      const seenQueued = await db.outbox
        .where('shopId')
        .equals(shopId)
        .filter((item) => item.type === 'sale_void' && item.payload.idempotencyKey === idempotencyKey)
        .count();
      if (seenMovement || seenQueued > 0) {
        return { error: 'This undo was already recorded.', errorCode: 'duplicate' };
      }

      const net = saleNetQuantity(sale);
      if (input.quantity > net) {
        return { error: `Only ${net} units of this sale can be undone.`, errorCode: 'over_void', available: net };
      }

      const product = await db.products.get(sale.productId);
      if (!product) {
        return { error: 'Product not found in active shop catalog.', errorCode: 'not_found' };
      }

      const batches = await db.batches.where('[shopId+productId]').equals([shopId, sale.productId]).toArray();
      let runningTotal = batches.reduce((sum, b) => sum + b.quantity, 0);
      const now = new Date().toISOString();
      const returns = planVoidReturns(sale, input.quantity);

      for (const ret of returns) {
        const batch = batches.find((b) => b.id === ret.batchId);
        if (batch) {
          batch.quantity += ret.quantity;
          await db.batches.update(batch.id, { quantity: batch.quantity });
        }
        runningTotal += ret.quantity;
        await db.movements.add({
          id: newId(),
          shopId,
          productId: sale.productId,
          batchId: ret.batchId,
          saleId: sale.id,
          type: 'return',
          quantityDelta: ret.quantity,
          resultingTotalQuantity: runningTotal,
          idempotencyKey: `void:${idempotencyKey}:${ret.batchId}`,
          createdAt: now,
        });
      }

      const updated: Sale = { ...sale, voidedQuantity: (sale.voidedQuantity ?? 0) + input.quantity };
      await db.sales.put(updated);
      await enqueue(shopId, {
        type: 'sale_void',
        payload: { saleId: sale.id, quantity: input.quantity, idempotencyKey, occurredAt: now },
      });

      const sellable = batches
        .filter((b) => !isBatchExpired(b, today))
        .reduce((sum, b) => sum + b.quantity, 0);
      return { result: { sale: updated, product, returns, remainingTotalStock: sellable } };
    })
  );

  if (outcome.result) emitDataChanged('local');
  return outcome;
}

export type SaleSyncState = 'pending' | 'failed';

/** Sales with a sale or void still in the outbox, so the UI can show which aren't synced yet. */
export async function getPendingSaleIds(shopId: string): Promise<Map<string, SaleSyncState>> {
  const states = new Map<string, SaleSyncState>();
  const items = await db.outbox.where('shopId').equals(shopId).toArray();
  for (const item of items) {
    const saleId =
      item.type === 'sale' ? item.payload.sale.id : item.type === 'sale_void' ? item.payload.saleId : null;
    if (!saleId) continue;
    if (item.status === 'failed' || !states.has(saleId)) states.set(saleId, item.status);
  }
  return states;
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
