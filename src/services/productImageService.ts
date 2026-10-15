import type { Product } from '../types';
import { db, withWriteLock, type ProductImage } from '../lib/db';
import { DEVICE_SHOP_ID } from '../lib/constants';
import { emitDataChanged } from '../lib/events';
import { newId } from '../lib/ids';
import { can } from '../lib/permissions';
import { getShopSettings } from '../lib/shopSettings';
import type { CompressedImage } from '../lib/imageCompression';
import { enqueue } from '../sync/outbox';

export const PRODUCT_IMAGE_BUCKET = 'product-images';

export type ProductImageErrorCode = 'forbidden' | 'not_found';

export interface ProductImageOutcome {
  product?: Product;
  error?: string;
  errorCode?: ProductImageErrorCode;
}

type ImageBytes = Pick<CompressedImage, 'bytes' | 'mimeType'>;

async function hashHex(bytes: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);
  }
  return newId().replace(/-/g, '');
}

/** `<shopId>/<hash>.webp`: the same picture always gets the same path, so it is uploaded once. */
export async function productImagePath(shopId: string, image: ImageBytes): Promise<string> {
  return `${shopId}/${await hashHex(image.bytes)}.${image.mimeType === 'image/jpeg' ? 'jpg' : 'webp'}`;
}

/** Paths still needed on this phone: shown by a product, or waiting in the queue. */
async function pathsInUse(shopId: string): Promise<Set<string>> {
  const [products, queued] = await Promise.all([
    db.products.where('shopId').equals(shopId).toArray(),
    db.outbox.where('shopId').equals(shopId).toArray(),
  ]);
  const paths = new Set<string>();
  for (const product of products) if (product.imagePath) paths.add(product.imagePath);
  for (const item of queued) if (item.type === 'product_image' && item.payload.imagePath) paths.add(item.payload.imagePath);
  return paths;
}

async function dropIfUnused(shopId: string, path: string): Promise<void> {
  if (!(await pathsInUse(shopId)).has(path)) await db.productImages.delete(path);
}

async function changeImage(
  productId: string,
  shopId: string,
  imagePath: string | null,
  image?: ImageBytes
): Promise<ProductImageOutcome> {
  const { role } = await getShopSettings(shopId);
  const outcome = await withWriteLock(() =>
    db.transaction('rw', [db.products, db.productImages, db.outbox], async (): Promise<ProductImageOutcome> => {
      const product = await db.products.get(productId);
      if (!product || product.shopId !== shopId) {
        return { error: 'Product not found in this shop.', errorCode: 'not_found' };
      }
      const current = product.imagePath ?? null;
      if (current === imagePath) return { product };
      // Staff may give a product its first picture; changing or removing one needs products.edit.
      if (!can(role, 'products.edit') && !(current === null && imagePath !== null)) {
        return { error: 'Only an owner or manager can change a product picture.', errorCode: 'forbidden' };
      }

      const now = new Date().toISOString();
      if (imagePath && image) {
        await db.productImages.put({
          path: imagePath,
          shopId,
          bytes: image.bytes,
          mimeType: image.mimeType,
          pending: shopId !== DEVICE_SHOP_ID,
          cachedAt: now,
        });
      }
      const updated: Product = { ...product, imagePath, updatedAt: now };
      await db.products.put(updated);

      // A picture that has not been sent yet is replaced in the queue instead of being uploaded.
      const superseded = await db.outbox
        .where('[shopId+status]')
        .equals([shopId, 'pending'])
        .filter((item) => item.type === 'product_image' && item.payload.productId === productId)
        .toArray();
      await db.outbox.bulkDelete(superseded.map((item) => item.seq!));
      await enqueue(shopId, { type: 'product_image', payload: { productId, imagePath } });

      const dropped = new Set<string>();
      if (current) dropped.add(current);
      for (const item of superseded) {
        if (item.type === 'product_image' && item.payload.imagePath) dropped.add(item.payload.imagePath);
      }
      for (const path of dropped) if (path !== imagePath) await dropIfUnused(shopId, path);
      return { product: updated };
    })
  );
  if (outcome.product) emitDataChanged('local');
  return outcome;
}

/** Stores a compressed picture on the phone, shows it on the product and queues the upload. */
export async function saveProductImage(productId: string, shopId: string, image: ImageBytes): Promise<ProductImageOutcome> {
  return changeImage(productId, shopId, await productImagePath(shopId, image), image);
}

export async function removeProductImage(productId: string, shopId: string): Promise<ProductImageOutcome> {
  return changeImage(productId, shopId, null);
}

export async function getCachedImage(path: string): Promise<ProductImage | undefined> {
  return db.productImages.get(path);
}

/** Keeps a downloaded picture for offline use. A picture waiting to upload is left as it is. */
export async function cacheImage(path: string, shopId: string, bytes: ArrayBuffer, mimeType: string): Promise<void> {
  await db.transaction('rw', db.productImages, async () => {
    if (await db.productImages.get(path)) return;
    await db.productImages.put({ path, shopId, bytes, mimeType, pending: false, cachedAt: new Date().toISOString() });
  });
}

/** Deletes pictures no product shows and nothing in the queue needs, e.g. after a replacement elsewhere. */
export async function pruneImageCache(shopId: string): Promise<number> {
  const keep = await pathsInUse(shopId);
  const unused = (await db.productImages.where('shopId').equals(shopId).primaryKeys()).filter((path) => !keep.has(path));
  await db.productImages.bulkDelete(unused);
  return unused.length;
}
