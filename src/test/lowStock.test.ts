import { describe, it, expect, beforeEach } from 'vitest';
import { dismissalIsActive, lowStockItems, orderListText, recoveredProductIds } from '../lib/lowStock';
import { getAllProductsStockSummary, stockIn } from '../services/stockService';
import { createProduct, setProductMinStock } from '../services/productService';
import { resetLocalDatabase } from '../lib/db';
import { saveShopSettings } from '../lib/shopSettings';
import { SHOP_ID } from './helpers';

describe('lowStockItems', () => {
  const bread = { id: 'bread', name: 'Bread', minStockUnits: 5, archivedAt: null, sellable: 2, expired: 4 };
  const milk = { id: 'milk', name: 'Milk', minStockUnits: 1, archivedAt: null, sellable: 1, expired: 0 };

  it('includes products at or below the minimum and leaves the rest out', () => {
    const items = lowStockItems(
      [
        bread,
        milk,
        { id: 'coke', name: 'Coke', minStockUnits: 2, archivedAt: null, sellable: 3, expired: 0 },
        { id: 'airtime', name: 'Airtime', minStockUnits: null, archivedAt: null, sellable: 0, expired: 0 },
        { ...bread, id: 'old', name: 'Old bread', archivedAt: '2026-10-01T00:00:00Z', sellable: 0 },
      ],
      []
    );
    expect(items.map((item) => item.productId)).toEqual(['bread', 'milk']);
    expect(items[0]).toMatchObject({ sellable: 2, expired: 4, minimum: 5, shortfall: 3, dismissed: false });
  });

  it('keeps a dismissal quiet only while stock is still at or below the minimum', () => {
    expect(dismissalIsActive({ clearedAt: null }, 2, 5)).toBe(true);
    expect(dismissalIsActive({ clearedAt: '2026-10-16T00:00:00Z' }, 2, 5)).toBe(false);
    expect(dismissalIsActive({ clearedAt: null }, 6, 5)).toBe(false);
    const [item] = lowStockItems([milk], [{ productId: 'milk', clearedAt: null }]);
    expect(item?.dismissed).toBe(true);
  });

  it('clears a dismissal once sellable stock rises above the minimum', () => {
    expect(
      recoveredProductIds([{ id: 'bread', minStockUnits: 5, sellable: 6, archivedAt: null }], [
        { productId: 'bread', clearedAt: null },
      ])
    ).toEqual(['bread']);
    expect(
      recoveredProductIds([{ id: 'bread', minStockUnits: 5, sellable: 2, archivedAt: null }], [
        { productId: 'bread', clearedAt: null },
      ])
    ).toEqual([]);
  });
});

describe('orderListText', () => {
  it('lists the largest gap first, appends size, and leaves a full minimum off the message', () => {
    const text = orderListText(
      [
        { name: 'Bread', shortfall: 1, size: null },
        { name: 'Sunlight', shortfall: 6, size: '750ml' },
        { name: 'Milk', shortfall: 0, size: '1L' },
      ],
      { shopName: 'Corner Spaza', heading: 'Please supply:' }
    );
    expect(text).toBe('Corner Spaza\nPlease supply:\nSunlight 750ml — 6\nBread — 1');
  });

  it('is empty when nothing is short of its minimum', () => {
    expect(orderListText([{ name: 'Milk', shortfall: 0 }], { shopName: 'Corner Spaza', heading: 'Please supply:' })).toBe(
      ''
    );
  });
});

describe('low stock from batches', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
  });

  it('counts only sellable units, and reports expired units beside them', async () => {
    const { product } = await createProduct(
      { barcode: '6001007300123', name: 'Bread', category: 'bakery', sellingPrice: 18 },
      SHOP_ID
    );
    await stockIn({ productId: product!.id, quantity: 2, expiryDate: '2026-12-01' }, SHOP_ID);
    await stockIn({ productId: product!.id, quantity: 4, expiryDate: '2020-01-01' }, SHOP_ID);
    await setProductMinStock(product!.id, 3, SHOP_ID);

    const [summary] = await getAllProductsStockSummary(SHOP_ID);
    const [item] = lowStockItems(
      [{ ...summary.product, sellable: summary.totalQuantity, expired: summary.expiredQuantity }],
      []
    );
    expect(item).toMatchObject({ sellable: 2, expired: 4, minimum: 3, shortfall: 1 });
  });

  it('refuses the minimum when the signed-in role cannot edit products', async () => {
    const { product } = await createProduct(
      { barcode: '6001007300124', name: 'Milk', category: 'dairy', sellingPrice: 20 },
      SHOP_ID
    );
    await saveShopSettings(SHOP_ID, { role: 'staff' });
    const outcome = await setProductMinStock(product!.id, 2, SHOP_ID);
    expect(outcome.errorCode).toBe('forbidden');
  });
});
