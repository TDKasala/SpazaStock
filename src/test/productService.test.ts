import { describe, it, expect, beforeEach } from 'vitest';
import {
  createProduct,
  getArchivedProducts,
  getProducts,
  searchProductByBarcode,
  getProductById,
  isArchived,
  setProductArchived,
  updateProduct,
} from '../services/productService';
import { getAllProductsStockSummary, getExpiryAlerts, stockIn } from '../services/stockService';
import { getSales, recordSale } from '../services/salesService';
import { saveShopSettings } from '../lib/shopSettings';
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

describe('editing and archiving products', () => {
  const edits = { barcode: ' 6001 0073 00123 ', name: '  Albany Brown Bread ', category: 'bakery' as const, buyingPrice: 12, sellingPrice: 19.5 };

  /** A registered product whose registration has already reached the server. */
  async function syncedProduct(input = bread) {
    const { product } = await createProduct(input, SHOP_ID);
    await db.outbox.clear();
    return product!;
  }

  beforeEach(async () => {
    await resetLocalDatabase();
    await saveShopSettings(SHOP_ID, { role: 'manager' });
  });

  it('edits a synced product, normalising the barcode, and queues the change', async () => {
    const product = await syncedProduct();
    const { product: updated, error } = await updateProduct(product.id, edits, SHOP_ID);
    expect(error).toBeUndefined();
    expect(updated).toMatchObject({ id: product.id, barcode: '6001007300123', name: 'Albany Brown Bread', sellingPrice: 19.5 });
    expect(await getProductById(product.id, SHOP_ID)).toMatchObject({ name: 'Albany Brown Bread' });

    const [item] = await db.outbox.toArray();
    expect(item).toMatchObject({
      type: 'product_update',
      payload: { productId: product.id, changes: { barcode: '6001007300123', name: 'Albany Brown Bread', buyingPrice: 12 } },
    });
  });

  it('folds an edit into a registration that has not synced yet', async () => {
    const { product } = await createProduct(bread, SHOP_ID);
    await updateProduct(product!.id, edits, SHOP_ID);
    const queued = await db.outbox.toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: 'product_upsert', payload: { product: { id: product!.id, name: 'Albany Brown Bread' } } });
  });

  it('rejects a barcode used by another product, including an archived one', async () => {
    const milk = await syncedProduct({ ...bread, barcode: '6001049000013', name: 'Milk' });
    const loaf = await syncedProduct();
    const taken = await updateProduct(loaf.id, { ...edits, barcode: milk.barcode }, SHOP_ID);
    expect(taken).toMatchObject({ errorCode: 'duplicate', conflict: { id: milk.id } });

    await setProductArchived(milk.id, true, SHOP_ID);
    await db.outbox.clear();
    expect((await updateProduct(loaf.id, { ...edits, barcode: milk.barcode }, SHOP_ID)).errorCode).toBe('duplicate');
    expect(await db.outbox.count()).toBe(0);
    expect((await getProductById(loaf.id, SHOP_ID))?.barcode).toBe(bread.barcode);
  });

  it('validates edits and leaves the product unchanged', async () => {
    const product = await syncedProduct();
    expect((await updateProduct(product.id, { ...edits, name: ' ' }, SHOP_ID)).errorCode).toBe('invalid');
    expect((await updateProduct(product.id, { ...edits, barcode: '' }, SHOP_ID)).errorCode).toBe('invalid');
    expect((await updateProduct(product.id, { ...edits, sellingPrice: -1 }, SHOP_ID)).errorCode).toBe('invalid');
    expect((await updateProduct('missing', edits, SHOP_ID)).errorCode).toBe('not_found');
    expect(await db.outbox.count()).toBe(0);
  });

  it('only lets owners and managers edit, archive or restore', async () => {
    const product = await syncedProduct();
    await saveShopSettings(SHOP_ID, { role: 'staff' });
    expect((await updateProduct(product.id, edits, SHOP_ID)).errorCode).toBe('forbidden');
    expect((await setProductArchived(product.id, true, SHOP_ID)).errorCode).toBe('forbidden');
    expect(await db.outbox.count()).toBe(0);
    expect((await getProductById(product.id, SHOP_ID))?.archivedAt ?? null).toBeNull();
  });

  it('hides an archived product from lists, stock and alerts, keeps it findable, and restores it', async () => {
    const product = await syncedProduct();
    await stockIn({ productId: product.id, quantity: 4, expiryDate: '2020-01-01' }, SHOP_ID);
    expect(await getExpiryAlerts(SHOP_ID)).toHaveLength(1);
    await db.outbox.clear();

    const { product: archived } = await setProductArchived(product.id, true, SHOP_ID);
    expect(archived?.archivedAt).toBeTruthy();
    expect(await getProducts(SHOP_ID)).toHaveLength(0);
    expect(await getProducts(SHOP_ID, { includeArchived: true })).toHaveLength(1);
    expect(await getArchivedProducts(SHOP_ID)).toHaveLength(1);
    expect(await getAllProductsStockSummary(SHOP_ID)).toHaveLength(0);
    expect(await getExpiryAlerts(SHOP_ID)).toHaveLength(0);
    expect(isArchived((await searchProductByBarcode(bread.barcode, SHOP_ID))!)).toBe(true);

    // Archiving again changes nothing and queues nothing.
    await setProductArchived(product.id, true, SHOP_ID);
    expect(await db.outbox.toArray()).toMatchObject([{ type: 'product_archive', payload: { productId: product.id, archived: true } }]);

    await setProductArchived(product.id, false, SHOP_ID);
    expect(await getProducts(SHOP_ID)).toHaveLength(1);
    expect(await getExpiryAlerts(SHOP_ID)).toHaveLength(1);
    expect((await db.outbox.toArray()).map((i) => i.type)).toEqual(['product_archive', 'product_archive']);
  });

  it('offers the archived product instead of registering its barcode again', async () => {
    const product = await syncedProduct();
    await setProductArchived(product.id, true, SHOP_ID);
    const again = await createProduct(bread, SHOP_ID);
    expect(again.isDuplicate).toBe(true);
    expect(again.product?.id).toBe(product.id);
    expect(isArchived(again.product!)).toBe(true);
  });

  it('keeps the product name on past sales after it is archived', async () => {
    const product = await syncedProduct();
    await stockIn({ productId: product.id, quantity: 2, expiryDate: null }, SHOP_ID);
    await recordSale({ productId: product.id, quantity: 1 }, SHOP_ID);
    await setProductArchived(product.id, true, SHOP_ID);
    const [sale] = await getSales(SHOP_ID);
    const names = new Map((await getProducts(SHOP_ID, { includeArchived: true })).map((p) => [p.id, p.name]));
    expect(names.get(sale.productId)).toBe(bread.name);
  });
});
