import { describe, it, expect, beforeEach } from 'vitest';
import { createProduct, getProducts, searchProductByBarcode, getProductById } from '../services/productService';
import { db, resetLocalDatabase } from '../lib/db';
import { DEVICE_SHOP_ID } from '../lib/constants';
import { isUuid } from '../lib/ids';
import { SHOP_ID, OTHER_SHOP_ID } from './helpers';

const bread = { barcode: '6001007300123', name: 'Albany White Bread', category: 'bakery' as const, sellingPrice: 18.99 };

describe('productService', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
  });

  it('registers a product with a UUID and queues it for sync', async () => {
    const { product, error } = await createProduct(bread, SHOP_ID);
    expect(error).toBeUndefined();
    expect(product && isUuid(product.id)).toBe(true);
    expect(product?.shopId).toBe(SHOP_ID);

    const outbox = await db.outbox.toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ type: 'product_upsert', shopId: SHOP_ID, status: 'pending' });
  });

  it('normalises whitespace in barcodes for create and search', async () => {
    await createProduct({ ...bread, barcode: ' 6001 0073 00123 ' }, SHOP_ID);
    const found = await searchProductByBarcode('6001007300123', SHOP_ID);
    expect(found?.barcode).toBe('6001007300123');
  });

  it('rejects a duplicate barcode in the same shop without queueing anything', async () => {
    await createProduct(bread, SHOP_ID);
    const second = await createProduct({ ...bread, name: 'Other' }, SHOP_ID);
    expect(second.isDuplicate).toBe(true);
    expect(await db.products.count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);
  });

  it('keeps shops isolated', async () => {
    const { product } = await createProduct(bread, SHOP_ID);
    const other = await createProduct(bread, OTHER_SHOP_ID);
    expect(other.isDuplicate).toBeUndefined();

    expect(await searchProductByBarcode(bread.barcode, OTHER_SHOP_ID)).not.toBeNull();
    expect(await getProductById(product!.id, OTHER_SHOP_ID)).toBeNull();
    expect(await getProducts(SHOP_ID)).toHaveLength(1);
  });

  it('validates required fields', async () => {
    expect((await createProduct({ ...bread, barcode: '  ' }, SHOP_ID)).error).toBeTruthy();
    expect((await createProduct({ ...bread, name: '' }, SHOP_ID)).error).toBeTruthy();
    expect(await db.products.count()).toBe(0);
  });

  it('does not queue sync work for the device-only shop', async () => {
    await createProduct(bread, DEVICE_SHOP_ID);
    expect(await db.products.count()).toBe(1);
    expect(await db.outbox.count()).toBe(0);
  });

  it('persists across reads (survives a "reload")', async () => {
    await createProduct(bread, SHOP_ID);
    db.close();
    await db.open();
    expect(await searchProductByBarcode(bread.barcode, SHOP_ID)).not.toBeNull();
  });
});
