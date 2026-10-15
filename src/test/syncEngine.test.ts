import { describe, it, expect, beforeEach } from 'vitest';
import { backoffMs, isPermanentError, MAX_ATTEMPTS, pullChanges, pushOutbox } from '../sync/syncEngine';
import { createProduct, resolveBarcode, setProductArchived, updateProduct } from '../services/productService';
import { createPackaging, linkBarcode, unlinkBarcode } from '../services/barcodeLinkService';
import { removeProductImage, saveProductImage } from '../services/productImageService';
import { saveShopSettings } from '../lib/shopSettings';
import { stockIn, getProductTotalStock } from '../services/stockService';
import { recordSale, voidSale } from '../services/salesService';
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
    const saleArgs = fake.rpc.mock.calls[2][1] as { p_sale_id: string; p_items: unknown[] };
    expect(saleArgs).toMatchObject({ p_shop_id: SHOP_ID, p_idempotency_key: 's1' });
    expect(saleArgs.p_items).toEqual([
      { id: saleArgs.p_sale_id, product_id: product.id, quantity: 2, unit_price: 15 },
    ]);
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
              total_amount: '15.00',
              item_count: 1,
              idempotency_key: sale!.sale.idempotencyKey,
              sold_at: sale!.sale.createdAt,
            },
            items: [
              {
                id: sale!.sale.id,
                shop_id: SHOP_ID,
                sale_id: sale!.sale.id,
                product_id: product.id,
                quantity: 1,
                unit_price: '15.00',
                line_total: '15.00',
                allocations: serverAllocations,
              },
            ],
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

  it('pushes an undo after its sale and keeps the local undo until the server has it', async () => {
    const product = await makeProduct();
    await stockIn({ productId: product.id, quantity: 5 }, SHOP_ID);
    const { result } = await recordSale({ productId: product.id, quantity: 3, idempotencyKey: 's1' }, SHOP_ID);
    const sale = result!.sale;
    const undo = await voidSale({ saleId: sale.id, quantity: 1, idempotencyKey: 'u1' }, SHOP_ID);
    expect(undo.result).toBeDefined();

    const header = {
      id: sale.id,
      shop_id: SHOP_ID,
      total_amount: '45.00',
      item_count: 1,
      idempotency_key: 's1',
      sold_at: sale.createdAt,
    };
    const line = (voided: number) => ({
      id: sale.id,
      shop_id: SHOP_ID,
      sale_id: sale.id,
      product_id: product.id,
      quantity: 3,
      unit_price: '15.00',
      line_total: '45.00',
      allocations: sale.allocations,
      voided_quantity: voided,
    });
    let voidReachable = false;
    const fake = createFakeSupabase({
      rpc: (name, args) => {
        if (name === 'record_sale') {
          return { data: { sale: header, items: [line(0)], duplicate: false, shortfall: 0 }, error: null };
        }
        if (name === 'void_sale_item') {
          if (!voidReachable) throw new TypeError('Failed to fetch');
          return { data: { sale: header, item: line(1), stock_total: 3, duplicate: false }, error: null };
        }
        return acceptAll(name, args);
      },
    });

    // The sale reaches the server but the undo doesn't: the local undo must survive.
    const first = await pushOutbox(fake.client, SHOP_ID, 0);
    expect(first.pushed).toBe(3);
    expect((await db.sales.get(sale.id))?.voidedQuantity).toBe(1);
    expect((await db.outbox.toArray()).map((i) => i.type)).toEqual(['sale_void']);

    voidReachable = true;
    await pushOutbox(fake.client, SHOP_ID, Date.now() + 60_000);
    const voidCall = fake.rpc.mock.calls.filter(([name]) => name === 'void_sale_item').at(-1)![1];
    expect(voidCall).toEqual({
      p_shop_id: SHOP_ID,
      p_sale_item_id: sale.id,
      p_quantity: 1,
      p_occurred_at: expect.any(String),
      p_idempotency_key: 'u1',
    });
    expect(await db.outbox.count()).toBe(0);
    expect(await db.sales.get(sale.id)).toMatchObject({ quantity: 3, voidedQuantity: 1, totalAmount: 45 });
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

  it('sends expiry resolutions with their idempotency key and applies the server batch', async () => {
    const { resolveExpiredBatch } = await import('../services/stockService');
    const product = await makeProduct();
    const { result } = await stockIn({ productId: product.id, quantity: 4, expiryDate: '2020-01-01' }, SHOP_ID);
    const batch = result!.batch;
    await resolveExpiredBatch({ batchId: batch.id, action: 'discarded', note: 'Binned', idempotencyKey: 'x1' }, SHOP_ID);

    const fake = createFakeSupabase({
      rpc: (name, args) =>
        name === 'resolve_expired_batch'
          ? {
              data: {
                duplicate: false,
                batch: {
                  id: batch.id,
                  shop_id: SHOP_ID,
                  product_id: product.id,
                  quantity: 0,
                  initial_quantity: 4,
                  expiry_date: '2020-01-01',
                  cost_price_per_unit: null,
                  received_at: batch.receivedAt,
                },
              },
              error: null,
            }
          : acceptAll(name, args),
    });
    expect(await pushOutbox(fake.client, SHOP_ID)).toMatchObject({ pushed: 3, failed: 0 });
    const call = fake.rpc.mock.calls.find(([name]) => name === 'resolve_expired_batch');
    expect(call?.[1]).toEqual({
      p_shop_id: SHOP_ID,
      p_batch_id: batch.id,
      p_action: 'discarded',
      p_new_expiry_date: null,
      p_note: 'Binned',
      p_occurred_at: expect.any(String),
      p_idempotency_key: 'x1',
    });
    expect((await db.batches.get(batch.id))?.quantity).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe('product edits and archiving', () => {
  const SERVER_TIME = '2026-10-14T09:00:00.000Z';

  /** Answers update_product and set_product_archived like the real functions. */
  function productRpcs(product: Product) {
    return (name: string, args: Record<string, unknown>) => {
      if (name === 'update_product') {
        return {
          data: productRow(product, {
            barcode: args.p_barcode,
            name: args.p_name,
            category: args.p_category,
            buying_price: args.p_buying_price,
            selling_price: args.p_selling_price,
            updated_at: SERVER_TIME,
          }),
          error: null,
        };
      }
      if (name === 'set_product_archived') {
        return {
          data: productRow(product, { archived_at: args.p_archived ? SERVER_TIME : null, updated_at: SERVER_TIME }),
          error: null,
        };
      }
      return acceptAll(name, args);
    };
  }

  async function syncedProduct(): Promise<Product> {
    const product = await makeProduct();
    await db.outbox.clear();
    return product;
  }

  beforeEach(async () => {
    await resetLocalDatabase();
    await saveShopSettings(SHOP_ID, { role: 'owner' });
  });

  it('sends edits and archives through their functions and stores the server rows', async () => {
    const product = await syncedProduct();
    await updateProduct(product.id, { barcode: '6001087361250', name: 'Simba 120g', category: 'snacks', sellingPrice: 16 }, SHOP_ID);
    await setProductArchived(product.id, true, SHOP_ID);

    const fake = createFakeSupabase({ rpc: productRpcs(product) });
    expect(await pushOutbox(fake.client, SHOP_ID)).toEqual({ pushed: 2, failed: 0, retryAt: null });
    expect(fake.rpc.mock.calls).toEqual([
      [
        'update_product',
        {
          p_shop_id: SHOP_ID,
          p_product_id: product.id,
          p_barcode: '6001087361250',
          p_name: 'Simba 120g',
          p_category: 'snacks',
          p_buying_price: null,
          p_selling_price: 16,
        },
      ],
      ['set_product_archived', { p_shop_id: SHOP_ID, p_product_id: product.id, p_archived: true }],
    ]);
    expect(await db.products.get(product.id)).toMatchObject({ archivedAt: SERVER_TIME, updatedAt: SERVER_TIME });
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps a later local edit on screen while an earlier one is confirmed', async () => {
    const product = await syncedProduct();
    await updateProduct(product.id, { ...product, name: 'First' }, SHOP_ID);
    await updateProduct(product.id, { ...product, name: 'Second' }, SHOP_ID);
    const fake = createFakeSupabase({
      rpc: (name, args) => (fake.rpc.mock.calls.length > 1 ? { data: null, error: { message: 'offline' } } : productRpcs(product)(name, args)),
    });

    await pushOutbox(fake.client, SHOP_ID);
    expect((await db.products.get(product.id))?.name).toBe('Second');
    expect(await db.outbox.count()).toBe(1);
  });

  it('puts the server copy back when the server refuses an edit', async () => {
    const product = await syncedProduct();
    await updateProduct(product.id, { ...product, barcode: '9999999999994', name: 'Local only' }, SHOP_ID);
    const fake = createFakeSupabase({
      rpc: () => ({ data: null, error: { code: '23505', message: 'Another product in this shop already uses barcode 9999999999994.' } }),
      rows: { products: [productRow(product, { name: 'Server name', updated_at: SERVER_TIME })] },
    });

    const result = await pushOutbox(fake.client, SHOP_ID);
    expect(result.failed).toBe(1);
    expect(await db.products.get(product.id)).toMatchObject({ name: 'Server name', barcode: product.barcode });
    expect((await db.outbox.toArray())[0]).toMatchObject({ type: 'product_update', status: 'failed' });
  });

  it('rewrites queued edits when the product is remapped to the server product', async () => {
    const product = await makeProduct();
    await setProductArchived(product.id, true, SHOP_ID);
    const canonicalId = '33333333-3333-4333-8333-333333333333';
    const fake = createFakeSupabase({
      rpc: (name, args) => {
        if (name === 'upsert_product') return { data: productRow(product, { id: canonicalId }), error: null };
        return productRpcs({ ...product, id: canonicalId })(name, args);
      },
    });

    expect((await pushOutbox(fake.client, SHOP_ID)).pushed).toBe(2);
    expect(fake.rpc.mock.calls[1]).toEqual([
      'set_product_archived',
      { p_shop_id: SHOP_ID, p_product_id: canonicalId, p_archived: true },
    ]);
    expect((await db.products.get(canonicalId))?.archivedAt).toBe(SERVER_TIME);
  });

  it('does not pull over an edit that is still waiting to be pushed', async () => {
    const product = await syncedProduct();
    await updateProduct(product.id, { ...product, name: 'Local edit' }, SHOP_ID);
    const fake = createFakeSupabase({
      rows: { products: [productRow(product, { name: 'Old server name', updated_at: SERVER_TIME })] },
    });
    expect(await pullChanges(fake.client, SHOP_ID)).toBe(0);
    expect((await db.products.get(product.id))?.name).toBe('Local edit');
  });

  it('pulls archive state from other phones', async () => {
    const product = await syncedProduct();
    const fake = createFakeSupabase({
      rows: { products: [productRow(product, { archived_at: SERVER_TIME, updated_at: SERVER_TIME })] },
    });
    await pullChanges(fake.client, SHOP_ID);
    expect((await db.products.get(product.id))?.archivedAt).toBe(SERVER_TIME);
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
        sale_items: [
          {
            id: 'line-1',
            shop_id: SHOP_ID,
            product_id: product.id,
            quantity: 3,
            unit_price: '15.00',
            line_total: '45.00',
            allocations: [{ batchId: batch.id, quantityDeducted: 3, batchExpiryDate: null }],
            voided_quantity: 1,
            updated_at: '2026-10-14T08:05:00Z',
            sales: { sold_at: '2026-10-14T08:04:00Z', idempotency_key: 'other-phone-1' },
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
    expect(applied).toBe(4);
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(7);
    expect(await db.sales.get('line-1')).toMatchObject({
      productId: product.id,
      quantity: 3,
      totalAmount: 45,
      voidedQuantity: 1,
      idempotencyKey: 'other-phone-1',
      createdAt: '2026-10-14T08:04:00.000Z',
    });
    expect((await db.products.get(product.id))?.name).toBe('Simba Chips 120g');
    expect(await db.discrepancies.count()).toBe(1);
    expect(await getMeta(`pull:${SHOP_ID}:stock_batches`)).toBe('2026-10-14T08:05:00.000Z');
  });

  it('pulls server expiry alerts so they show and dedupe on this phone', async () => {
    const product = await makeProduct();
    const { result } = await stockIn({ productId: product.id, quantity: 5, expiryDate: '2026-10-20' }, SHOP_ID);
    await db.outbox.clear();
    const batchId = result!.batch.id;
    const fake = createFakeSupabase({
      rows: {
        expiry_alerts: [
          {
            id: 'a1',
            shop_id: SHOP_ID,
            batch_id: batchId,
            product_id: product.id,
            kind: 'reminder',
            threshold_days: 7,
            expiry_date: '2026-10-20',
            quantity: 5,
            alert_date: '2026-10-14',
            resolved_at: null,
            resolution: null,
            created_at: '2026-10-14T05:00:00Z',
            updated_at: '2026-10-14T05:00:00Z',
          },
        ],
      },
    });

    expect(await pullChanges(fake.client, SHOP_ID)).toBe(1);
    expect(await db.expiryAlerts.get('a1')).toMatchObject({
      batchId,
      kind: 'reminder',
      thresholdDays: 7,
      expiryDate: '2026-10-20',
      resolvedAt: null,
    });
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

describe('packagings and barcode links', () => {
  const SERVER_TIME = '2026-10-15T09:00:00.000Z';

  /** Answers the packaging and link functions like the real ones. */
  function linkRpcs(name: string, args: Record<string, unknown>) {
    if (name === 'create_product_packaging') {
      return {
        data: {
          id: args.p_id,
          shop_id: args.p_shop_id,
          product_id: args.p_product_id,
          name: args.p_name,
          units_per_package: args.p_units_per_package,
          created_at: args.p_created_at,
          updated_at: SERVER_TIME,
          retired_at: null,
        },
        error: null,
      };
    }
    if (name === 'link_product_barcode') {
      return {
        data: {
          id: args.p_id,
          shop_id: args.p_shop_id,
          product_id: args.p_product_id,
          packaging_id: args.p_packaging_id,
          barcode: args.p_barcode,
          created_at: args.p_created_at,
          updated_at: SERVER_TIME,
          unlinked_at: null,
          unlink_reason: null,
        },
        error: null,
      };
    }
    return acceptAll(name, args);
  }

  async function caseDelivery() {
    const product = await makeProduct();
    const { packaging } = await createPackaging({ productId: product.id, name: 'Case', unitsPerPackage: 24 }, SHOP_ID);
    const { link } = await linkBarcode(
      { productId: product.id, packagingId: packaging!.id, barcode: '16001087361257' },
      SHOP_ID
    );
    const { result } = await stockIn(
      { productId: product.id, quantity: 2, packagingId: packaging!.id, barcodeId: link!.id, idempotencyKey: 'case-1' },
      SHOP_ID
    );
    return { product, packaging: packaging!, link: link!, batch: result!.batch };
  }

  beforeEach(async () => {
    await resetLocalDatabase();
    await saveShopSettings(SHOP_ID, { role: 'owner' });
  });

  it('pushes the packaging, the link and the package delivery in order', async () => {
    const { product, packaging, link, batch } = await caseDelivery();
    const fake = createFakeSupabase({ rpc: linkRpcs });

    expect(await pushOutbox(fake.client, SHOP_ID)).toEqual({ pushed: 4, failed: 0, retryAt: null });
    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual([
      'upsert_product',
      'create_product_packaging',
      'link_product_barcode',
      'record_stock_in',
    ]);
    expect(fake.rpc.mock.calls[2][1]).toMatchObject({
      p_id: link.id,
      p_product_id: product.id,
      p_packaging_id: packaging.id,
      p_barcode: '16001087361257',
    });
    expect(fake.rpc.mock.calls[3][1]).toMatchObject({
      p_batch_id: batch.id,
      p_quantity: 48,
      p_packaging_id: packaging.id,
      p_package_quantity: 2,
      p_barcode_id: link.id,
      p_idempotency_key: 'case-1',
    });
    expect(await db.barcodes.get(link.id)).toMatchObject({ updatedAt: SERVER_TIME });
  });

  it('leaves the packaging parameters out of an ordinary delivery', async () => {
    const product = await makeProduct();
    await db.outbox.clear();
    await stockIn({ productId: product.id, quantity: 3 }, SHOP_ID);
    await updateProduct(product.id, { barcode: product.barcode, name: 'Simba', category: 'snacks' }, SHOP_ID);
    const fake = createFakeSupabase({ rpc: acceptAll });
    await pushOutbox(fake.client, SHOP_ID);

    const stockArgs = fake.rpc.mock.calls.find(([name]) => name === 'record_stock_in')![1];
    expect(Object.keys(stockArgs).filter((k) => /packag|barcode_id/.test(k))).toEqual([]);
    const editArgs = fake.rpc.mock.calls.find(([name]) => name === 'update_product')![1];
    expect(editArgs).not.toHaveProperty('p_brand');
  });

  it('remaps queued packagings and links when the product is remapped', async () => {
    const { product, packaging, link } = await caseDelivery();
    const canonicalId = '33333333-3333-4333-8333-333333333333';
    const fake = createFakeSupabase({
      rpc: (name, args) =>
        name === 'upsert_product'
          ? { data: productRow(product, { id: canonicalId }), error: null }
          : linkRpcs(name, args),
    });

    expect((await pushOutbox(fake.client, SHOP_ID)).pushed).toBe(4);
    for (const call of fake.rpc.mock.calls.slice(1)) {
      expect(call[1]).toMatchObject({ p_product_id: canonicalId });
    }
    expect((await db.packagings.get(packaging.id))?.productId).toBe(canonicalId);
    expect((await db.barcodes.get(link.id))?.productId).toBe(canonicalId);
    expect((await resolveBarcode('16001087361257', SHOP_ID))?.product.id).toBe(canonicalId);
  });

  it('sends a retried delivery with the same ids, so stock is added once', async () => {
    const { batch } = await caseDelivery();
    let failStockIn = true;
    const fake = createFakeSupabase({
      rpc: (name, args) => {
        if (name === 'record_stock_in' && failStockIn) {
          failStockIn = false;
          throw new TypeError('Failed to fetch');
        }
        return linkRpcs(name, args);
      },
    });

    await pushOutbox(fake.client, SHOP_ID, 0);
    await pushOutbox(fake.client, SHOP_ID, 60_000);
    const stockCalls = fake.rpc.mock.calls.filter(([name]) => name === 'record_stock_in').map(([, args]) => args);
    expect(stockCalls).toHaveLength(2);
    expect(stockCalls[1]).toEqual(stockCalls[0]);
    expect(stockCalls[0]).toMatchObject({ p_batch_id: batch.id, p_idempotency_key: 'case-1' });
    expect(await db.outbox.count()).toBe(0);
    expect(await getProductTotalStock(batch.productId, SHOP_ID)).toBe(48);
  });

  it('drops only the link when the server refuses it, and keeps the delivery', async () => {
    const { product, link, batch } = await caseDelivery();
    const fake = createFakeSupabase({
      rpc: (name, args) =>
        name === 'link_product_barcode'
          ? { data: null, error: { code: '23505', message: 'Barcode 16001087361257 is already used by Coke.' } }
          : linkRpcs(name, args),
    });

    const result = await pushOutbox(fake.client, SHOP_ID);
    expect(result).toMatchObject({ pushed: 3, failed: 1 });
    expect(await db.barcodes.get(link.id)).toBeUndefined();
    expect(await resolveBarcode('16001087361257', SHOP_ID)).toBeNull();
    expect((await db.batches.get(batch.id))?.receivedBarcodeId).toBeNull();
    const stockArgs = fake.rpc.mock.calls.find(([name]) => name === 'record_stock_in')![1];
    expect(stockArgs).not.toHaveProperty('p_barcode_id');
    expect(stockArgs).toMatchObject({ p_quantity: 48 });
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(48);
  });

  it('keeps the units when the packaging never reached the server', async () => {
    const { product, batch } = await caseDelivery();
    const fake = createFakeSupabase({
      rpc: (name, args) => {
        if (name === 'create_product_packaging') return { data: null, error: { code: '42501', message: 'denied' } };
        if (name === 'record_stock_in' && args.p_packaging_id) {
          return { data: null, error: { code: 'P0002', message: 'Packaging not found for this product.' } };
        }
        return linkRpcs(name, args);
      },
    });

    await pushOutbox(fake.client, SHOP_ID);
    const stockCalls = fake.rpc.mock.calls.filter(([name]) => name === 'record_stock_in').map(([, args]) => args);
    expect(stockCalls.at(-1)).toMatchObject({ p_batch_id: batch.id, p_quantity: 48 });
    expect(stockCalls.at(-1)).not.toHaveProperty('p_packaging_id');
    expect(await db.batches.get(batch.id)).toMatchObject({ quantity: 48, packagingId: null });
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(48);
  });

  it('applies what the server reversed when a link is undone', async () => {
    const { link, batch } = await caseDelivery();
    await pushOutbox(createFakeSupabase({ rpc: linkRpcs }).client, SHOP_ID);
    await unlinkBarcode({ barcodeId: link.id, reason: 'Wrong product', reverseUnsold: true }, SHOP_ID);
    expect((await db.batches.get(batch.id))?.quantity).toBe(0);

    // Another phone sold 2 from the delivery first, so the server kept it.
    const fake = createFakeSupabase({
      rpc: (name) =>
        name === 'unlink_product_barcode'
          ? {
              data: {
                barcode: {
                  ...linkRpcs('link_product_barcode', {
                    p_id: link.id,
                    p_shop_id: SHOP_ID,
                    p_product_id: link.productId,
                    p_packaging_id: link.packagingId,
                    p_barcode: link.barcode,
                    p_created_at: link.createdAt,
                  }).data,
                  unlinked_at: SERVER_TIME,
                  unlink_reason: 'Wrong product',
                },
                reversed: [],
                kept: [{ batch_id: batch.id, quantity: 46, initial_quantity: 48 }],
              },
              error: null,
            }
          : { data: {}, error: null },
    });
    await pushOutbox(fake.client, SHOP_ID);
    expect(fake.rpc.mock.calls[0]).toEqual([
      'unlink_product_barcode',
      {
        p_shop_id: SHOP_ID,
        p_barcode_id: link.id,
        p_reason: 'Wrong product',
        p_reverse_unsold: true,
        p_occurred_at: expect.any(String),
      },
    ]);
    expect((await db.batches.get(batch.id))?.quantity).toBe(46);
    expect(await db.barcodes.get(link.id)).toMatchObject({ unlinkedAt: SERVER_TIME, unlinkReason: 'Wrong product' });
  });

  it('pulls packagings and links made on other phones', async () => {
    const product = await makeProduct();
    await db.outbox.clear();
    const fake = createFakeSupabase({
      rows: {
        product_packagings: [
          {
            id: 'p-case',
            shop_id: SHOP_ID,
            product_id: product.id,
            name: 'Case',
            units_per_package: 24,
            created_at: SERVER_TIME,
            updated_at: SERVER_TIME,
            retired_at: null,
          },
        ],
        product_barcodes: [
          {
            id: 'b-case',
            shop_id: SHOP_ID,
            product_id: product.id,
            packaging_id: 'p-case',
            barcode: '16001087361257',
            created_at: SERVER_TIME,
            updated_at: SERVER_TIME,
            unlinked_at: null,
            unlink_reason: null,
          },
        ],
      },
    });

    expect(await pullChanges(fake.client, SHOP_ID)).toBe(2);
    const resolved = await resolveBarcode('16001087361257', SHOP_ID);
    expect(resolved).toMatchObject({ product: { id: product.id }, packaging: { unitsPerPackage: 24 }, barcodeId: 'b-case' });
  });
});

describe('product pictures', () => {
  const SERVER_TIME = '2026-10-15T09:00:00.000Z';
  const picture = { bytes: new Uint8Array([1, 2, 3, 4]).buffer, mimeType: 'image/webp' as const };
  const otherPicture = { bytes: new Uint8Array([9, 8, 7, 6]).buffer, mimeType: 'image/webp' as const };

  /** Answers set_product_image like the real function, reporting `previous` as the old path. */
  function imageRpcs(product: Product, previous: string | null = null) {
    return (name: string, args: Record<string, unknown>) => {
      if (name === 'set_product_image') {
        return {
          data: {
            product: productRow(product, { image_path: args.p_image_path, updated_at: SERVER_TIME }),
            previous_path: previous,
          },
          error: null,
        };
      }
      return acceptAll(name, args);
    };
  }

  beforeEach(async () => {
    await resetLocalDatabase();
    await saveShopSettings(SHOP_ID, { role: 'owner' });
  });

  it('uploads a new product and its picture in order, then marks the picture as uploaded', async () => {
    const product = await makeProduct();
    const { product: withImage } = await saveProductImage(product.id, SHOP_ID, picture);
    const path = withImage!.imagePath!;

    const fake = createFakeSupabase({ rpc: imageRpcs(product) });
    expect(await pushOutbox(fake.client, SHOP_ID)).toEqual({ pushed: 2, failed: 0, retryAt: null });

    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual(['upsert_product', 'set_product_image']);
    expect(fake.upload).toHaveBeenCalledTimes(1);
    expect(fake.upload.mock.calls[0][0]).toBe(path);
    expect(fake.upload.mock.calls[0][2]).toMatchObject({ contentType: 'image/webp', upsert: false });
    expect(fake.storage.from).toHaveBeenCalledWith('product-images');
    expect(fake.rpc.mock.calls[1][1]).toEqual({ p_shop_id: SHOP_ID, p_product_id: product.id, p_image_path: path });

    expect(await db.products.get(product.id)).toMatchObject({ imagePath: path, updatedAt: SERVER_TIME });
    expect((await db.productImages.get(path))?.pending).toBe(false);
  });

  it('treats an upload that already happened as done', async () => {
    const product = await makeProduct();
    await saveProductImage(product.id, SHOP_ID, picture);
    const fake = createFakeSupabase({
      rpc: imageRpcs(product),
      upload: () => ({ data: null, error: { message: 'The resource already exists', statusCode: '409', status: 400 } }),
    });
    expect((await pushOutbox(fake.client, SHOP_ID)).pushed).toBe(2);
    expect(fake.rpc).toHaveBeenCalledWith('set_product_image', expect.anything());
  });

  it('deletes the replaced picture from storage', async () => {
    const product = await makeProduct();
    await db.outbox.clear();
    const old = `${SHOP_ID}/${'c'.repeat(32)}.webp`;
    await db.products.update(product.id, { imagePath: old });
    await saveProductImage(product.id, SHOP_ID, otherPicture);

    const fake = createFakeSupabase({ rpc: imageRpcs(product, old) });
    expect((await pushOutbox(fake.client, SHOP_ID)).pushed).toBe(1);
    expect(fake.remove).toHaveBeenCalledWith([old]);
  });

  it('still succeeds when cleaning up the old picture fails', async () => {
    const product = await makeProduct();
    await db.outbox.clear();
    await db.products.update(product.id, { imagePath: `${SHOP_ID}/${'d'.repeat(32)}.webp` });
    await removeProductImage(product.id, SHOP_ID);

    const fake = createFakeSupabase({
      rpc: imageRpcs(product, `${SHOP_ID}/${'d'.repeat(32)}.webp`),
      remove: () => {
        throw new Error('offline');
      },
    });
    expect(await pushOutbox(fake.client, SHOP_ID)).toEqual({ pushed: 1, failed: 0, retryAt: null });
    expect(fake.upload).not.toHaveBeenCalled();
    expect(fake.rpc.mock.calls[0][1]).toMatchObject({ p_image_path: null });
  });

  it('fails for good when storage refuses the picture and the server confirms the refusal', async () => {
    const product = await makeProduct();
    await db.outbox.clear();
    await saveProductImage(product.id, SHOP_ID, picture);
    const fake = createFakeSupabase({
      upload: () => ({ data: null, error: { message: 'new row violates row-level security policy', statusCode: '403' } }),
      rpc: () => ({ data: null, error: { code: '42501', message: 'You do not have access to this shop.' } }),
      rows: { products: [productRow(product, { image_path: null, updated_at: SERVER_TIME })] },
    });

    const result = await pushOutbox(fake.client, SHOP_ID);
    expect(result.failed).toBe(1);
    expect((await db.outbox.toArray())[0]).toMatchObject({ type: 'product_image', status: 'failed' });
    expect((await db.products.get(product.id))?.imagePath).toBeNull();
  });

  it('holds the picture back while the shop is suspended', async () => {
    const product = await makeProduct();
    await db.outbox.clear();
    await saveProductImage(product.id, SHOP_ID, picture);
    const fake = createFakeSupabase({
      upload: () => ({ data: null, error: { message: 'new row violates row-level security policy', statusCode: '403' } }),
      rpc: () => ({ data: null, error: { code: 'SP001', message: 'This shop is suspended.' } }),
    });
    const result = await pushOutbox(fake.client, SHOP_ID);
    expect(result.blocked).toBe('suspended');
    expect((await db.outbox.toArray())[0]).toMatchObject({ type: 'product_image', status: 'pending' });
  });

  it('retries when the upload fails because of the network', async () => {
    const product = await makeProduct();
    await db.outbox.clear();
    await saveProductImage(product.id, SHOP_ID, picture);
    const fake = createFakeSupabase({ upload: () => ({ data: null, error: { message: 'Failed to fetch' } }) });
    const result = await pushOutbox(fake.client, SHOP_ID);
    expect(result).toMatchObject({ pushed: 0, failed: 0 });
    expect(result.retryAt).not.toBeNull();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it('moves a queued picture to the server product when the product is remapped', async () => {
    const product = await makeProduct();
    await saveProductImage(product.id, SHOP_ID, picture);
    const canonicalId = '44444444-4444-4444-8444-444444444444';
    const fake = createFakeSupabase({
      rpc: (name, args) => {
        if (name === 'upsert_product') return { data: productRow(product, { id: canonicalId }), error: null };
        return imageRpcs({ ...product, id: canonicalId })(name, args);
      },
    });
    expect((await pushOutbox(fake.client, SHOP_ID)).pushed).toBe(2);
    expect(fake.rpc.mock.calls[1][1]).toMatchObject({ p_product_id: canonicalId });
    expect((await db.products.get(canonicalId))?.imagePath).toMatch(/\.webp$/);
  });

  it('pulls pictures set on other phones and drops cached pictures nothing uses', async () => {
    const product = await makeProduct();
    await db.outbox.clear();
    const stale = `${SHOP_ID}/${'e'.repeat(32)}.webp`;
    await db.productImages.put({ path: stale, shopId: SHOP_ID, bytes: new ArrayBuffer(2), mimeType: 'image/webp', pending: false, cachedAt: SERVER_TIME });
    const fresh = `${SHOP_ID}/${'f'.repeat(32)}.webp`;
    const fake = createFakeSupabase({
      rows: { products: [productRow(product, { image_path: fresh, updated_at: SERVER_TIME })] },
    });

    expect(await pullChanges(fake.client, SHOP_ID)).toBe(1);
    expect((await db.products.get(product.id))?.imagePath).toBe(fresh);
    expect(await db.productImages.get(stale)).toBeUndefined();
  });
});
