import { db, type OutboxItem, type OutboxOperation } from '../lib/db';
import { newId } from '../lib/ids';
import { DEVICE_SHOP_ID } from '../lib/constants';

/**
 * Queues a change for the sync engine. Must be called inside a Dexie read-write transaction
 * that includes `db.outbox`. The device-only shop has no server, so nothing is queued for it.
 */
export async function enqueue(shopId: string, operation: OutboxOperation): Promise<void> {
  if (shopId === DEVICE_SHOP_ID) return;
  const item: OutboxItem = {
    ...operation,
    id: newId(),
    shopId,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: new Date().toISOString(),
  };
  await db.outbox.add(item);
}

export async function countOutbox(shopId: string): Promise<{ pending: number; failed: number }> {
  const [pending, failed] = await Promise.all([
    db.outbox.where('[shopId+status]').equals([shopId, 'pending']).count(),
    db.outbox.where('[shopId+status]').equals([shopId, 'failed']).count(),
  ]);
  return { pending, failed };
}

export async function getFailedOutboxItems(shopId: string): Promise<OutboxItem[]> {
  return db.outbox.where('[shopId+status]').equals([shopId, 'failed']).sortBy('seq');
}

/** Puts failed items back in the queue so the next sync retries them. */
export async function retryFailedOutboxItems(shopId: string): Promise<void> {
  await db.outbox
    .where('[shopId+status]')
    .equals([shopId, 'failed'])
    .modify({ status: 'pending', attempts: 0, nextAttemptAt: 0 });
}
