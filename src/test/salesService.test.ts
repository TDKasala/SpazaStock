import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSale,
  getSales,
  sortBatchesByFEFO,
  clearSalesData,
  getOfflineQueue,
} from '../services/salesService';
import { stockIn, clearStockData, getProductBatches, getProductTotalStock } from '../services/stockService';
import { createProduct, clearLocalProducts, DEFAULT_SHOP_ID } from '../services/productService';
import { Product } from '../types';

describe('Sales Service & Rapid Scan-to-Sell', () => {
  let testProduct: Product;
  const SHOP_ID = DEFAULT_SHOP_ID;

  beforeEach(async () => {
    clearLocalProducts(SHOP_ID);
    clearStockData(SHOP_ID);
    clearSalesData(SHOP_ID);

    // Register test product
    const res = await createProduct(
      {
        barcode: '6001007300123',
        name: 'Albany Superior White Bread 700g',
        category: 'bakery',
        buyingPrice: 15.0,
        sellingPrice: 18.5,
      },
      SHOP_ID
    );
    testProduct = res.product!;
  });

  describe('FEFO (Earliest Expiry First) Batch Deduction', () => {
    it('prioritizes deducting from the batch with the earliest expiry date', async () => {
      // Batch 1: Expiring soon (2026-10-18, qty: 5)
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 5,
          expiryDate: '2026-10-18',
        },
        SHOP_ID
      );

      // Batch 2: Expiring later (2026-10-28, qty: 10)
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 10,
          expiryDate: '2026-10-28',
        },
        SHOP_ID
      );

      // Total before sale: 15 units
      expect(await getProductTotalStock(testProduct.id, SHOP_ID)).toBe(15);

      // Sell 3 units
      const saleRes = await recordSale(
        {
          productId: testProduct.id,
          quantity: 3,
        },
        SHOP_ID
      );

      expect(saleRes.error).toBeUndefined();
      expect(saleRes.result).toBeDefined();
      expect(saleRes.result?.remainingTotalStock).toBe(12);

      // Verify deduction came from the earlier batch (2026-10-18)
      expect(saleRes.result?.allocations.length).toBe(1);
      expect(saleRes.result?.allocations[0].batchExpiryDate).toBe('2026-10-18');
      expect(saleRes.result?.allocations[0].quantityDeducted).toBe(3);

      // Check remaining batches in storage
      const batches = await getProductBatches(testProduct.id, SHOP_ID);
      const earlyBatch = batches.find((b) => b.expiryDate === '2026-10-18');
      const laterBatch = batches.find((b) => b.expiryDate === '2026-10-28');

      expect(earlyBatch?.quantity).toBe(2); // 5 - 3 = 2
      expect(laterBatch?.quantity).toBe(10); // Untouched
    });

    it('spans multiple batches if sale quantity exceeds earliest batch', async () => {
      // Batch 1: 4 units expiring 2026-10-20
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 4,
          expiryDate: '2026-10-20',
        },
        SHOP_ID
      );

      // Batch 2: 8 units expiring 2026-11-10
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 8,
          expiryDate: '2026-11-10',
        },
        SHOP_ID
      );

      // Sell 6 units (needs all 4 from Batch 1 + 2 from Batch 2)
      const saleRes = await recordSale(
        {
          productId: testProduct.id,
          quantity: 6,
        },
        SHOP_ID
      );

      expect(saleRes.error).toBeUndefined();
      expect(saleRes.result?.remainingTotalStock).toBe(6);
      expect(saleRes.result?.allocations.length).toBe(2);

      // 4 units deducted from batch 1
      expect(saleRes.result?.allocations[0].quantityDeducted).toBe(4);
      expect(saleRes.result?.allocations[0].batchExpiryDate).toBe('2026-10-20');

      // 2 units deducted from batch 2
      expect(saleRes.result?.allocations[1].quantityDeducted).toBe(2);
      expect(saleRes.result?.allocations[1].batchExpiryDate).toBe('2026-11-10');

      const batches = await getProductBatches(testProduct.id, SHOP_ID);
      const batch2 = batches.find((b) => b.expiryDate === '2026-11-10');
      expect(batch2?.quantity).toBe(6);
    });
  });

  describe('Insufficient Stock & Negative Inventory Prevention', () => {
    it('prevents overselling when requested quantity exceeds available stock', async () => {
      // Stock 5 units
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 5,
          expiryDate: '2026-11-01',
        },
        SHOP_ID
      );

      // Attempt to sell 6 units
      const res = await recordSale(
        {
          productId: testProduct.id,
          quantity: 6,
        },
        SHOP_ID
      );

      expect(res.error).toBeDefined();
      expect(res.error).toContain('Insufficient stock');
      expect(res.error).toContain('Only 5 units available');

      // Verify stock did not drop below zero
      const stock = await getProductTotalStock(testProduct.id, SHOP_ID);
      expect(stock).toBe(5);
    });

    it('prevents sale when stock is completely zero', async () => {
      // 0 stock initially
      const res = await recordSale(
        {
          productId: testProduct.id,
          quantity: 1,
        },
        SHOP_ID
      );

      expect(res.error).toContain('Insufficient stock');
      const stock = await getProductTotalStock(testProduct.id, SHOP_ID);
      expect(stock).toBe(0);
    });
  });

  describe('Duplicate Scans & Repeated Submissions', () => {
    it('rejects duplicate scan submissions with the same idempotency key', async () => {
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 10,
        },
        SHOP_ID
      );

      const idempotencyKey = 'sale_scan_unique_key_001';

      // 1st scan sale of 1 unit
      const firstRes = await recordSale(
        {
          productId: testProduct.id,
          quantity: 1,
          idempotencyKey,
        },
        SHOP_ID
      );
      expect(firstRes.error).toBeUndefined();
      expect(firstRes.result?.remainingTotalStock).toBe(9);

      // Immediate duplicate scan submission with exact same key
      const duplicateRes = await recordSale(
        {
          productId: testProduct.id,
          quantity: 1,
          idempotencyKey,
        },
        SHOP_ID
      );

      expect(duplicateRes.error).toBeDefined();
      expect(duplicateRes.error).toContain('Duplicate scan rejected');

      // Stock must remain 9, not 8
      const stock = await getProductTotalStock(testProduct.id, SHOP_ID);
      expect(stock).toBe(9);
    });
  });

  describe('Concurrency & Rapid Sequential Scans', () => {
    it('processes multiple rapid concurrent sales atomically without race conditions', async () => {
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 10,
        },
        SHOP_ID
      );

      // Simulate 5 rapid simultaneous scans
      const salePromises = Array.from({ length: 5 }, (_, idx) =>
        recordSale(
          {
            productId: testProduct.id,
            quantity: 1,
            idempotencyKey: `concurrent_scan_${idx}_${Date.now()}`,
          },
          SHOP_ID
        )
      );

      const results = await Promise.all(salePromises);

      // All 5 sales should succeed
      for (const res of results) {
        expect(res.error).toBeUndefined();
        expect(res.result).toBeDefined();
      }

      // 10 - 5 = exactly 5 units remaining
      const finalStock = await getProductTotalStock(testProduct.id, SHOP_ID);
      expect(finalStock).toBe(5);

      // 5 sales records created
      const allSales = await getSales(SHOP_ID);
      expect(allSales.length).toBe(5);
    });
  });

  describe('Offline Queueing', () => {
    it('queues sale operations safely when running offline', async () => {
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 8,
        },
        SHOP_ID
      );

      // Simulate offline environment
      const originalOnLine = navigator.onLine;
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

      const res = await recordSale(
        {
          productId: testProduct.id,
          quantity: 2,
        },
        SHOP_ID
      );

      expect(res.error).toBeUndefined();
      expect(res.result?.isQueuedOffline).toBe(true);
      expect(res.result?.remainingTotalStock).toBe(6);

      // Check offline queue item created
      const queue = getOfflineQueue(SHOP_ID);
      expect(queue.length).toBeGreaterThan(0);
      expect(queue[0].status).toBe('pending');

      // Restore navigator.onLine
      Object.defineProperty(navigator, 'onLine', { value: originalOnLine, configurable: true });
    });
  });
});
