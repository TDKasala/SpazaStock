import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  stockIn,
  getProductTotalStock,
  getProductBatches,
  getAllProductsStockSummary,
  getExpiryAlerts,
  getOpenDiscrepancies,
  resolveDiscrepancy,
} from '../services/stockService';
import { createProduct } from '../services/productService';
import { db, resetLocalDatabase } from '../lib/db';
import { addDaysLocal } from '../lib/dates';
import type { Product } from '../types';
import { SHOP_ID, OTHER_SHOP_ID } from './helpers';

async function makeProduct(barcode = '6001007300123'): Promise<Product> {
  const { product } = await createProduct({ barcode, name: 'Bread', category: 'bakery', sellingPrice: 20 }, SHOP_ID);
  return product!;
}

describe('stockService', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds each delivery as its own batch and queues it for sync', async () => {
    const product = await makeProduct();
    const first = await stockIn({ productId: product.id, quantity: 10, expiryDate: '2026-11-01' }, SHOP_ID);
    const second = await stockIn({ productId: product.id, quantity: 5, expiryDate: '2026-12-01' }, SHOP_ID);

    expect(first.result?.resultingTotalQuantity).toBe(10);
    expect(second.result?.previousTotalQuantity).toBe(10);
    expect(second.result?.resultingTotalQuantity).toBe(15);
    expect(second.result?.batch.initialQuantity).toBe(5);
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(15);
    expect(await getProductBatches(product.id, SHOP_ID)).toHaveLength(2);

    const ops = (await db.outbox.orderBy('seq').toArray()).map((i) => i.type);
    expect(ops).toEqual(['product_upsert', 'stock_in', 'stock_in']);
  });

  it('rejects a repeated idempotency key, even after a reload', async () => {
    const product = await makeProduct();
    await stockIn({ productId: product.id, quantity: 10, idempotencyKey: 'delivery-1' }, SHOP_ID);
    db.close();
    await db.open();
    const again = await stockIn({ productId: product.id, quantity: 10, idempotencyKey: 'delivery-1' }, SHOP_ID);
    expect(again.error).toMatch(/Duplicate/);
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(10);
  });

  it('validates quantity, date and cost', async () => {
    const product = await makeProduct();
    for (const quantity of [0, -3, 1.5, Number.NaN]) {
      expect((await stockIn({ productId: product.id, quantity }, SHOP_ID)).error).toBeTruthy();
    }
    expect((await stockIn({ productId: product.id, quantity: 1, expiryDate: '2026-02-30' }, SHOP_ID)).error).toBeTruthy();
    expect((await stockIn({ productId: product.id, quantity: 1, costPricePerUnit: -1 }, SHOP_ID)).error).toBeTruthy();
    expect(await db.batches.count()).toBe(0);
  });

  it("refuses to stock another shop's product", async () => {
    const product = await makeProduct();
    const result = await stockIn({ productId: product.id, quantity: 3 }, OTHER_SHOP_ID);
    expect(result.error).toMatch(/not found/);
  });

  it('summarises stock and flags expiry from the local date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T00:30:00+02:00'));

    const product = await makeProduct();
    await stockIn({ productId: product.id, quantity: 4, expiryDate: addDaysLocal(3) }, SHOP_ID);
    await stockIn({ productId: product.id, quantity: 6, expiryDate: addDaysLocal(20) }, SHOP_ID);
    await stockIn({ productId: product.id, quantity: 2, expiryDate: addDaysLocal(-1) }, SHOP_ID);

    const [summary] = await getAllProductsStockSummary(SHOP_ID);
    expect(summary.totalQuantity).toBe(10);
    expect(summary.expiredQuantity).toBe(2);
    expect(summary.earliestExpiry).toBe('2026-10-13');
    expect(summary.isExpired).toBe(true);
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(10);

    const alerts = await getExpiryAlerts(SHOP_ID);
    expect(alerts.map((a) => [a.daysUntilExpiry, a.status, a.kind, a.thresholdDays])).toEqual([
      [-1, 'expired', 'expired', null],
      [3, 'urgent', 'reminder', 7],
      [20, 'warning', 'reminder', 21],
    ]);
  });

  it('lists and resolves discrepancies, queueing the resolution', async () => {
    const product = await makeProduct();
    await db.discrepancies.add({
      id: 'd1',
      shopId: SHOP_ID,
      productId: product.id,
      saleId: null,
      shortfall: 2,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
    });

    expect(await getOpenDiscrepancies(SHOP_ID)).toHaveLength(1);
    await resolveDiscrepancy('d1', SHOP_ID);
    expect(await getOpenDiscrepancies(SHOP_ID)).toHaveLength(0);

    const last = await db.outbox.orderBy('seq').last();
    expect(last).toMatchObject({ type: 'discrepancy_resolve', payload: { id: 'd1' } });
  });
});
