import { describe, it, expect, beforeEach } from 'vitest';
import {
  stockIn,
  getProductBatches,
  getProductTotalStock,
  clearStockData,
  isValidDateFormat,
  validateShopPermission,
} from '../services/stockService';
import { createProduct, clearLocalProducts, DEFAULT_SHOP_ID } from '../services/productService';
import { Product } from '../types';

describe('Stock-In Service & Expiry Tracking', () => {
  let testProduct: Product;
  const SHOP_ID = DEFAULT_SHOP_ID;

  beforeEach(async () => {
    clearLocalProducts(SHOP_ID);
    clearStockData(SHOP_ID);

    // Register a fresh test product
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

  describe('Repeated Deliveries (Additive Stock)', () => {
    it('increases inventory additively across repeated deliveries without overwriting', async () => {
      // First delivery: 10 units
      const firstDelivery = await stockIn(
        {
          productId: testProduct.id,
          quantity: 10,
          expiryDate: '2026-10-25',
        },
        SHOP_ID
      );

      expect(firstDelivery.error).toBeUndefined();
      expect(firstDelivery.result).toBeDefined();
      expect(firstDelivery.result?.previousTotalQuantity).toBe(0);
      expect(firstDelivery.result?.resultingTotalQuantity).toBe(10);

      // Verify immediate available stock
      const stockAfterFirst = await getProductTotalStock(testProduct.id, SHOP_ID);
      expect(stockAfterFirst).toBe(10);

      // Second delivery: 15 units
      const secondDelivery = await stockIn(
        {
          productId: testProduct.id,
          quantity: 15,
          expiryDate: '2026-11-01',
        },
        SHOP_ID
      );

      expect(secondDelivery.error).toBeUndefined();
      expect(secondDelivery.result?.previousTotalQuantity).toBe(10);
      expect(secondDelivery.result?.resultingTotalQuantity).toBe(25);

      // Verify total stock is 25 (not overwritten to 15)
      const stockAfterSecond = await getProductTotalStock(testProduct.id, SHOP_ID);
      expect(stockAfterSecond).toBe(25);
    });
  });

  describe('Different Batch Expiry Dates', () => {
    it('stores each delivery as a separate batch preserving distinct expiry dates', async () => {
      // Delivery 1: expiring on 2026-10-20 (qty: 6)
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 6,
          expiryDate: '2026-10-20',
        },
        SHOP_ID
      );

      // Delivery 2: expiring on 2026-11-15 (qty: 12)
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 12,
          expiryDate: '2026-11-15',
        },
        SHOP_ID
      );

      // Delivery 3: non-perishable delivery without expiry date (qty: 8)
      await stockIn(
        {
          productId: testProduct.id,
          quantity: 8,
          expiryDate: null,
        },
        SHOP_ID
      );

      const batches = await getProductBatches(testProduct.id, SHOP_ID);
      expect(batches.length).toBe(3);

      // Verify batches preserve individual expiry dates and quantities
      const expDates = batches.map((b) => ({ qty: b.quantity, exp: b.expiryDate }));
      expect(expDates).toContainEqual({ qty: 6, exp: '2026-10-20' });
      expect(expDates).toContainEqual({ qty: 12, exp: '2026-11-15' });
      expect(expDates).toContainEqual({ qty: 8, exp: null });

      // Total available quantity is sum of all 3 batches (6 + 12 + 8 = 26)
      const total = await getProductTotalStock(testProduct.id, SHOP_ID);
      expect(total).toBe(26);
    });
  });

  describe('Duplicate Submission Prevention', () => {
    it('rejects duplicate submissions with the same idempotency key', async () => {
      const idempotencyKey = 'unique_delivery_req_001';

      // 1st submission
      const firstRes = await stockIn(
        {
          productId: testProduct.id,
          quantity: 24,
          expiryDate: '2026-12-01',
          idempotencyKey,
        },
        SHOP_ID
      );
      expect(firstRes.error).toBeUndefined();
      expect(firstRes.result?.resultingTotalQuantity).toBe(24);

      // Duplicate submission with same key
      const duplicateRes = await stockIn(
        {
          productId: testProduct.id,
          quantity: 24,
          expiryDate: '2026-12-01',
          idempotencyKey,
        },
        SHOP_ID
      );
      expect(duplicateRes.error).toBeDefined();
      expect(duplicateRes.error).toContain('Duplicate submission rejected');

      // Verify stock was NOT incremented twice
      const stock = await getProductTotalStock(testProduct.id, SHOP_ID);
      expect(stock).toBe(24);
    });
  });

  describe('Invalid Inputs Validation', () => {
    it('rejects non-positive integer quantities', async () => {
      // Zero quantity
      const resZero = await stockIn(
        { productId: testProduct.id, quantity: 0 },
        SHOP_ID
      );
      expect(resZero.error).toContain('positive whole integer');

      // Negative quantity
      const resNeg = await stockIn(
        { productId: testProduct.id, quantity: -5 },
        SHOP_ID
      );
      expect(resNeg.error).toContain('positive whole integer');

      // Decimal quantity (e.g. 2.5)
      const resDecimal = await stockIn(
        { productId: testProduct.id, quantity: 2.5 },
        SHOP_ID
      );
      expect(resDecimal.error).toContain('positive whole integer');
    });

    it('rejects invalid expiry date formats', async () => {
      // Slashes instead of dashes
      const resSlash = await stockIn(
        {
          productId: testProduct.id,
          quantity: 5,
          expiryDate: '2026/10/25',
        },
        SHOP_ID
      );
      expect(resSlash.error).toContain('Invalid expiry date format');

      // Day-first format
      const resDayFirst = await stockIn(
        {
          productId: testProduct.id,
          quantity: 5,
          expiryDate: '25-10-2026',
        },
        SHOP_ID
      );
      expect(resDayFirst.error).toContain('Invalid expiry date format');

      // Nonsense string
      const resInvalid = await stockIn(
        {
          productId: testProduct.id,
          quantity: 5,
          expiryDate: 'not-a-date',
        },
        SHOP_ID
      );
      expect(resInvalid.error).toContain('Invalid expiry date format');
    });

    it('rejects non-existent product ID', async () => {
      const res = await stockIn(
        {
          productId: 'non_existent_prod_id',
          quantity: 10,
        },
        SHOP_ID
      );
      expect(res.error).toContain('Product not found');
    });
  });

  describe('Shop Authorization Validation', () => {
    it('rejects stock-in for unauthorized or mismatched shop IDs', async () => {
      const res = await stockIn(
        {
          productId: testProduct.id,
          quantity: 5,
        },
        'unauthorized_external_shop'
      );
      expect(res.error).toContain('Unauthorized: Action restricted to active shop');
    });

    it('correctly validates shop permissions', () => {
      expect(validateShopPermission(DEFAULT_SHOP_ID, DEFAULT_SHOP_ID)).toBe(true);
      expect(validateShopPermission('other_shop', DEFAULT_SHOP_ID)).toBe(false);
      expect(validateShopPermission('', DEFAULT_SHOP_ID)).toBe(false);
    });
  });
});
