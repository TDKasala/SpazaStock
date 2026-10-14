import Dexie, { type EntityTable, type Table } from 'dexie';
import type {
  ExpiryAlert,
  ExpiryResolutionAction,
  Product,
  ProductEditInput,
  Sale,
  StockBatch,
  StockDiscrepancy,
  StockMovement,
} from '../types';

export type OutboxOperation =
  | { type: 'product_upsert'; payload: { product: Product } }
  | { type: 'product_update'; payload: { productId: string; changes: ProductEditInput } }
  | { type: 'product_archive'; payload: { productId: string; archived: boolean } }
  | {
      type: 'stock_in';
      payload: { batch: StockBatch; movementId: string; idempotencyKey?: string };
    }
  | { type: 'sale'; payload: { sale: Sale; movementId?: string } }
  | {
      type: 'sale_void';
      payload: { saleId: string; quantity: number; idempotencyKey: string; occurredAt: string };
    }
  | { type: 'discrepancy_resolve'; payload: { id: string; resolvedAt: string } }
  | {
      type: 'expiry_resolve';
      payload: {
        batchId: string;
        action: ExpiryResolutionAction;
        newExpiryDate: string | null;
        note: string | null;
        idempotencyKey: string;
        occurredAt: string;
      };
    };

export type OutboxItem = OutboxOperation & {
  seq?: number;
  id: string;
  shopId: string;
  status: 'pending' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: string;
};

export interface MetaRow {
  key: string;
  value: string;
}

export type SpazaDatabase = Dexie & {
  products: EntityTable<Product, 'id'>;
  batches: EntityTable<StockBatch, 'id'>;
  movements: EntityTable<StockMovement, 'id'>;
  sales: EntityTable<Sale, 'id'>;
  discrepancies: EntityTable<StockDiscrepancy, 'id'>;
  expiryAlerts: EntityTable<ExpiryAlert, 'id'>;
  outbox: EntityTable<OutboxItem, 'seq'>;
  meta: EntityTable<MetaRow, 'key'>;
};

export const db = new Dexie('spazastock') as SpazaDatabase;

db.version(1).stores({
  products: 'id, shopId, [shopId+barcode], [shopId+createdAt]',
  batches: 'id, shopId, productId, [shopId+productId]',
  movements: 'id, shopId, productId, [shopId+idempotencyKey]',
  sales: 'id, shopId, productId, [shopId+idempotencyKey], [shopId+createdAt]',
  discrepancies: 'id, shopId, productId',
  outbox: '++seq, &id, shopId, [shopId+status]',
  meta: 'key',
});

db.version(2).stores({
  expiryAlerts: 'id, shopId, batchId, productId',
});

/** Every table the write path touches, for `db.transaction('rw', WRITE_TABLES, ...)`. */
export const WRITE_TABLES = [
  db.products,
  db.batches,
  db.movements,
  db.sales,
  db.discrepancies,
  db.expiryAlerts,
  db.outbox,
];

export async function getMeta(key: string): Promise<string | undefined> {
  return (await db.meta.get(key))?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}

/**
 * Removes everything this phone holds for one shop, including unsynced changes and sync cursors.
 * Used when the user's access to the shop has ended.
 */
export async function clearShopData(shopId: string): Promise<void> {
  await withWriteLock(() =>
    db.transaction('rw', [...WRITE_TABLES, db.meta], async () => {
      for (const table of WRITE_TABLES as Table[]) {
        await table.where('shopId').equals(shopId).delete();
      }
      const keys = await db.meta.toCollection().primaryKeys();
      await db.meta.bulkDelete(keys.filter((key) => String(key).includes(shopId)));
    })
  );
}

/** Wipes the local store; used by tests. */
export async function resetLocalDatabase(): Promise<void> {
  await Promise.all(db.tables.map((table) => table.clear()));
}

/**
 * Serialises local writes across browser tabs. IndexedDB already orders overlapping read-write
 * transactions, but the Web Locks API also keeps a second tab's sync engine from interleaving
 * with this tab's read-modify-write sequences.
 */
export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('spazastock-write', fn);
  }
  return fn();
}
