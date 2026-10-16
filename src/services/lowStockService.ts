import type { LowStockDismissal } from '../types';
import { db, withWriteLock } from '../lib/db';
import { newId } from '../lib/ids';
import { emitDataChanged } from '../lib/events';
import { can } from '../lib/permissions';
import { getShopSettings } from '../lib/shopSettings';
import { enqueue } from '../sync/outbox';

async function canViewInventory(shopId: string): Promise<boolean> {
  return can((await getShopSettings(shopId)).role, 'inventory.view');
}

export async function getLowStockDismissals(shopId: string): Promise<LowStockDismissal[]> {
  return db.lowStockDismissals.where('shopId').equals(shopId).toArray();
}

/**
 * Quiets the low-stock sound for this product. A second call while the dismissal is still open
 * does nothing, including not queueing another sync.
 */
export async function dismissLowStock(productId: string, shopId: string): Promise<LowStockDismissal | null> {
  if (!(await canViewInventory(shopId))) return null;

  const saved = await withWriteLock(() =>
    db.transaction('rw', db.lowStockDismissals, db.outbox, async () => {
      const existing = await db.lowStockDismissals.where('[shopId+productId]').equals([shopId, productId]).first();
      if (existing && !existing.clearedAt) return existing;

      const now = new Date().toISOString();
      const row: LowStockDismissal = existing
        ? { ...existing, dismissedAt: now, clearedAt: null, updatedAt: now }
        : {
            id: newId(),
            shopId,
            productId,
            dismissedAt: now,
            dismissedBy: null,
            clearedAt: null,
            updatedAt: now,
          };
      await db.lowStockDismissals.put(row);
      await enqueue(shopId, { type: 'low_stock_dismiss', payload: { productId } });
      return row;
    })
  );

  emitDataChanged('local');
  return saved;
}

/** Forgets a dismissal after sellable stock rises above the minimum. Missing rows are ignored. */
export async function clearLowStockDismissal(productId: string, shopId: string): Promise<void> {
  if (!(await canViewInventory(shopId))) return;

  const changed = await withWriteLock(() =>
    db.transaction('rw', db.lowStockDismissals, db.outbox, async () => {
      const existing = await db.lowStockDismissals.where('[shopId+productId]').equals([shopId, productId]).first();
      if (!existing || existing.clearedAt) return false;
      const now = new Date().toISOString();
      await db.lowStockDismissals.put({ ...existing, clearedAt: now, updatedAt: now });
      await enqueue(shopId, { type: 'low_stock_clear', payload: { productId } });
      return true;
    })
  );

  if (changed) emitDataChanged('local');
}
