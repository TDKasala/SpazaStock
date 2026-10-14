import { Product, ProductEditInput, ProductRegistrationInput } from '../types';
import { db, withWriteLock } from '../lib/db';
import { newId } from '../lib/ids';
import { emitDataChanged } from '../lib/events';
import { can } from '../lib/permissions';
import { getShopSettings } from '../lib/shopSettings';
import { enqueue } from '../sync/outbox';

export function normalizeBarcode(barcode: string): string {
  return barcode.replace(/\s/g, '');
}

export const MAX_BARCODE_LENGTH = 64;
export const MAX_PRODUCT_NAME_LENGTH = 200;

export function isArchived(product: Pick<Product, 'archivedAt'>): boolean {
  return Boolean(product.archivedAt);
}

/**
 * Looks up a product by barcode in the given shop's local catalog. Archived products are found
 * too, so callers can say so instead of offering to register the barcode again.
 */
export async function searchProductByBarcode(
  barcode: string,
  shopId: string
): Promise<Product | null> {
  const normalized = normalizeBarcode(barcode);
  if (!normalized) return null;
  const found = await db.products.where('[shopId+barcode]').equals([shopId, normalized]).first();
  return found ?? null;
}

export async function getProductById(productId: string, shopId: string): Promise<Product | null> {
  const product = await db.products.get(productId);
  return product && product.shopId === shopId ? product : null;
}

/** Products in the shop, newest first. Archived products are left out unless asked for. */
export async function getProducts(
  shopId: string,
  options: { includeArchived?: boolean } = {}
): Promise<Product[]> {
  const products = await db.products
    .where('[shopId+createdAt]')
    .between([shopId, ''], [shopId, '\uffff'])
    .toArray();
  const visible = options.includeArchived ? products : products.filter((p) => !isArchived(p));
  return visible.reverse();
}

/** Archived products only, newest first. */
export async function getArchivedProducts(shopId: string): Promise<Product[]> {
  return (await getProducts(shopId, { includeArchived: true })).filter(isArchived);
}

/**
 * Registers a product locally and queues it for sync.
 * Rejects a second product with the same barcode in the same shop.
 */
export async function createProduct(
  input: ProductRegistrationInput,
  shopId: string
): Promise<{ product?: Product; error?: string; isDuplicate?: boolean }> {
  const barcode = normalizeBarcode(input.barcode);
  const name = input.name.trim();

  if (!barcode) return { error: 'Barcode is required.' };
  if (!name) return { error: 'Product name is required.' };

  const result = await withWriteLock(() =>
    db.transaction('rw', db.products, db.outbox, async () => {
      const existing = await db.products
        .where('[shopId+barcode]')
        .equals([shopId, barcode])
        .first();
      if (existing) {
        return {
          error: `A product with barcode "${barcode}" already exists ("${existing.name}").`,
          isDuplicate: true,
          product: existing,
        };
      }

      const now = new Date().toISOString();
      const product: Product = {
        id: newId(),
        shopId,
        barcode,
        name,
        category: input.category,
        buyingPrice: input.buyingPrice ?? null,
        sellingPrice: input.sellingPrice ?? null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };

      await db.products.add(product);
      await enqueue(shopId, { type: 'product_upsert', payload: { product } });
      return { product };
    })
  );

  if (!result.isDuplicate) emitDataChanged('local');
  return result;
}

export type ProductEditErrorCode = 'forbidden' | 'not_found' | 'invalid' | 'duplicate';

export interface ProductEditOutcome {
  product?: Product;
  error?: string;
  errorCode?: ProductEditErrorCode;
  /** The product that already uses the barcode, for a 'duplicate' error. */
  conflict?: Product;
}

async function canEditProducts(shopId: string): Promise<boolean> {
  return can((await getShopSettings(shopId)).role, 'products.edit');
}

const FORBIDDEN: ProductEditOutcome = {
  error: 'Only an owner or manager can change products.',
  errorCode: 'forbidden',
};

/**
 * Changes a product's details and queues the edit. A product that has not reached the server
 * yet has its queued registration updated instead, so the server only ever sees the final values.
 */
export async function updateProduct(
  productId: string,
  input: ProductEditInput,
  shopId: string
): Promise<ProductEditOutcome> {
  if (!(await canEditProducts(shopId))) return FORBIDDEN;

  const changes: ProductEditInput = {
    barcode: normalizeBarcode(input.barcode),
    name: input.name.trim(),
    category: input.category,
    buyingPrice: input.buyingPrice ?? null,
    sellingPrice: input.sellingPrice ?? null,
  };
  if (!changes.barcode || changes.barcode.length > MAX_BARCODE_LENGTH) {
    return { error: 'Barcode is required (up to 64 characters).', errorCode: 'invalid' };
  }
  if (!changes.name || changes.name.length > MAX_PRODUCT_NAME_LENGTH) {
    return { error: 'Product name is required (up to 200 characters).', errorCode: 'invalid' };
  }
  if ((changes.buyingPrice ?? 0) < 0 || (changes.sellingPrice ?? 0) < 0) {
    return { error: 'Prices cannot be negative.', errorCode: 'invalid' };
  }

  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.products, db.outbox, async (): Promise<ProductEditOutcome> => {
      const product = await db.products.get(productId);
      if (!product || product.shopId !== shopId) {
        return { error: 'Product not found in this shop.', errorCode: 'not_found' };
      }
      const conflict = await db.products.where('[shopId+barcode]').equals([shopId, changes.barcode]).first();
      if (conflict && conflict.id !== productId) {
        return {
          error: `Another product already uses barcode "${changes.barcode}" ("${conflict.name}").`,
          errorCode: 'duplicate',
          conflict,
        };
      }

      const updated: Product = { ...product, ...changes, updatedAt: new Date().toISOString() };
      await db.products.put(updated);

      const queuedRegistration = await db.outbox
        .where('[shopId+status]')
        .equals([shopId, 'pending'])
        .filter((item) => item.type === 'product_upsert' && item.payload.product.id === productId)
        .first();
      if (queuedRegistration?.type === 'product_upsert') {
        await db.outbox.update(queuedRegistration.seq!, { payload: { product: updated } });
      } else {
        await enqueue(shopId, { type: 'product_update', payload: { productId, changes } });
      }
      return { product: updated };
    })
  );

  if (outcome.product) emitDataChanged('local');
  return outcome;
}

/**
 * Archives (hides) or restores a product. Its sales, batches and movements are kept; open expiry
 * alerts are closed, matching the server.
 */
export async function setProductArchived(
  productId: string,
  archived: boolean,
  shopId: string
): Promise<ProductEditOutcome> {
  if (!(await canEditProducts(shopId))) return FORBIDDEN;

  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.products, db.expiryAlerts, db.outbox, async (): Promise<ProductEditOutcome> => {
      const product = await db.products.get(productId);
      if (!product || product.shopId !== shopId) {
        return { error: 'Product not found in this shop.', errorCode: 'not_found' };
      }
      if (isArchived(product) === archived) return { product };

      const now = new Date().toISOString();
      const updated: Product = { ...product, archivedAt: archived ? now : null, updatedAt: now };
      await db.products.put(updated);
      if (archived) {
        await db.expiryAlerts
          .where('productId')
          .equals(productId)
          .filter((a) => !a.resolvedAt)
          .modify({ resolvedAt: now, resolution: 'product_archived' });
      }
      await enqueue(shopId, { type: 'product_archive', payload: { productId, archived } });
      return { product: updated };
    })
  );

  if (outcome.product) emitDataChanged('local');
  return outcome;
}
