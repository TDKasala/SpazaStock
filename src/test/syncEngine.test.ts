import { describe, it, expect, beforeEach } from 'vitest';
import { backoffMs, isPermanentError, MAX_ATTEMPTS, pullChanges, pushOutbox } from '../sync/syncEngine';
import { createProduct } from '../services/productService';
import { stockIn, getProductTotalStock } from '../services/stockService';
import { recordSale } from '../services/salesService';
import { db, getMeta, resetLocalDatabase } from '../lib/db';
import type { Product } from '../types';
import { createFakeSupabase, SHOP_ID } from './helpers';

function productRow(product: Product, overrides: Record<string, unknown> = {}) {
  return {
    id: product.id,
    shop_id: product.shopId,
    barcode: product.barcode,
    name: product.name,
    category: product.category,
    buying_price: product.buyingPrice ?? null,
    selling_price: product.sellingPrice != null ? String(product.sellingPrice) : null,
    created_at: product.createdAt,
    updated_at: product.updatedAt,
    ...overrides,
  };
}

async function makeProduct(): Promise<Product> {
  const { product } = await createProduct(
    { barcode: '6001087361250', name: 'Simba Chips', category: 'snacks', sellingPrice: 15 },
    SHOP_ID
  );
  return product!;
}

/** RPC handler that accepts everything the way the real functions do. */
function acceptAll(name: string, args: Record<string, unknown>) {
  if (name === 'upsert_product') {
    return {
      data: {
        id: args.p_id,
        shop_id: args.p_shop_id,
        barcode: args.p_barcode,
        name: args.p_name,
        category: args.p_category,
        buying_price: args.p_buying_price,
        selling_price: args.p_selling_price,
        created_at: args.p_created_at,
        updated_at: new Date().toISOString(),
      },
      error: null,
    };
  }
  return { data: {}, error: null };
}

describe('sync error classification', () => {
  it('treats data, constraint, permission and raised errors as permanent', () => {
    for (const code of ['22023', '23503', '23505', '42501', 'P0001', 'P0002']) {
      expect(isPermanentError({ code })).toBe(true);
    }
  });

  it('retries network failures, timeouts, auth expiry and missing functions', () => {
    for (const code of [undefined, '', '08006', '57014', 'PGRST301', 'PGRST202', '53300']) {
      expect(isPermanentError({ code })).toBe(false);
    }
  });

  it('backs off exponentially up to ten minutes', () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(10_000);
    expect(backoffMs(4)).toBe(40_000);
    expect(backoffMs(20)).toBe(600_000);
  });
});

describe('pushOutbox', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
  });

  it('sends queued changes in order through the RPCs and clears them', async () => {
    const product = await makeProduct();
    await stockIn({ productId: product.id, quantity: 6, expiryDate: '2026-11-30', idempotencyKey: 'd1' }, SHOP_ID);
    await recordSale({ productId: product.id, quantity: 2, idempotencyKey: 's1' }, SHOP_ID);

    const fake = createFakeSupabase({ rpc: acceptAll });
    const result = await pushOutbox(fake.client, SHOP_ID);

    expect(result).toEqual({ pushed: 3, failed: 0, retryAt: null });
    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual(['upsert_product', 'record_stock_in', 'record_sale']);
    expect(fake.rpc.mock.calls[1][1]).toMatchObject({
      p_shop_id: SHOP_ID,
      p_product_id: product.id,
      p_quantity: 6,
      p_expiry_date: '2026-11-30',
      p_idempotency_key: 'd1',
    });
    expect(fake.rpc.mock.calls[2][1]).toMatchObject({ p_quantity: 2, p_idempotency_key: 's1', p_unit_price: 15 });
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps an item that the server rejects, marked as failed', async () => {
    await makeProduct();
    const fake = createFakeSupabase({
      rpc: () => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }),
    });

    const result = await pushOutbox(fake.client, SHOP_ID);
    expect(result.failed).toBe(1);
    const [item] = await db.outbox.toArray();
    expect(item).toMatchObject({ status: 'failed', lastError: 'new row violates row-level security policy' });
  });

  it('keeps an item queued with backoff when the network fails, and stops there', async () => {
    const product = await makeProduct();
    await stockIn({ productId: product.id, quantity: 1 }, SHOP_ID);
    const fake = createFakeSupabase({
      rpc: () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const now = 1_000_000;
    const result = await pushOutbox(fake.client, SHOP_ID, now);
    expect(result).toEqual({ pushed: 0, failed: 0, retryAt: now + 5_000 });
    expect(fake.rpc).toHaveBeenCalledTimes(1);

    const items = await db.outbox.orderBy('seq').toArray();
    expect(items.map((i) => i.status)).toEqual(['pending', 'pending']);
    expect(items[0]).toMatchObject({ attempts: 1, nextAttemptAt: now + 5_000, lastError: 'Failed to fetch' });

    // Not due yet: nothing is sent.
    const early = await pushOutbox(fake.client, SHOP_ID, now + 1_000);
    expect(early.retryAt).toBe(now + 5_000);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
  });

  it('treats a returned error without a Postgres code as retryable', async () => {
    await makeProduct();
    const fake = createFakeSupabase({ rpc: () => ({ data: null, error: { message: 'JWT expired' } }) });
    await pushOutbox(fake.client, SHOP_ID, 0);
    const [item] = await db.outbox.toArray();
    expect(item).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it(`gives up after ${MAX_ATTEMPTS} attempts`, async () => {
    await makeProduct();
    const [queued] = await db.outbox.toArray();
    await db.outbox.update(queued.seq!, { attempts: MAX_ATTEMPTS - 1 });
    const fake = createFakeSupabase({ rpc: () => ({ data: null, error: { message: 'timeout' } }) });

    const result = await pushOutbox(fake.client, SHOP_ID, 0);
    expect(result.failed).toBe(1);
    expect((await db.outbox.toArray())[0].status).toBe('failed');
  });

  it('remaps a locally created product to the canonical server product', async () => {
    const product = await makeProduct();
    await stockIn({ productId: product.id, quantity: 4 }, SHOP_ID);
    const canonicalId = '33333333-3333-4333-8333-333333333333';

    const fake = createFakeSupabase({
      rpc: (name, args) => {
        if (name === 'upsert_product') return { data: productRow(product, { id: canonicalId }), error: null };
        return acceptAll(name, args);
      },
    });
    const result = await pushOutbox(fake.client, SHOP_ID);

    expect(result.pushed).toBe(2);
    expect(fake.rpc.mock.calls[1][1]).toMatchObject({ p_product_id: canonicalId });
    expect(await db.products.get(product.id)).toBeUndefined();
    expect((await db.products.get(canonicalId))?.sellingPrice).toBe(15);
    expect(await getProductTotalStock(canonicalId, SHOP_ID)).toBe(4);
  });

  it("applies the server's batch allocation to the local sale", async () => {
    const product = await makeProduct();
    await stockIn({ productId: product.id, quantity: 4 }, SHOP_ID);
    const { result: sale } = await recordSale({ productId: product.id, quantity: 1 }, SHOP_ID);
    const serverAllocations = [{ batchId: 'server-batch', quantityDeducted: 1, batchExpiryDate: null }];

    const fake = createFakeSupabase({
      rpc: (name, args) => {
        if (name !== 'record_sale') return acceptAll(name, args);
        return {
          data: {
            sale: {
              id: sale!.sale.id,
              shop_id: SHOP_ID,
              product_id: product.id,
              quantity: 1,
              unit_price: '15.00',
              total_amount: '15.00',
              allocations: serverAllocations,
              idempotency_key: sale!.sale.idempotencyKey,
              sold_at: sale!.sale.createdAt,
            },
            duplicate: false,
            shortfall: 0,
          },
          error: null,
        };
      },
    });
    await pushOutbox(fake.client, SHOP_ID);

    const stored = await db.sales.get(sale!.sale.id);
    expect(stored?.allocations).toEqual(serverAllocations);
    expect(stored?.totalAmount).toBe(15);
  });

  it('marks discrepancies resolved on the server', async () => {
    const { resolveDiscrepancy } = await import('../services/stockService');
    const product = await makeProduct();
    await db.discrepancies.add({
      id: 'd1',
      shopId: SHOP_ID,
      productId: product.id,
      saleId: null,
      shortfall: 1,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
    });
    await resolveDiscrepancy('d1', SHOP_ID);

    const fake = createFakeSupabase({ rpc: acceptAll });
    await pushOutbox(fake.client, SHOP_ID);
    expect(fake.updates).toEqual([
      { table: 'stock_discrepancies', values: { resolved_at: expect.any(String) }, id: 'd1' },
    ]);
  });
});

describe('pullChanges', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
  });

  it('overwrites local stock with server rows so devices converge', async () => {
    const product = await makeProduct();
    const { result } = await stockIn({ productId: product.id, quantity: 10 }, SHOP_ID);
    await db.outbox.clear();

    const batch = result!.batch;
    const fake = createFakeSupabase({
      rows: {
        products: [productRow(product, { name: 'Simba Chips 120g', updated_at: '2026-10-14T08:00:00Z' })],
        stock_batches: [
          {
            id: batch.id,
            shop_id: SHOP_ID,
            product_id: product.id,
            quantity: 7, // another phone sold 3
            initial_quantity: 10,
            expiry_date: null,
            cost_price_per_unit: null,
            received_at: batch.receivedAt,
            updated_at: '2026-10-14T08:05:00Z',
          },
        ],
        stock_discrepancies: [
          {
            id: 'd9',
            shop_id: SHOP_ID,
            product_id: product.id,
            sale_id: null,
            shortfall: 2,
            resolved_at: null,
            created_at: '2026-10-14T08:05:00Z',
            updated_at: '2026-10-14T08:05:00Z',
          },
        ],
      },
    });

    const applied = await pullChanges(fake.client, SHOP_ID);
    expect(applied).toBe(3);
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(7);
    expect((await db.products.get(product.id))?.name).toBe('Simba Chips 120g');
    expect(await db.discrepancies.count()).toBe(1);
    expect(await getMeta(`pull:${SHOP_ID}:stock_batches`)).toBe('2026-10-14T08:05:00.000Z');
  });

  it('does not pull while local changes are waiting to be pushed', async () => {
    const product = await makeProduct();
    const fake = createFakeSupabase({
      rows: { products: [productRow(product, { name: 'Server name', updated_at: '2026-10-14T08:00:00Z' })] },
    });

    expect(await pullChanges(fake.client, SHOP_ID)).toBe(0);
    expect(fake.from).not.toHaveBeenCalled();
    expect((await db.products.get(product.id))?.name).toBe('Simba Chips');
  });

  it('resumes from the saved cursor', async () => {
    const product = await makeProduct();
    await db.outbox.clear();
    const fake = createFakeSupabase({
      rows: { products: [productRow(product, { updated_at: '2026-10-14T08:00:00Z' })] },
    });

    await pullChanges(fake.client, SHOP_ID);
    fake.rows.products.push(
      productRow({ ...product, id: '44444444-4444-4444-8444-444444444444', barcode: '1' }, { updated_at: '2026-10-14T09:00:00Z' })
    );
    // The first row is re-read within the overlap window; only the new row is new.
    await pullChanges(fake.client, SHOP_ID);
    expect(await db.products.count()).toBe(2);
    expect(await getMeta(`pull:${SHOP_ID}:products`)).toBe('2026-10-14T09:00:00.000Z');
  });
});
