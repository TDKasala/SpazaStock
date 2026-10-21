import type {
  Product,
  ProductBarcode,
  ProductCategory,
  ProductEditInput,
  ProductRegistrationInput,
  ResolvedBarcode,
} from '../types';
import { db, withWriteLock, type CatalogSubmitPayload } from '../lib/db';
import { newId } from '../lib/ids';
import { emitDataChanged } from '../lib/events';
import { isBatchExpired, todayInZone } from '../lib/expiry';
import { can } from '../lib/permissions';
import { getShopSettings } from '../lib/shopSettings';
import { enqueue } from '../sync/outbox';

export function normalizeBarcode(barcode: string): string {
  return barcode.replace(/\s/g, '');
}

export const MAX_BARCODE_LENGTH = 64;
export const MAX_PRODUCT_NAME_LENGTH = 200;
export const MAX_BRAND_LENGTH = 80;
export const MAX_SIZE_LENGTH = 40;

export function isArchived(product: Pick<Product, 'archivedAt'>): boolean {
  return Boolean(product.archivedAt);
}

/** The active alias for a barcode in the shop; unlinked aliases are history and never match. */
export async function findActiveBarcode(barcode: string, shopId: string): Promise<ProductBarcode | null> {
  const links = await db.barcodes.where('[shopId+barcode]').equals([shopId, barcode]).toArray();
  return links.find((link) => !link.unlinkedAt) ?? null;
}

/**
 * What a scanned barcode means in this shop: the product's own barcode first, then an active
 * alias (another single-item code, or a pack or case). Archived products are found too, so
 * callers can say so instead of offering to register the barcode again.
 */
export async function resolveBarcode(barcode: string, shopId: string): Promise<ResolvedBarcode | null> {
  const normalized = normalizeBarcode(barcode);
  if (!normalized) return null;
  const own = await db.products.where('[shopId+barcode]').equals([shopId, normalized]).first();
  if (own) return { product: own, packaging: null, barcodeId: null };

  const link = await findActiveBarcode(normalized, shopId);
  if (!link) return null;
  const product = await db.products.get(link.productId);
  if (!product || product.shopId !== shopId) return null;
  if (!link.packagingId) return { product, packaging: null, barcodeId: link.id };
  const packaging = await db.packagings.get(link.packagingId);
  return packaging ? { product, packaging, barcodeId: link.id } : null;
}

/** Looks up a product by any of its barcodes in the given shop's local catalog. */
export async function searchProductByBarcode(barcode: string, shopId: string): Promise<Product | null> {
  return (await resolveBarcode(barcode, shopId))?.product ?? null;
}

/** Lower case without accents, so "Créme" matches "creme". */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export interface ProductMatch {
  product: Product;
  /** Sellable units (expired batches excluded), 0 included. */
  totalQuantity: number;
}

/**
 * Products whose name, brand or size contain every word of `query`, for choosing a product by
 * hand. It only suggests: nothing is ever linked or merged without the user confirming.
 */
export async function findProducts(
  query: string,
  shopId: string,
  options: { category?: ProductCategory | null; limit?: number } = {}
): Promise<ProductMatch[]> {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  const [products, batches, settings] = await Promise.all([
    getProducts(shopId),
    db.batches.where('shopId').equals(shopId).toArray(),
    getShopSettings(shopId),
  ]);
  const today = todayInZone(settings.timezone);
  const stock = new Map<string, number>();
  for (const batch of batches) {
    if (batch.quantity <= 0 || isBatchExpired(batch, today)) continue;
    stock.set(batch.productId, (stock.get(batch.productId) ?? 0) + batch.quantity);
  }

  return products
    .filter((product) => !options.category || product.category === options.category)
    .filter((product) => {
      const text = foldText([product.name, product.brand ?? '', product.size ?? ''].join(' '));
      return words.every((word) => text.includes(word));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, options.limit ?? 50)
    .map((product) => ({ product, totalQuantity: stock.get(product.id) ?? 0 }));
}

function optionalText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function detailsError(input: { brand?: string | null; size?: string | null }): string | null {
  if ((optionalText(input.brand)?.length ?? 0) > MAX_BRAND_LENGTH) return 'Brand is too long (up to 80 characters).';
  if ((optionalText(input.size)?.length ?? 0) > MAX_SIZE_LENGTH) return 'Size is too long (up to 40 characters).';
  return null;
}

export async function getProductById(productId: string, shopId: string): Promise<Product | null> {
  const product = await db.products.get(productId);
  return product && product.shopId === shopId ? product : null;
}

/** Products in the shop, newest first. Archived products are left out unless asked for. */
export async function getProducts(shopId: string, options: { includeArchived?: boolean } = {}): Promise<Product[]> {
  const products = await db.products.where('[shopId+createdAt]').between([shopId, ''], [shopId, '\uffff']).toArray();
  const visible = options.includeArchived
    ? products
    : products.filter((p) => !isArchived(p) && p.listed !== false);
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
  shopId: string,
  catalog?: Omit<CatalogSubmitPayload, 'productId'> | null
): Promise<{ product?: Product; error?: string; isDuplicate?: boolean }> {
  const barcode = normalizeBarcode(input.barcode);
  const name = input.name.trim();

  if (!barcode) return { error: 'Barcode is required.' };
  if (!name) return { error: 'Product name is required.' };
  const invalid = detailsError(input);
  if (invalid) return { error: invalid };

  const result = await withWriteLock(() =>
    db.transaction('rw', [db.products, db.packagings, db.barcodes, db.outbox], async () => {
      const existing = await resolveBarcode(barcode, shopId);
      if (existing) {
        return {
          error: `A product with barcode "${barcode}" already exists ("${existing.product.name}").`,
          isDuplicate: true,
          product: existing.product,
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
        brand: optionalText(input.brand),
        size: optionalText(input.size),
      };

      await db.products.add(product);
      await enqueue(shopId, { type: 'product_upsert', payload: { product } });
      if (catalog) {
        await enqueue(shopId, { type: 'catalog_submit', payload: { ...catalog, productId: product.id } });
      }
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
    // Left out when the caller did not include them, so the current values are kept.
    ...(input.brand !== undefined ? { brand: optionalText(input.brand) } : {}),
    ...(input.size !== undefined ? { size: optionalText(input.size) } : {}),
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
  const invalid = detailsError(changes);
  if (invalid) return { error: invalid, errorCode: 'invalid' };

  const outcome = await withWriteLock(() =>
    db.transaction(
      'rw',
      [db.products, db.packagings, db.barcodes, db.outbox],
      async (): Promise<ProductEditOutcome> => {
        const product = await db.products.get(productId);
        if (!product || product.shopId !== shopId) {
          return { error: 'Product not found in this shop.', errorCode: 'not_found' };
        }
        const resolved = await resolveBarcode(changes.barcode, shopId);
        // A product's own alias is still "another" use: the barcode means one thing per shop.
        const conflict =
          resolved && (resolved.barcodeId !== null || resolved.product.id !== productId) ? resolved.product : null;
        if (conflict) {
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
      }
    )
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

/** Sets or clears the low-stock minimum, in sellable base units. Blank (null) turns the alert off. */
export async function setProductMinStock(
  productId: string,
  minStockUnits: number | null,
  shopId: string
): Promise<ProductEditOutcome> {
  if (!(await canEditProducts(shopId))) return FORBIDDEN;
  if (minStockUnits !== null && (!Number.isInteger(minStockUnits) || minStockUnits < 0)) {
    return { error: 'Minimum stock must be a whole number.', errorCode: 'invalid' };
  }

  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.products, db.outbox, async (): Promise<ProductEditOutcome> => {
      const product = await db.products.get(productId);
      if (!product || product.shopId !== shopId) {
        return { error: 'Product not found in this shop.', errorCode: 'not_found' };
      }
      if (
        minStockUnits !== null &&
        product.targetStockUnits != null &&
        minStockUnits > product.targetStockUnits
      ) {
        return { error: 'Target stock must be at least the minimum.', errorCode: 'invalid' };
      }
      if ((product.minStockUnits ?? null) === minStockUnits) return { product };
      const updated: Product = { ...product, minStockUnits, updatedAt: new Date().toISOString() };
      await db.products.put(updated);
      await enqueue(shopId, { type: 'product_min_stock', payload: { productId, minStockUnits } });
      return { product: updated };
    })
  );

  if (outcome.product) emitDataChanged('local');
  return outcome;
}

/** Sets or clears the wholesale target, in sellable base units. Blank (null) means no target. */
export async function setProductTargetStock(
  productId: string,
  targetStockUnits: number | null,
  shopId: string
): Promise<ProductEditOutcome> {
  if (!(await canEditProducts(shopId))) return FORBIDDEN;
  if (targetStockUnits !== null && (!Number.isInteger(targetStockUnits) || targetStockUnits < 0)) {
    return { error: 'Target stock must be a whole number.', errorCode: 'invalid' };
  }

  const outcome = await withWriteLock(() =>
    db.transaction('rw', db.products, db.outbox, async (): Promise<ProductEditOutcome> => {
      const product = await db.products.get(productId);
      if (!product || product.shopId !== shopId) {
        return { error: 'Product not found in this shop.', errorCode: 'not_found' };
      }
      if (
        targetStockUnits !== null &&
        product.minStockUnits != null &&
        targetStockUnits < product.minStockUnits
      ) {
        return { error: 'Target stock must be at least the minimum.', errorCode: 'invalid' };
      }
      if ((product.targetStockUnits ?? null) === targetStockUnits) return { product };
      const updated: Product = { ...product, targetStockUnits, updatedAt: new Date().toISOString() };
      await db.products.put(updated);
      await enqueue(shopId, { type: 'product_target_stock', payload: { productId, targetStockUnits } });
      return { product: updated };
    })
  );

  if (outcome.product) emitDataChanged('local');
  return outcome;
}
