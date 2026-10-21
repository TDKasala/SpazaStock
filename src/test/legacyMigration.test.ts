import { describe, it, expect, beforeEach } from 'vitest';
import { importLegacyLocalStorage } from '../lib/legacyMigration';
import { db, resetLocalDatabase } from '../lib/db';
import { getProductTotalStock } from '../services/stockService';
import { searchProductByBarcode } from '../services/productService';
import { isUuid } from '../lib/ids';
import { SHOP_ID } from './helpers';

const PRODUCTS_KEY = 'spazastock_products_spaza_active_shop';
const BATCHES_KEY = 'spazastock_batches_spaza_active_shop';

describe('legacy localStorage import', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
    localStorage.clear();
  });

  it('imports products and remaining stock once, with new UUIDs, and queues them', async () => {
    localStorage.setItem(
      PRODUCTS_KEY,
      JSON.stringify([{ id: 'prod_1700000000000_abcd', barcode: '600 100', name: 'Bread', category: 'bakery', sellingPrice: 18 }])
    );
    localStorage.setItem(
      BATCHES_KEY,
      JSON.stringify([
        { productId: 'prod_1700000000000_abcd', quantity: 4, expiryDate: '2027-10-20' },
        { productId: 'prod_1700000000000_abcd', quantity: 0, expiryDate: '2026-10-01' },
        { productId: 'unknown', quantity: 9, expiryDate: null },
      ])
    );

    expect(await importLegacyLocalStorage(SHOP_ID)).toBe(1);
    const product = await searchProductByBarcode('600100', SHOP_ID);
    expect(product && isUuid(product.id)).toBe(true);
    expect(await getProductTotalStock(product!.id, SHOP_ID)).toBe(4);
    expect((await db.outbox.toArray()).map((i) => i.type)).toEqual(['product_upsert', 'stock_in']);
    expect(localStorage.getItem(PRODUCTS_KEY)).toBeNull();

    localStorage.setItem(PRODUCTS_KEY, JSON.stringify([{ id: 'x', barcode: '999', name: 'Late', category: 'other' }]));
    expect(await importLegacyLocalStorage(SHOP_ID)).toBe(0);
    expect(await db.products.count()).toBe(1);
  });

  it('ignores corrupt legacy data', async () => {
    localStorage.setItem(PRODUCTS_KEY, '{not json');
    expect(await importLegacyLocalStorage(SHOP_ID)).toBe(0);
    expect(await db.products.count()).toBe(0);
  });
});
