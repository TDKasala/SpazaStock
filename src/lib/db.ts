import Dexie, { type EntityTable } from 'dexie';
import type {
  Product,
  Sale,
  StockBatch,
  StockDiscrepancy,
  StockMovement,
} from '../types';

export type OutboxOperation =
  | { type: 'product_upsert'; payload: { product: Product } }
  | {
      type: 'stock_in';
      payload: { batch: StockBatch; movementId: string; idempotencyKey?: string };
    }
  | { type: 'sale'; payload: { sale: Sale; movementId?: string } }
  | {
      type: 'sale_void';
      payload: { saleId: string; quantity: number; idempotencyKey: string; occurredAt: string };
    }
  | { type: 'discrepancy_resolve'; payload: { id: string; resolvedAt: string } };

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

/** Every table the write path touches, for `db.transaction('rw', WRITE_TABLES, ...)`. */
export const WRITE_TABLES = [
  db.products,
  db.batches,
  db.movements,
  db.sales,
  db.discrepancies,
  db.outbox,
];

export async function getMeta(key: string): Promise<string | undefined> {
  return (await db.meta.get(key))?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
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
