import { describe, it, expect, beforeEach } from 'vitest';
import { createProduct } from '../services/productService';
import {
  CATALOG_IMAGE_CACHE_ID,
  cacheImage,
  getCachedImage,
  productImagePath,
  pruneImageCache,
  removeProductImage,
  saveProductImage,
} from '../services/productImageService';
import { saveShopSettings } from '../lib/shopSettings';
import { db, resetLocalDatabase } from '../lib/db';
import { SHOP_ID } from './helpers';

const bread = { barcode: '6001007300123', name: 'Albany White Bread', category: 'bakery' as const };

function picture(seed: number, mimeType: 'image/webp' | 'image/jpeg' = 'image/webp') {
  return { bytes: new Uint8Array([seed, seed + 1, seed + 2, 7, 7, 7]).buffer, mimeType };
}

async function newProduct() {
  const { product } = await createProduct(bread, SHOP_ID);
  return product!;
}

async function queuedImages() {
  return (await db.outbox.toArray()).filter((item) => item.type === 'product_image');
}

describe('productImageService', () => {
  beforeEach(async () => {
    await resetLocalDatabase();
  });

  it('names a picture after its content and shop', async () => {
    const a = await productImagePath(SHOP_ID, picture(1));
    expect(a).toMatch(new RegExp(`^${SHOP_ID}/[0-9a-f]{32}\\.webp$`));
    expect(await productImagePath(SHOP_ID, picture(1))).toBe(a);
    expect(await productImagePath(SHOP_ID, picture(2))).not.toBe(a);
    expect(await productImagePath(SHOP_ID, picture(1, 'image/jpeg'))).toMatch(/\.jpg$/);
  });

  it('keeps the picture on the phone and queues the upload after the product', async () => {
    const product = await newProduct();
    const { product: updated } = await saveProductImage(product.id, SHOP_ID, picture(1));
    expect(updated?.imagePath).toMatch(/\.webp$/);
    expect((await db.products.get(product.id))?.imagePath).toBe(updated?.imagePath);

    const stored = await getCachedImage(updated!.imagePath!);
    expect(stored).toMatchObject({ shopId: SHOP_ID, mimeType: 'image/webp', pending: true });
    expect(new Uint8Array(stored!.bytes)).toEqual(new Uint8Array(picture(1).bytes));

    expect((await db.outbox.toArray()).map((item) => item.type)).toEqual(['product_upsert', 'product_image']);
    expect((await queuedImages())[0]).toMatchObject({ payload: { productId: product.id, imagePath: updated!.imagePath } });
  });

  it('replaces a picture that has not been sent yet instead of uploading both', async () => {
    const product = await newProduct();
    const first = await saveProductImage(product.id, SHOP_ID, picture(1));
    const second = await saveProductImage(product.id, SHOP_ID, picture(2));

    const queued = await queuedImages();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ payload: { imagePath: second.product!.imagePath } });
    expect(await getCachedImage(first.product!.imagePath!)).toBeUndefined();
    expect(await getCachedImage(second.product!.imagePath!)).toBeDefined();
  });

  it('does nothing when the same picture is chosen again', async () => {
    const product = await newProduct();
    await saveProductImage(product.id, SHOP_ID, picture(1));
    const again = await saveProductImage(product.id, SHOP_ID, picture(1));
    expect(again.product).toBeDefined();
    expect(await queuedImages()).toHaveLength(1);
  });

  it('removes a picture and queues the removal', async () => {
    const product = await newProduct();
    const saved = await saveProductImage(product.id, SHOP_ID, picture(1));
    const removed = await removeProductImage(product.id, SHOP_ID);
    expect(removed.product?.imagePath).toBeNull();
    expect(await getCachedImage(saved.product!.imagePath!)).toBeUndefined();
    expect((await queuedImages()).map((item) => item.payload)).toEqual([{ productId: product.id, imagePath: null }]);
  });

  it('lets staff add a first picture but not replace or remove it', async () => {
    await saveShopSettings(SHOP_ID, { role: 'staff' });
    const product = await newProduct();
    expect((await saveProductImage(product.id, SHOP_ID, picture(1))).product).toBeDefined();
    expect((await saveProductImage(product.id, SHOP_ID, picture(2))).errorCode).toBe('forbidden');
    expect((await removeProductImage(product.id, SHOP_ID)).errorCode).toBe('forbidden');
    expect(await queuedImages()).toHaveLength(1);
  });

  it('refuses products from another shop', async () => {
    const product = await newProduct();
    expect((await saveProductImage(product.id, 'other-shop', picture(1))).errorCode).toBe('not_found');
  });

  it('keeps downloaded pictures without overwriting one waiting to upload', async () => {
    const product = await newProduct();
    const { product: updated } = await saveProductImage(product.id, SHOP_ID, picture(1));
    await cacheImage(updated!.imagePath!, SHOP_ID, new ArrayBuffer(1), 'image/webp');
    expect((await getCachedImage(updated!.imagePath!))?.pending).toBe(true);

    await cacheImage(`${SHOP_ID}/${'a'.repeat(32)}.webp`, SHOP_ID, new ArrayBuffer(3), 'image/webp');
    expect((await getCachedImage(`${SHOP_ID}/${'a'.repeat(32)}.webp`))?.pending).toBe(false);
  });

  it('prunes cached pictures that nothing uses any more', async () => {
    const product = await newProduct();
    const { product: updated } = await saveProductImage(product.id, SHOP_ID, picture(1));
    const stale = `${SHOP_ID}/${'b'.repeat(32)}.webp`;
    await cacheImage(stale, SHOP_ID, new ArrayBuffer(3), 'image/webp');

    expect(await pruneImageCache(SHOP_ID)).toBe(1);
    expect(await getCachedImage(stale)).toBeUndefined();
    expect(await getCachedImage(updated!.imagePath!)).toBeDefined();
  });

  it('keeps a shared catalogue picture when a shop cache is pruned', async () => {
    const shared = 'catalog/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
    await cacheImage(shared, SHOP_ID, picture(4).bytes, 'image/webp');
    const stale = `${SHOP_ID}/${'c'.repeat(32)}.webp`;
    await cacheImage(stale, SHOP_ID, picture(5).bytes, 'image/webp');

    expect((await getCachedImage(shared))?.shopId).toBe(CATALOG_IMAGE_CACHE_ID);
    expect(await pruneImageCache(SHOP_ID)).toBe(1);
    expect(await getCachedImage(shared)).toBeDefined();
    expect(await getCachedImage(stale)).toBeUndefined();
  });

  it('drops the oldest unused catalogue picture and keeps one a product shows', async () => {
    const product = await newProduct();
    const paths = Array.from({ length: 200 }, (_, index) => catalogPath(index));
    for (const path of paths) await cacheImage(path, SHOP_ID, picture(6).bytes, 'image/webp');
    for (let index = 0; index < paths.length; index += 1) {
      await db.productImages.update(paths[index], {
        cachedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString(),
        pending: index === 1,
      });
    }
    await db.products.update(product.id, { imagePath: paths[0] });
    const newest = catalogPath(200);
    await cacheImage(newest, SHOP_ID, picture(7).bytes, 'image/webp');

    expect(await getCachedImage(paths[0])).toBeDefined();
    expect(await getCachedImage(paths[1])).toBeDefined();
    expect(await getCachedImage(paths[2])).toBeUndefined();
    expect(await getCachedImage(newest)).toBeDefined();
    expect(await db.productImages.where('shopId').equals(CATALOG_IMAGE_CACHE_ID).count()).toBe(200);
  });
});

function catalogPath(index: number): string {
  return `catalog/${String(index).padStart(8, '0')}-0000-4000-8000-000000000000.webp`;
}
