import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordSale, getTodaySales, getSales, sortBatchesByFEFO } from '../services/salesService';
import { stockIn, getProductTotalStock, getProductBatches } from '../services/stockService';
import { createProduct } from '../services/productService';
import { db, resetLocalDatabase } from '../lib/db';
import type { Product, StockBatch } from '../types';
import { SHOP_ID, setOnline } from './helpers';

async function makeStockedProduct(): Promise<Product> {
  const { product } = await createProduct(
    { barcode: '5449000000996', name: 'Coke 330ml', category: 'beverages', sellingPrice: 12.5 },
    SHOP_ID
  );
  await stockIn({ productId: product!.id, quantity: 3, expiryDate: '2026-12-01' }, SHOP_ID);
  await stockIn({ productId: product!.id, quantity: 5, expiryDate: '2026-11-01' }, SHOP_ID);
  await stockIn({ productId: product!.id, quantity: 4, expiryDate: null }, SHOP_ID);
  return product!;
}

describe('salesService', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
    setOnline(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
  });

  it('sorts batches first-expired-first-out with undated batches last', () => {
    const batch = (id: string, expiryDate: string | null, receivedAt: string): StockBatch => ({
      id,
      shopId: SHOP_ID,
      productId: 'p',
      quantity: 1,
      initialQuantity: 1,
      expiryDate,
      receivedAt,
    });
    const sorted = sortBatchesByFEFO([
      batch('undated', null, '2026-01-01'),
      batch('late', '2026-12-01', '2026-01-01'),
      batch('early-new', '2026-11-01', '2026-02-01'),
      batch('early-old', '2026-11-01', '2026-01-15'),
    ]);
    expect(sorted.map((b) => b.id)).toEqual(['early-old', 'early-new', 'late', 'undated']);
  });

  it('deducts across batches in FEFO order and queues the sale', async () => {
    const product = await makeStockedProduct();
    const { result } = await recordSale({ productId: product.id, quantity: 7 }, SHOP_ID);

    expect(result?.previousTotalStock).toBe(12);
    expect(result?.remainingTotalStock).toBe(5);
    expect(result?.allocations.map((a) => [a.batchExpiryDate, a.quantityDeducted])).toEqual([
      ['2026-11-01', 5],
      ['2026-12-01', 2],
    ]);
    expect(result?.sale.totalAmount).toBe(87.5);

    const remaining = await getProductBatches(product.id, SHOP_ID);
    expect(remaining.map((b) => [b.expiryDate, b.quantity]).sort()).toEqual([
      ['2026-12-01', 1],
      [null, 4],
    ].sort());

    const last = await db.outbox.orderBy('seq').last();
    expect(last).toMatchObject({ type: 'sale', payload: { sale: { id: result!.sale.id } } });
  });

  it('never oversells and reports how many units are available', async () => {
    const product = await makeStockedProduct();
    const outcome = await recordSale({ productId: product.id, quantity: 13 }, SHOP_ID);
    expect(outcome.errorCode).toBe('insufficient_stock');
    expect(outcome.available).toBe(12);
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(12);
    expect(await db.sales.count()).toBe(0);
  });

  it('rejects a replayed idempotency key but not one whose first attempt failed', async () => {
    const product = await makeStockedProduct();

    const failed = await recordSale({ productId: product.id, quantity: 100, idempotencyKey: 'k1' }, SHOP_ID);
    expect(failed.errorCode).toBe('insufficient_stock');
    const retried = await recordSale({ productId: product.id, quantity: 1, idempotencyKey: 'k1' }, SHOP_ID);
    expect(retried.result).toBeDefined();

    db.close();
    await db.open();
    const replay = await recordSale({ productId: product.id, quantity: 1, idempotencyKey: 'k1' }, SHOP_ID);
    expect(replay.errorCode).toBe('duplicate');
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(11);
  });

  it('serialises concurrent sales of the last units', async () => {
    const product = await makeStockedProduct();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => recordSale({ productId: product.id, quantity: 3 }, SHOP_ID))
    );
    expect(outcomes.filter((o) => o.result)).toHaveLength(4);
    expect(outcomes.filter((o) => o.errorCode === 'insufficient_stock')).toHaveLength(1);
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(0);
  });

  it('flags sales made offline and still queues them', async () => {
    const product = await makeStockedProduct();
    setOnline(false);
    const { result } = await recordSale({ productId: product.id, quantity: 1 }, SHOP_ID);
    expect(result?.isQueuedOffline).toBe(true);
    expect((await db.outbox.toArray()).filter((item) => item.type === 'sale')).toHaveLength(1);
  });

  it('validates quantity and price', async () => {
    const product = await makeStockedProduct();
    expect((await recordSale({ productId: product.id, quantity: 0 }, SHOP_ID)).errorCode).toBe('invalid_quantity');
    expect((await recordSale({ productId: product.id, quantity: 1.5 }, SHOP_ID)).errorCode).toBe('invalid_quantity');
    expect((await recordSale({ productId: product.id, quantity: 1, unitPrice: -1 }, SHOP_ID)).errorCode).toBe('invalid_price');
    expect((await recordSale({ productId: 'missing', quantity: 1 }, SHOP_ID)).errorCode).toBe('not_found');
  });

  it("counts a sale just after local midnight in today's total", async () => {
    const product = await makeStockedProduct();
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date('2026-10-13T23:50:00+02:00'));
    await recordSale({ productId: product.id, quantity: 1 }, SHOP_ID);
    vi.setSystemTime(new Date('2026-10-14T00:30:00+02:00'));
    await recordSale({ productId: product.id, quantity: 2 }, SHOP_ID);

    const today = await getTodaySales(SHOP_ID, new Date('2026-10-14T09:00:00+02:00'));
    expect(today.map((s) => s.quantity)).toEqual([2]);
    expect(await getSales(SHOP_ID)).toHaveLength(2);
  });
});
