import {
  Sale,
  SaleInput,
  SaleResult,
  StockBatch,
  StockMovement,
  BatchAllocation,
  OfflineQueueItem,
  Product,
} from '../types';
import { DEFAULT_SHOP_ID, getProducts } from './productService';
import {
  getProductBatches,
  getShopBatches,
  saveShopBatches,
  getShopMovements,
  saveShopMovements,
} from './stockService';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

const SALES_STORAGE_KEY_PREFIX = 'spazastock_sales_';
const OFFLINE_QUEUE_KEY_PREFIX = 'spazastock_offline_queue_';

// In-memory fallbacks for tests/SSR
const memorySales = new Map<string, Sale[]>();
const memoryOfflineQueue = new Map<string, OfflineQueueItem[]>();
const seenSaleIdempotency = new Set<string>();

// Concurrency mutex lock per product
const productLocks = new Map<string, Promise<void>>();

async function acquireProductLock(productId: string): Promise<() => void> {
  while (productLocks.has(productId)) {
    await productLocks.get(productId);
  }
  let unlock: () => void = () => {};
  const lockPromise = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  productLocks.set(productId, lockPromise);

  return () => {
    productLocks.delete(productId);
    unlock();
  };
}

function getSalesKey(shopId: string): string {
  return `${SALES_STORAGE_KEY_PREFIX}${shopId}`;
}

function getOfflineQueueKey(shopId: string): string {
  return `${OFFLINE_QUEUE_KEY_PREFIX}${shopId}`;
}

function getLocalSales(shopId: string): Sale[] {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(getSalesKey(shopId));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  return memorySales.get(shopId) || [];
}

function saveLocalSales(sales: Sale[], shopId: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(getSalesKey(shopId), JSON.stringify(sales));
  }
  memorySales.set(shopId, sales);
}



export function getOfflineQueue(shopId: string = DEFAULT_SHOP_ID): OfflineQueueItem[] {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(getOfflineQueueKey(shopId));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  return memoryOfflineQueue.get(shopId) || [];
}

function saveOfflineQueue(queue: OfflineQueueItem[], shopId: string = DEFAULT_SHOP_ID): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(getOfflineQueueKey(shopId), JSON.stringify(queue));
  }
  memoryOfflineQueue.set(shopId, queue);
}

/**
 * Sorts batches prioritizing the earliest expiry date (FEFO: First-Expired, First-Out).
 * Batches with explicit expiry dates are consumed first, ordered by date ascending.
 * Batches without expiry dates are consumed afterwards, ordered by receipt date ascending.
 */
export function sortBatchesByFEFO(batches: StockBatch[]): StockBatch[] {
  return [...batches].sort((a, b) => {
    if (a.expiryDate && b.expiryDate) {
      return a.expiryDate.localeCompare(b.expiryDate);
    }
    if (a.expiryDate && !b.expiryDate) return -1;
    if (!a.expiryDate && b.expiryDate) return 1;
    return a.receivedAt.localeCompare(b.receivedAt);
  });
}

/**
 * Executes an atomic sale deduction.
 * - Deducts from the earliest expiring batch(es).
 * - Enforces positive quantities.
 * - Prevents overselling & negative inventory.
 * - Handles idempotency & prevents duplicate scans.
 * - Queues for offline sync if disconnected.
 */
export async function recordSale(
  input: SaleInput,
  shopId: string = DEFAULT_SHOP_ID
): Promise<{ result?: SaleResult; error?: string }> {
  // Acquire concurrency lock on this product
  const releaseLock = await acquireProductLock(input.productId);

  try {
    // 1. Validate Input Quantity
    if (
      typeof input.quantity !== 'number' ||
      !Number.isInteger(input.quantity) ||
      input.quantity <= 0
    ) {
      return { error: 'Quantity must be a positive whole integer greater than zero.' };
    }

    // 2. Validate Idempotency (prevent duplicate scan / rapid double-click)
    if (input.idempotencyKey) {
      const idKey = `${shopId}_${input.idempotencyKey.trim()}`;
      if (seenSaleIdempotency.has(idKey)) {
        return { error: 'Duplicate scan rejected: This transaction was already processed.' };
      }
      seenSaleIdempotency.add(idKey);
    }

    // 3. Find Product
    const products = await getProducts(shopId);
    const product = products.find((p) => p.id === input.productId.trim());
    if (!product) {
      return { error: 'Product not found in active shop catalog.' };
    }

    // 4. Fetch Available Batches
    const allShopBatches = getShopBatches(shopId);
    const productBatches = allShopBatches.filter(
      (b) => b.productId === product.id && b.quantity > 0
    );

    const totalAvailable = productBatches.reduce((sum, b) => sum + b.quantity, 0);

    // 5. Prevent Overselling & Negative Stock
    if (totalAvailable < input.quantity) {
      return {
        error: `Insufficient stock: Only ${totalAvailable} units available (requested ${input.quantity}). Cannot oversell.`,
      };
    }

    // 6. FEFO Batch Deduction
    const sortedBatches = sortBatchesByFEFO(productBatches);
    let remainingToDeduct = input.quantity;
    const allocations: BatchAllocation[] = [];
    const updatedBatchesMap = new Map<string, StockBatch>(
      allShopBatches.map((b) => [b.id, { ...b }])
    );

    for (const batch of sortedBatches) {
      if (remainingToDeduct <= 0) break;

      const currentBatch = updatedBatchesMap.get(batch.id)!;
      const deductFromThis = Math.min(currentBatch.quantity, remainingToDeduct);

      currentBatch.quantity -= deductFromThis;
      remainingToDeduct -= deductFromThis;

      allocations.push({
        batchId: batch.id,
        quantityDeducted: deductFromThis,
        batchExpiryDate: batch.expiryDate,
      });
    }

    const remainingTotalStock = totalAvailable - input.quantity;

    // 7. Record Sale Transaction
    const now = new Date().toISOString();
    const saleId = `sale_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const unitPrice = input.unitPrice ?? product.sellingPrice ?? 0;
    const totalAmount = unitPrice * input.quantity;

    const isCurrentlyOffline =
      typeof navigator !== 'undefined' && !navigator.onLine;

    const newSale: Sale = {
      id: saleId,
      shopId,
      productId: product.id,
      quantity: input.quantity,
      unitPrice,
      totalAmount,
      allocations,
      idempotencyKey: input.idempotencyKey,
      isOfflineQueued: isCurrentlyOffline,
      createdAt: now,
    };

    // 8. Record Stock Movement
    const movementId = `mov_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newMovement: StockMovement = {
      id: movementId,
      shopId,
      productId: product.id,
      batchId: allocations[0]?.batchId || 'multi_batch',
      type: 'sale',
      quantityDelta: -input.quantity,
      resultingTotalQuantity: remainingTotalStock,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };

    // 9. Persist Local Batches, Sales, and Movements
    saveShopBatches(Array.from(updatedBatchesMap.values()), shopId);
    const existingSales = getLocalSales(shopId);
    saveLocalSales([newSale, ...existingSales], shopId);
    const existingMovements = getShopMovements(shopId);
    saveShopMovements([newMovement, ...existingMovements], shopId);

    // 10. Handle Offline Queue or Supabase Sync
    if (isCurrentlyOffline || !isSupabaseConfigured()) {
      if (isCurrentlyOffline) {
        const queueItem: OfflineQueueItem = {
          id: `queue_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          type: 'sale',
          payload: input,
          shopId,
          createdAt: now,
          status: 'pending',
        };
        const currentQueue = getOfflineQueue(shopId);
        saveOfflineQueue([queueItem, ...currentQueue], shopId);
      }
    } else {
      const supabase = getSupabase();
      if (supabase) {
        try {
          await supabase.from('sales').insert({
            id: newSale.id,
            shop_id: shopId,
            product_id: newSale.productId,
            quantity: newSale.quantity,
            unit_price: newSale.unitPrice,
            total_amount: newSale.totalAmount,
            allocations: newSale.allocations,
            created_at: now,
          });

          await supabase.from('stock_movements').insert({
            id: newMovement.id,
            shop_id: shopId,
            product_id: newMovement.productId,
            batch_id: newMovement.batchId,
            type: newMovement.type,
            quantity_delta: newMovement.quantityDelta,
            resulting_total_quantity: newMovement.resultingTotalQuantity,
            created_at: now,
          });
        } catch (err) {
          console.warn('Supabase sale insert failed, queued offline:', err);
          const queueItem: OfflineQueueItem = {
            id: `queue_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            type: 'sale',
            payload: input,
            shopId,
            createdAt: now,
            status: 'pending',
          };
          const currentQueue = getOfflineQueue(shopId);
          saveOfflineQueue([queueItem, ...currentQueue], shopId);
        }
      }
    }

    return {
      result: {
        sale: newSale,
        product,
        previousTotalStock: totalAvailable,
        remainingTotalStock,
        allocations,
        isQueuedOffline: isCurrentlyOffline,
      },
    };
  } finally {
    releaseLock();
  }
}

/**
 * Returns all sales records for the shop.
 */
export async function getSales(shopId: string = DEFAULT_SHOP_ID): Promise<Sale[]> {
  return getLocalSales(shopId);
}

/**
 * Syncs any pending offline operations once connectivity is restored.
 */
export async function syncOfflineQueue(
  shopId: string = DEFAULT_SHOP_ID
): Promise<{ syncedCount: number; errors: string[] }> {
  const queue = getOfflineQueue(shopId);
  if (queue.length === 0) return { syncedCount: 0, errors: [] };

  const pendingItems = queue.filter((item) => item.status === 'pending');
  let syncedCount = 0;
  const errors: string[] = [];

  const supabase = getSupabase();
  if (!supabase || !isSupabaseConfigured()) {
    return { syncedCount: 0, errors: ['Supabase not configured for remote sync.'] };
  }

  const remainingQueue: OfflineQueueItem[] = [];

  for (const item of queue) {
    if (item.status === 'pending') {
      try {
        const { error } = await supabase.from('sales_offline_sync').insert({
          queue_id: item.id,
          payload: item.payload,
          shop_id: item.shopId,
          synced_at: new Date().toISOString(),
        });

        if (error) {
          item.status = 'failed';
          item.error = error.message;
          remainingQueue.push(item);
          errors.push(error.message);
        } else {
          syncedCount++;
        }
      } catch (err: any) {
        item.status = 'failed';
        item.error = err?.message || 'Sync failed';
        remainingQueue.push(item);
        errors.push(item.error || 'Sync failed');
      }
    } else {
      remainingQueue.push(item);
    }
  }

  saveOfflineQueue(remainingQueue, shopId);
  return { syncedCount, errors };
}

/**
 * Clears sales data and idempotency for tests or store resets.
 */
export function clearSalesData(shopId: string = DEFAULT_SHOP_ID): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(getSalesKey(shopId));
    localStorage.removeItem(getOfflineQueueKey(shopId));
  }
  memorySales.delete(shopId);
  memoryOfflineQueue.delete(shopId);
  seenSaleIdempotency.clear();
  productLocks.clear();
}
