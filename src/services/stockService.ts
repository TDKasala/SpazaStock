import {
  StockBatch,
  StockMovement,
  StockInInput,
  StockInResult,
  ProductStockSummary,
  Product,
} from '../types';
import { DEFAULT_SHOP_ID, getProducts } from './productService';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

const BATCHES_STORAGE_KEY_PREFIX = 'spazastock_batches_';
const MOVEMENTS_STORAGE_KEY_PREFIX = 'spazastock_movements_';
const IDEMPOTENCY_SET_KEY_PREFIX = 'spazastock_idempotency_';

const memoryBatches = new Map<string, StockBatch[]>();
const memoryMovements = new Map<string, StockMovement[]>();
const memoryIdempotency = new Set<string>();

function getBatchesKey(shopId: string): string {
  return `${BATCHES_STORAGE_KEY_PREFIX}${shopId}`;
}

function getMovementsKey(shopId: string): string {
  return `${MOVEMENTS_STORAGE_KEY_PREFIX}${shopId}`;
}

export function getShopBatches(shopId: string = DEFAULT_SHOP_ID): StockBatch[] {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(getBatchesKey(shopId));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  return memoryBatches.get(shopId) || [];
}

export function saveShopBatches(batches: StockBatch[], shopId: string = DEFAULT_SHOP_ID): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(getBatchesKey(shopId), JSON.stringify(batches));
  }
  memoryBatches.set(shopId, batches);
}

export function getShopMovements(shopId: string = DEFAULT_SHOP_ID): StockMovement[] {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(getMovementsKey(shopId));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  return memoryMovements.get(shopId) || [];
}

export function saveShopMovements(movements: StockMovement[], shopId: string = DEFAULT_SHOP_ID): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(getMovementsKey(shopId), JSON.stringify(movements));
  }
  memoryMovements.set(shopId, movements);
}

function isIdempotencyKeySeen(key: string): boolean {
  if (typeof sessionStorage !== 'undefined') {
    return sessionStorage.getItem(`idem_${key}`) === 'true';
  }
  return memoryIdempotency.has(key);
}

function markIdempotencyKeySeen(key: string): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem(`idem_${key}`, 'true');
  }
  memoryIdempotency.add(key);
}

/**
 * Validates ISO date format YYYY-MM-DD
 */
export function isValidDateFormat(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateStr)) return false;
  const date = new Date(dateStr);
  const timestamp = date.getTime();
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) return false;
  return date.toISOString().startsWith(dateStr);
}

/**
 * Calculates days remaining until a given date string (YYYY-MM-DD)
 */
export function getDaysUntilExpiry(expiryDateStr: string | null): number | null {
  if (!expiryDateStr) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const parts = expiryDateStr.split('-');
  const expDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getTime();
  const diffMs = expDate - startOfToday;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Validates shop authorization / permission.
 */
export function validateShopPermission(requestedShopId: string, activeShopId: string = DEFAULT_SHOP_ID): boolean {
  if (!requestedShopId || !activeShopId) return false;
  return requestedShopId.trim() === activeShopId.trim();
}

/**
 * Records a stock-in delivery batch transactionally.
 * Increases inventory additively without overwriting prior batches.
 */
export async function stockIn(
  input: StockInInput,
  shopId: string = DEFAULT_SHOP_ID
): Promise<{ result?: StockInResult; error?: string }> {
  // 1. Validate Shop Permission
  if (!validateShopPermission(shopId, DEFAULT_SHOP_ID)) {
    return { error: 'Unauthorized: Action restricted to active shop.' };
  }

  // 2. Validate Product Existence
  if (!input.productId || !input.productId.trim()) {
    return { error: 'Product ID is required.' };
  }

  const products = await getProducts(shopId);
  const product = products.find((p) => p.id === input.productId.trim());
  if (!product) {
    return { error: 'Product not found in active shop catalog.' };
  }

  // 3. Validate Quantity (Must be positive integer)
  if (
    typeof input.quantity !== 'number' ||
    !Number.isInteger(input.quantity) ||
    input.quantity <= 0
  ) {
    return { error: 'Quantity must be a positive whole integer greater than zero.' };
  }

  // 4. Validate Expiry Date if provided
  let normalizedExpiry: string | null = null;
  if (input.expiryDate && input.expiryDate.trim()) {
    const trimmedDate = input.expiryDate.trim();
    if (!isValidDateFormat(trimmedDate)) {
      return { error: 'Invalid expiry date format. Please use YYYY-MM-DD.' };
    }
    normalizedExpiry = trimmedDate;
  }

  // 5. Duplicate Submission Prevention (Idempotency)
  if (input.idempotencyKey) {
    const key = `${shopId}_${input.idempotencyKey.trim()}`;
    if (isIdempotencyKeySeen(key)) {
      return { error: 'Duplicate submission rejected: This stock delivery was already processed.' };
    }
    markIdempotencyKeySeen(key);
  }

  // 6. Calculate Previous Total Quantity for this product
  const currentBatches = getShopBatches(shopId);
  const previousProductBatches = currentBatches.filter((b) => b.productId === product.id);
  const previousTotalQuantity = previousProductBatches.reduce((sum, b) => sum + b.quantity, 0);

  // 7. Create New Batch (separate batch preserves expiry date)
  const now = new Date().toISOString();
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const movementId = `mov_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const newBatch: StockBatch = {
    id: batchId,
    shopId,
    productId: product.id,
    quantity: input.quantity,
    expiryDate: normalizedExpiry,
    costPricePerUnit: input.costPricePerUnit ?? product.buyingPrice ?? null,
    receivedAt: now,
  };

  const resultingTotalQuantity = previousTotalQuantity + input.quantity;

  // 8. Create Transactional Stock Movement Record
  const newMovement: StockMovement = {
    id: movementId,
    shopId,
    productId: product.id,
    batchId: newBatch.id,
    type: 'stock_in',
    quantityDelta: input.quantity,
    resultingTotalQuantity,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
  };

  // 9. Persist Transaction
  saveShopBatches([newBatch, ...currentBatches], shopId);
  const currentMovements = getShopMovements(shopId);
  saveShopMovements([newMovement, ...currentMovements], shopId);

  // 10. Sync to Supabase if configured
  if (isSupabaseConfigured()) {
    const supabase = getSupabase();
    if (supabase) {
      try {
        await supabase.from('stock_batches').insert({
          id: newBatch.id,
          shop_id: shopId,
          product_id: newBatch.productId,
          quantity: newBatch.quantity,
          expiry_date: newBatch.expiryDate,
          cost_price_per_unit: newBatch.costPricePerUnit,
          received_at: newBatch.receivedAt,
        });

        await supabase.from('stock_movements').insert({
          id: newMovement.id,
          shop_id: shopId,
          product_id: newMovement.productId,
          batch_id: newMovement.batchId,
          type: newMovement.type,
          quantity_delta: newMovement.quantityDelta,
          resulting_total_quantity: newMovement.resultingTotalQuantity,
          idempotency_key: newMovement.idempotencyKey,
          created_at: newMovement.createdAt,
        });
      } catch (err) {
        console.warn('Supabase stock persistence failed, saved locally:', err);
      }
    }
  }

  return {
    result: {
      batch: newBatch,
      movement: newMovement,
      previousTotalQuantity,
      resultingTotalQuantity,
    },
  };
}

/**
 * Returns all stock batches for a given product.
 */
export async function getProductBatches(
  productId: string,
  shopId: string = DEFAULT_SHOP_ID
): Promise<StockBatch[]> {
  const batches = getShopBatches(shopId);
  return batches.filter((b) => b.productId === productId && b.quantity > 0);
}

/**
 * Returns total available stock quantity for a product.
 */
export async function getProductTotalStock(
  productId: string,
  shopId: string = DEFAULT_SHOP_ID
): Promise<number> {
  const batches = await getProductBatches(productId, shopId);
  return batches.reduce((sum, b) => sum + b.quantity, 0);
}

/**
 * Aggregates all registered products with their available stock and batch breakdowns.
 */
export async function getAllProductsStockSummary(
  shopId: string = DEFAULT_SHOP_ID
): Promise<ProductStockSummary[]> {
  const products = await getProducts(shopId);
  const allBatches = getShopBatches(shopId);

  return products.map((product) => {
    const productBatches = allBatches.filter(
      (b) => b.productId === product.id && b.quantity > 0
    );
    const totalQuantity = productBatches.reduce((sum, b) => sum + b.quantity, 0);

    // Find earliest expiry date
    const expiryDates = productBatches
      .map((b) => b.expiryDate)
      .filter((d): d is string => d !== null)
      .sort();

    const earliestExpiry = expiryDates.length > 0 ? expiryDates[0] : null;
    let isExpired = false;
    let isExpiringSoon = false;

    if (earliestExpiry) {
      const days = getDaysUntilExpiry(earliestExpiry);
      if (days !== null) {
        if (days < 0) isExpired = true;
        else if (days <= 7) isExpiringSoon = true;
      }
    }

    return {
      product,
      totalQuantity,
      batches: productBatches,
      earliestExpiry,
      isExpired,
      isExpiringSoon,
    };
  });
}

export interface ExpiringBatchAlert {
  batch: StockBatch;
  product: Product;
  daysUntilExpiry: number;
  status: 'expired' | 'urgent' | 'warning' | 'ok';
}

/**
 * Retrieves expiring batches across the active shop.
 */
export async function getExpiringBatches(
  shopId: string = DEFAULT_SHOP_ID,
  thresholdDays: number = 30
): Promise<ExpiringBatchAlert[]> {
  const products = await getProducts(shopId);
  const productsMap = new Map<string, Product>(products.map((p) => [p.id, p]));
  const batches = getShopBatches(shopId).filter((b) => b.quantity > 0 && b.expiryDate !== null);

  const alerts: ExpiringBatchAlert[] = [];

  for (const batch of batches) {
    if (!batch.expiryDate) continue;
    const days = getDaysUntilExpiry(batch.expiryDate);
    if (days === null) continue;

    if (days <= thresholdDays) {
      const product = productsMap.get(batch.productId);
      if (product) {
        let status: 'expired' | 'urgent' | 'warning' | 'ok' = 'ok';
        if (days < 0) status = 'expired';
        else if (days <= 7) status = 'urgent';
        else status = 'warning';

        alerts.push({
          batch,
          product,
          daysUntilExpiry: days,
          status,
        });
      }
    }
  }

  // Sort: expired first, then closest to expiry
  return alerts.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
}

/**
 * Clears all stock data for tests or store resets.
 */
export function clearStockData(shopId: string = DEFAULT_SHOP_ID): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(getBatchesKey(shopId));
    localStorage.removeItem(getMovementsKey(shopId));
  }
  memoryBatches.delete(shopId);
  memoryMovements.delete(shopId);
  memoryIdempotency.clear();
}
