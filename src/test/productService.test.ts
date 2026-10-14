import { describe, it, expect, beforeEach } from 'vitest';
import {
  createProduct,
  searchProductByBarcode,
  normalizeBarcode,
  clearLocalProducts,
} from '../services/productService';

describe('Product Service & Duplicate Prevention', () => {
  const TEST_SHOP_ID = 'test_shop_123';

  beforeEach(() => {
    clearLocalProducts(TEST_SHOP_ID);
  });

  it('normalizes barcodes by trimming and stripping whitespace', () => {
    expect(normalizeBarcode('  6001234567890  ')).toBe('6001234567890');
    expect(normalizeBarcode('600 123 456')).toBe('600123456');
  });

  it('returns null when product is not found in shop catalog', async () => {
    const product = await searchProductByBarcode('9999999999999', TEST_SHOP_ID);
    expect(product).toBeNull();
  });

  it('registers a new product with optional buying and selling prices', async () => {
    const result = await createProduct(
      {
        barcode: '6001007300123',
        name: 'Albany Superior White Bread 700g',
        category: 'bakery',
        buyingPrice: 15.5,
        sellingPrice: 18.0,
      },
      TEST_SHOP_ID
    );

    expect(result.error).toBeUndefined();
    expect(result.product).toBeDefined();
    expect(result.product?.barcode).toBe('6001007300123');
    expect(result.product?.name).toBe('Albany Superior White Bread 700g');
    expect(result.product?.category).toBe('bakery');
    expect(result.product?.buyingPrice).toBe(15.5);
    expect(result.product?.sellingPrice).toBe(18.0);
  });

  it('prevents accidental duplicate products with the same barcode', async () => {
    // 1st insertion
    await createProduct(
      {
        barcode: '5449000000996',
        name: 'Coca-Cola 330ml Can',
        category: 'beverages',
        buyingPrice: 9.0,
        sellingPrice: 13.0,
      },
      TEST_SHOP_ID
    );

    // 2nd insertion with same barcode
    const duplicateResult = await createProduct(
      {
        barcode: ' 5449000000996 ',
        name: 'Coca-Cola Can Duplicate',
        category: 'beverages',
        buyingPrice: 10.0,
        sellingPrice: 14.0,
      },
      TEST_SHOP_ID
    );

    expect(duplicateResult.isDuplicate).toBe(true);
    expect(duplicateResult.error).toContain('already exists');
    expect(duplicateResult.product?.name).toBe('Coca-Cola 330ml Can');
  });

  it('retrieves registered product immediately when searched by barcode', async () => {
    await createProduct(
      {
        barcode: '6001087361250',
        name: 'Simba Chips Smoked Beef',
        category: 'snacks',
        buyingPrice: null,
        sellingPrice: 12.0,
      },
      TEST_SHOP_ID
    );

    const found = await searchProductByBarcode('6001087361250', TEST_SHOP_ID);
    expect(found).not.toBeNull();
    expect(found?.name).toBe('Simba Chips Smoked Beef');
    expect(found?.category).toBe('snacks');
    expect(found?.buyingPrice).toBeNull();
    expect(found?.sellingPrice).toBe(12.0);
  });
});
