import type { Product, ProductCategory, StockBatch, StockMovement } from '../types';
import { db, getMeta, setMeta, withWriteLock } from './db';
import { newId } from './ids';
import { emitDataChanged } from './events';
import { enqueue } from '../sync/outbox';

const LEGACY_SHOP_ID = 'spaza_active_shop';
const LEGACY_KEYS = {
  products: `spazastock_products_${LEGACY_SHOP_ID}`,
  batches: `spazastock_batches_${LEGACY_SHOP_ID}`,
  movements: `spazastock_movements_${LEGACY_SHOP_ID}`,
  sales: `spazastock_sales_${LEGACY_SHOP_ID}`,
  offlineQueue: `spazastock_offline_queue_${LEGACY_SHOP_ID}`,
};
const DONE_KEY = 'legacyLocalStorageImported';

interface LegacyProduct {
  id: string;
  barcode: string;
  name: string;
  category: ProductCategory;
  buyingPrice?: number | null;
  sellingPrice?: number | null;
  createdAt?: string;
}

interface LegacyBatch {
  productId: string;
  quantity: number;
  expiryDate: string | null;
  costPricePerUnit?: number | null;
  receivedAt?: string;
}

function readJson<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Imports catalog and remaining stock saved by the pre-IndexedDB version of the app into
 * `shopId`, giving every row a UUID and queueing it for sync. Old sales history is not
 * re-imported because its effect is already reflected in the remaining batch quantities.
 * Runs at most once per device.
 */
export async function importLegacyLocalStorage(shopId: string): Promise<number> {
  if (typeof localStorage === 'undefined') return 0;
  if (await getMeta(DONE_KEY)) return 0;

  const legacyProducts = readJson<LegacyProduct>(LEGACY_KEYS.products);
  const legacyBatches = readJson<LegacyBatch>(LEGACY_KEYS.batches);

  let imported = 0;
  if (legacyProducts.length > 0) {
    imported = await withWriteLock(() =>
      db.transaction('rw', db.products, db.batches, db.movements, db.outbox, db.meta, async () => {
        const idMap = new Map<string, string>();
        let count = 0;

        for (const legacy of legacyProducts) {
          const barcode = String(legacy.barcode ?? '').replace(/\s/g, '');
          if (!barcode || !legacy.name) continue;

          const existing = await db.products
            .where('[shopId+barcode]')
            .equals([shopId, barcode])
            .first();
          if (existing) {
            idMap.set(legacy.id, existing.id);
            continue;
          }

          const now = new Date().toISOString();
          const product: Product = {
            id: newId(),
            shopId,
            barcode,
            name: legacy.name.trim(),
            category: legacy.category ?? 'other',
            buyingPrice: legacy.buyingPrice ?? null,
            sellingPrice: legacy.sellingPrice ?? null,
            createdAt: legacy.createdAt ?? now,
            updatedAt: now,
          };
          await db.products.add(product);
          await enqueue(shopId, { type: 'product_upsert', payload: { product } });
          idMap.set(legacy.id, product.id);
          count++;
        }

        const runningTotals = new Map<string, number>();
        for (const legacy of legacyBatches) {
          const productId = idMap.get(legacy.productId);
          const quantity = Math.floor(Number(legacy.quantity));
          if (!productId || !(quantity > 0)) continue;

          const receivedAt = legacy.receivedAt ?? new Date().toISOString();
          const batch: StockBatch = {
            id: newId(),
            shopId,
            productId,
            quantity,
            initialQuantity: quantity,
            expiryDate: legacy.expiryDate ?? null,
            costPricePerUnit: legacy.costPricePerUnit ?? null,
            receivedAt,
          };
          const total = (runningTotals.get(productId) ?? 0) + quantity;
          runningTotals.set(productId, total);

          const movement: StockMovement = {
            id: newId(),
            shopId,
            productId,
            batchId: batch.id,
            type: 'stock_in',
            quantityDelta: quantity,
            resultingTotalQuantity: total,
            createdAt: receivedAt,
          };
          await db.batches.add(batch);
          await db.movements.add(movement);
          await enqueue(shopId, { type: 'stock_in', payload: { batch, movementId: movement.id } });
        }

        await setMeta(DONE_KEY, new Date().toISOString());
        return count;
      })
    );
  } else {
    await setMeta(DONE_KEY, new Date().toISOString());
  }

  for (const key of Object.values(LEGACY_KEYS)) localStorage.removeItem(key);
  if (imported > 0) emitDataChanged('local');
  return imported;
}
