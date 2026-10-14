import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncController } from '../sync/syncController';
import { createProduct } from '../services/productService';
import { db, resetLocalDatabase } from '../lib/db';
import { createFakeSupabase, setOnline, SHOP_ID } from './helpers';

function upsertOk(_name: string, args: Record<string, unknown>) {
  return {
    data: {
      id: args.p_id,
      shop_id: args.p_shop_id,
      barcode: args.p_barcode,
      name: args.p_name,
      category: args.p_category,
      buying_price: null,
      selling_price: null,
      created_at: args.p_created_at,
      updated_at: new Date().toISOString(),
    },
    error: null,
  };
}

describe('SyncController', () => {
  let controller: SyncController | null = null;

  beforeEach(async () => {
    await resetLocalDatabase();
    setOnline(true);
  });

  afterEach(() => {
    controller?.stop();
    controller = null;
    setOnline(true);
  });

  it('is disabled without a Supabase client (device-only mode)', async () => {
    controller = new SyncController(null, SHOP_ID);
    await controller.syncNow();
    expect(controller.getStatus().enabled).toBe(false);
  });

  it('keeps changes queued while offline and sends them when back online', async () => {
    await createProduct({ barcode: '123', name: 'Matches', category: 'household' }, SHOP_ID);
    const fake = createFakeSupabase({ rpc: upsertOk });
    controller = new SyncController(fake.client, SHOP_ID);

    setOnline(false);
    await controller.syncNow();
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(controller.getStatus()).toMatchObject({ isOnline: false, pending: 1 });

    setOnline(true);
    await controller.syncNow();
    expect(fake.rpc).toHaveBeenCalledWith('upsert_product', expect.objectContaining({ p_barcode: '123' }));
    expect(controller.getStatus()).toMatchObject({ isOnline: true, pending: 0, failed: 0 });
    expect(controller.getStatus().lastSyncedAt).not.toBeNull();
  });

  it('reports failed items instead of dropping them', async () => {
    await createProduct({ barcode: '123', name: 'Matches', category: 'household' }, SHOP_ID);
    const fake = createFakeSupabase({
      rpc: () => ({ data: null, error: { code: '23514', message: 'violates check constraint' } }),
    });
    controller = new SyncController(fake.client, SHOP_ID);

    await controller.syncNow();
    expect(controller.getStatus()).toMatchObject({ pending: 0, failed: 1 });
    expect(await db.outbox.count()).toBe(1);
  });

  it('joins a sync that is already running instead of starting a second one', async () => {
    const fake = createFakeSupabase();
    controller = new SyncController(fake.client, SHOP_ID);
    const first = controller.syncNow();
    expect(controller.syncNow()).toBe(first);
    await first;
  });
});
