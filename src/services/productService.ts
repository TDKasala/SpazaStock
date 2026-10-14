import { Product, ProductRegistrationInput } from '../types';
import { db, withWriteLock } from '../lib/db';
import { newId } from '../lib/ids';
import { emitDataChanged } from '../lib/events';
import { enqueue } from '../sync/outbox';

export function normalizeBarcode(barcode: string): string {
  return barcode.replace(/\s/g, '');
}

/** Looks up a product by barcode in the given shop's local catalog. */
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

/** All products in the shop, newest first. */
export async function getProducts(shopId: string): Promise<Product[]> {
  const products = await db.products
    .where('[shopId+createdAt]')
    .between([shopId, ''], [shopId, '\uffff'])
    .toArray();
  return products.reverse();
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
      };

      await db.products.add(product);
      await enqueue(shopId, { type: 'product_upsert', payload: { product } });
      return { product };
    })
  );

  if (!result.isDuplicate) emitDataChanged('local');
  return result;
}
