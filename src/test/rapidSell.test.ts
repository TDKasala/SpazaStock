import { describe, it, expect, beforeEach } from 'vitest';
import { createScanSeller, type ScanSellOutcome } from '../services/scanSell';
import {
  getPendingSaleIds,
  planVoidReturns,
  recordSale,
  saleNetAmount,
  saleNetQuantity,
  voidSale,
} from '../services/salesService';
import { createProduct, setProductArchived } from '../services/productService';
import { getProductBatches, getProductTotalStock, stockIn } from '../services/stockService';
import { db, resetLocalDatabase } from '../lib/db';
import type { Product } from '../types';
import { SHOP_ID, setOnline } from './helpers';

const BARCODE = '6001007300123';

async function makeProduct(stock: Array<{ quantity: number; expiryDate: string | null }>): Promise<Product> {
  const { product } = await createProduct(
    { barcode: BARCODE, name: 'Albany White Bread', category: 'bakery', sellingPrice: 18.5 },
    SHOP_ID
  );
  for (const delivery of stock) await stockIn({ productId: product!.id, ...delivery }, SHOP_ID);
  return product!;
}

/** Batches and movements must always agree: every stock change is in the movement trail. */
async function expectLedgerConsistent(productId: string): Promise<number> {
  const batches = await getProductBatches(productId, SHOP_ID);
  const movements = await db.movements.where('productId').equals(productId).toArray();
  const stock = batches.reduce((sum, b) => sum + b.quantity, 0);
  expect(batches.every((b) => b.quantity >= 0)).toBe(true);
  expect(movements.reduce((sum, m) => sum + m.quantityDelta, 0)).toBe(stock);
  return stock;
}

function kinds(outcomes: ScanSellOutcome[]): Record<string, number> {
  return outcomes.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o.kind]: (acc[o.kind] ?? 0) + 1 }), {});
}

describe('rapid scan-to-sell', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
    setOnline(true);
  });

  it('deducts one unit per scan and reports the stock left', async () => {
    const product = await makeProduct([{ quantity: 5, expiryDate: '2026-11-01' }]);
    const seller = createScanSeller(SHOP_ID);

    const first = await seller.scan(BARCODE);
    const second = await seller.scan(BARCODE);
    expect(first).toMatchObject({ kind: 'sold', result: { remainingTotalStock: 4, sale: { quantity: 1 } } });
    expect(second).toMatchObject({ kind: 'sold', result: { remainingTotalStock: 3 } });
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(3);
  });

  it('takes from the earliest-expiring batch first', async () => {
    const product = await makeProduct([
      { quantity: 2, expiryDate: '2026-12-01' },
      { quantity: 1, expiryDate: '2026-11-01' },
      { quantity: 2, expiryDate: null },
    ]);
    const seller = createScanSeller(SHOP_ID);
    const expiries: Array<string | null> = [];
    for (let i = 0; i < 5; i++) {
      const outcome = await seller.scan(BARCODE);
      if (outcome.kind === 'sold') expiries.push(outcome.result.allocations[0].batchExpiryDate);
    }
    expect(expiries).toEqual(['2026-11-01', '2026-12-01', '2026-12-01', null, null]);
    expect(await expectLedgerConsistent(product.id)).toBe(0);
  });

  describe('concurrency', () => {
    it('never oversells when many scans of the last units arrive at once', async () => {
      const product = await makeProduct([{ quantity: 3, expiryDate: null }]);
      const seller = createScanSeller(SHOP_ID);

      const outcomes = await Promise.all(Array.from({ length: 10 }, () => seller.scan(BARCODE)));

      expect(kinds(outcomes)).toEqual({ sold: 3, insufficient_stock: 7 });
      const remaining = outcomes.flatMap((o) => (o.kind === 'sold' ? [o.result.remainingTotalStock] : []));
      expect(remaining).toEqual([2, 1, 0]);
      expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(0);
      expect(await db.sales.count()).toBe(3);
      expect(await expectLedgerConsistent(product.id)).toBe(0);
    });

    it('never oversells when two registers (separate queues) sell the same stock at once', async () => {
      const product = await makeProduct([{ quantity: 4, expiryDate: null }]);
      const tillA = createScanSeller(SHOP_ID);
      const tillB = createScanSeller(SHOP_ID);

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, (_, i) => (i % 2 ? tillA : tillB).sell(product, 1))
      );

      expect(kinds(outcomes)).toEqual({ sold: 4, insufficient_stock: 2 });
      expect(await expectLedgerConsistent(product.id)).toBe(0);
    });

    it('keeps the ledger consistent while sells and undos interleave', async () => {
      const product = await makeProduct([
        { quantity: 6, expiryDate: '2026-11-01' },
        { quantity: 6, expiryDate: '2026-12-01' },
      ]);
      const seller = createScanSeller(SHOP_ID);
      const sold = await Promise.all(Array.from({ length: 4 }, () => seller.sell(product, 2)));
      const saleIds = sold.flatMap((o) => (o.kind === 'sold' ? [o.result.sale.id] : []));

      await Promise.all([
        seller.void(saleIds[0], 1),
        seller.scan(BARCODE),
        seller.void(saleIds[1], 2),
        seller.sell(product, 3),
        seller.void(saleIds[0], 1),
      ]);

      // 12 - 8 sold + 4 undone - 1 - 3 = 4
      expect(await expectLedgerConsistent(product.id)).toBe(4);
    });

    it('records scans of different products in the order they were scanned', async () => {
      await makeProduct([{ quantity: 5, expiryDate: null }]);
      const { product: chips } = await createProduct(
        { barcode: '6001087361250', name: 'Simba Chips', category: 'snacks', sellingPrice: 15 },
        SHOP_ID
      );
      await stockIn({ productId: chips!.id, quantity: 5, expiryDate: null }, SHOP_ID);
      const seller = createScanSeller(SHOP_ID);

      const codes = [BARCODE, '6001087361250', '6001087361250', BARCODE];
      const outcomes = await Promise.all(codes.map((code) => seller.scan(code)));
      const names = outcomes.map((o) => (o.kind === 'sold' ? o.result.product.name : o.kind));
      expect(names).toEqual(['Albany White Bread', 'Simba Chips', 'Simba Chips', 'Albany White Bread']);

      const queuedProductIds = (await db.outbox.orderBy('seq').toArray()).flatMap((item) =>
        item.type === 'sale' ? [item.payload.sale.productId] : []
      );
      expect(queuedProductIds).toEqual(outcomes.map((o) => (o.kind === 'sold' ? o.result.product.id : '')));
    });
  });

  describe('duplicate scans and repeated submissions', () => {
    it('records one sale when the same scan is submitted again', async () => {
      const product = await makeProduct([{ quantity: 5, expiryDate: null }]);
      const seller = createScanSeller(SHOP_ID);

      const outcomes = await Promise.all([
        seller.scan(BARCODE, 'scan-1'),
        seller.scan(BARCODE, 'scan-1'),
        seller.scan(BARCODE, 'scan-1'),
      ]);

      expect(outcomes.map((o) => o.kind)).toEqual(['sold', 'duplicate', 'duplicate']);
      expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(4);
      expect(await db.sales.count()).toBe(1);
      expect((await db.outbox.toArray()).filter((i) => i.type === 'sale')).toHaveLength(1);
    });

    it('records one sale when a quantity is double-tapped with the same key', async () => {
      const product = await makeProduct([{ quantity: 10, expiryDate: null }]);
      const seller = createScanSeller(SHOP_ID);
      const [first, second] = await Promise.all([seller.sell(product, 4, 'qty-1'), seller.sell(product, 4, 'qty-1')]);
      expect([first.kind, second.kind]).toEqual(['sold', 'duplicate']);
      expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(6);
    });

    it('ignores a repeated undo', async () => {
      const product = await makeProduct([{ quantity: 5, expiryDate: null }]);
      const seller = createScanSeller(SHOP_ID);
      const sold = await seller.sell(product, 3);
      if (sold.kind !== 'sold') throw new Error('sale failed');

      const undos = await Promise.all([
        seller.void(sold.result.sale.id, 1, 'undo-1'),
        seller.void(sold.result.sale.id, 1, 'undo-1'),
      ]);
      expect(undos.map((o) => o.kind)).toEqual(['voided', 'duplicate']);
      expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(3);
      expect((await db.sales.get(sold.result.sale.id))?.voidedQuantity).toBe(1);
      expect((await db.outbox.toArray()).filter((i) => i.type === 'sale_void')).toHaveLength(1);
    });
  });

  describe('insufficient stock', () => {
    it('sells the last unit, then refuses the next scan without writing anything', async () => {
      const product = await makeProduct([{ quantity: 1, expiryDate: null }]);
      const seller = createScanSeller(SHOP_ID);

      expect(await seller.scan(BARCODE)).toMatchObject({ kind: 'sold', result: { remainingTotalStock: 0 } });
      const salesBefore = await db.sales.count();
      const movementsBefore = await db.movements.count();
      const outboxBefore = await db.outbox.count();

      expect(await seller.scan(BARCODE)).toMatchObject({ kind: 'insufficient_stock', available: 0 });
      expect(await db.sales.count()).toBe(salesBefore);
      expect(await db.movements.count()).toBe(movementsBefore);
      expect(await db.outbox.count()).toBe(outboxBefore);
      expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(0);
    });

    it('refuses a quantity larger than the stock and reports what is available', async () => {
      const product = await makeProduct([{ quantity: 3, expiryDate: null }]);
      const seller = createScanSeller(SHOP_ID);
      expect(await seller.sell(product, 5)).toMatchObject({ kind: 'insufficient_stock', available: 3 });
      expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(3);
    });

    it('sends unknown barcodes to registration instead of selling', async () => {
      await makeProduct([{ quantity: 3, expiryDate: null }]);
      const seller = createScanSeller(SHOP_ID);
      expect(await seller.scan('0000000000000')).toEqual({ kind: 'unknown_barcode', barcode: '0000000000000' });
      expect(await db.sales.count()).toBe(0);
    });

    it('refuses to sell an archived product and records nothing', async () => {
      const product = await makeProduct([{ quantity: 3, expiryDate: null }]);
      await setProductArchived(product.id, true, SHOP_ID);
      const seller = createScanSeller(SHOP_ID);
      expect(await seller.scan(BARCODE)).toMatchObject({ kind: 'archived', product: { id: product.id } });
      expect(await db.sales.count()).toBe(0);
      expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(3);
    });

    it('refuses to undo more than is left on the sale', async () => {
      const product = await makeProduct([{ quantity: 5, expiryDate: null }]);
      const seller = createScanSeller(SHOP_ID);
      const sold = await seller.sell(product, 2);
      if (sold.kind !== 'sold') throw new Error('sale failed');

      expect(await seller.void(sold.result.sale.id, 3)).toEqual({ kind: 'over_void', available: 2 });
      expect((await seller.void(sold.result.sale.id, 2)).kind).toBe('voided');
      expect(await seller.void(sold.result.sale.id, 1)).toEqual({ kind: 'over_void', available: 0 });
      expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(5);
    });
  });

  describe('movements', () => {
    it('writes one movement per batch a sale draws from', async () => {
      const product = await makeProduct([
        { quantity: 2, expiryDate: '2026-11-01' },
        { quantity: 5, expiryDate: '2026-12-01' },
      ]);
      const { result } = await recordSale({ productId: product.id, quantity: 4, idempotencyKey: 'k' }, SHOP_ID);
      const movements = (await db.movements.toArray())
        .filter((m) => m.type === 'sale')
        .sort((a, b) => b.resultingTotalQuantity - a.resultingTotalQuantity);

      expect(movements.map((m) => [m.quantityDelta, m.resultingTotalQuantity])).toEqual([
        [-2, 5],
        [-2, 3],
      ]);
      expect(movements.map((m) => m.idempotencyKey)).toEqual(
        result!.allocations.map((a) => `sale:k:${result!.sale.id}:${a.batchId}`)
      );
      expect(movements.every((m) => m.saleId === result!.sale.id)).toBe(true);
    });

    it('returns undone units to the batches they came from, last batch first', async () => {
      const product = await makeProduct([
        { quantity: 2, expiryDate: '2026-11-01' },
        { quantity: 5, expiryDate: '2026-12-01' },
      ]);
      const { result } = await recordSale({ productId: product.id, quantity: 4 }, SHOP_ID);
      const [early, late] = result!.allocations;

      const firstUndo = await voidSale({ saleId: result!.sale.id, quantity: 3 }, SHOP_ID);
      expect(firstUndo.result?.returns).toEqual([
        { batchId: late.batchId, quantity: 2 },
        { batchId: early.batchId, quantity: 1 },
      ]);
      expect(firstUndo.result?.remainingTotalStock).toBe(6);

      const batches = await getProductBatches(product.id, SHOP_ID);
      expect(batches.find((b) => b.id === early.batchId)?.quantity).toBe(1);
      expect(batches.find((b) => b.id === late.batchId)?.quantity).toBe(5);
      expect(await expectLedgerConsistent(product.id)).toBe(6);
    });
  });

  it('plans voids shortfall-first, then from the last allocation back', () => {
    const sale = {
      quantity: 6,
      allocations: [
        { batchId: 'a', quantityDeducted: 2, batchExpiryDate: null },
        { batchId: 'b', quantityDeducted: 2, batchExpiryDate: null },
      ],
    };
    // 2 of the 6 units were never in stock (oversold on another phone).
    expect(planVoidReturns(sale, 1)).toEqual([]);
    expect(planVoidReturns(sale, 3)).toEqual([{ batchId: 'b', quantity: 1 }]);
    expect(planVoidReturns({ ...sale, voidedQuantity: 3 }, 3)).toEqual([
      { batchId: 'b', quantity: 1 },
      { batchId: 'a', quantity: 2 },
    ]);
  });

  it('counts voided units out of the net quantity and amount', () => {
    const sale = { quantity: 4, unitPrice: 18.5, totalAmount: 74, voidedQuantity: 1 };
    expect(saleNetQuantity(sale)).toBe(3);
    expect(saleNetAmount(sale)).toBe(55.5);
    expect(saleNetAmount({ ...sale, voidedQuantity: 0 })).toBe(74);
  });

  it('queues offline sales and undos in order and shows them as waiting to sync', async () => {
    const product = await makeProduct([{ quantity: 5, expiryDate: null }]);
    await db.outbox.clear();
    setOnline(false);
    const seller = createScanSeller(SHOP_ID);

    const first = await seller.scan(BARCODE);
    const second = await seller.scan(BARCODE);
    if (first.kind !== 'sold' || second.kind !== 'sold') throw new Error('sale failed');
    expect(first.result.isQueuedOffline).toBe(true);
    await seller.void(first.result.sale.id, 1);

    const queued = await db.outbox.orderBy('seq').toArray();
    expect(queued.map((i) => i.type)).toEqual(['sale', 'sale', 'sale_void']);
    expect(queued[2].payload).toMatchObject({ saleId: first.result.sale.id, quantity: 1 });

    const states = await getPendingSaleIds(SHOP_ID);
    expect(states.get(first.result.sale.id)).toBe('pending');
    expect(states.get(second.result.sale.id)).toBe('pending');

    await db.outbox.update(queued[2].seq!, { status: 'failed' });
    expect((await getPendingSaleIds(SHOP_ID)).get(first.result.sale.id)).toBe('failed');
    expect(await getProductTotalStock(product.id, SHOP_ID)).toBe(4);
  });
});
