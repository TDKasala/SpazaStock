import type { Product, ProductBarcode, ProductPackaging, StockBatch } from '../types';
import { db, withWriteLock } from '../lib/db';
import { newId } from '../lib/ids';
import { emitDataChanged } from '../lib/events';
import { can } from '../lib/permissions';
import { getShopSettings } from '../lib/shopSettings';
import { enqueue } from '../sync/outbox';
import { MAX_BARCODE_LENGTH, normalizeBarcode, resolveBarcode } from './productService';

/**
 * Packagings (a pack of 6, a case of 24) and extra barcodes for products. Every link comes from
 * an explicit confirmation by an owner or manager; nothing is matched or merged automatically.
 * The server enforces the same rules (link_product_barcode and friends) and has the final say.
 */

export const MAX_PACKAGING_NAME_LENGTH = 40;
export const MIN_UNITS_PER_PACKAGE = 2;
export const MAX_UNITS_PER_PACKAGE = 10_000;
export const MAX_UNLINK_REASON_LENGTH = 200;
export const PACKAGING_RETIRED_REASON = 'Packaging retired';

export type BarcodeLinkErrorCode = 'forbidden' | 'invalid' | 'not_found' | 'duplicate' | 'retired';

export interface BarcodeLinkError {
  error: string;
  errorCode: BarcodeLinkErrorCode;
  /** The product that already uses the barcode, for a 'duplicate' error. */
  conflict?: Product;
}

const FORBIDDEN: BarcodeLinkError = {
  error: 'Only an owner or manager can link barcodes and packagings.',
  errorCode: 'forbidden',
};

async function canEditProducts(shopId: string): Promise<boolean> {
  return can((await getShopSettings(shopId)).role, 'products.edit');
}

/** The product's packagings, smallest first. Retired ones are left out unless asked for. */
export async function getPackagings(
  productId: string,
  shopId: string,
  options: { includeRetired?: boolean } = {}
): Promise<ProductPackaging[]> {
  const rows = await db.packagings.where('[shopId+productId]').equals([shopId, productId]).toArray();
  return rows
    .filter((p) => options.includeRetired || !p.retiredAt)
    .sort((a, b) => a.unitsPerPackage - b.unitsPerPackage || a.name.localeCompare(b.name));
}

/** The product's extra barcodes, newest first. Unlinked ones are left out unless asked for. */
export async function getProductBarcodes(
  productId: string,
  shopId: string,
  options: { includeUnlinked?: boolean } = {}
): Promise<ProductBarcode[]> {
  const rows = await db.barcodes.where('productId').equals(productId).toArray();
  return rows
    .filter((b) => b.shopId === shopId && (options.includeUnlinked || !b.unlinkedAt))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface PackagingInput {
  productId: string;
  name: string;
  unitsPerPackage: number;
}

export function validatePackagingInput(input: Pick<PackagingInput, 'name' | 'unitsPerPackage'>): string | null {
  const name = input.name.trim();
  if (!name || name.length > MAX_PACKAGING_NAME_LENGTH) return 'Packaging name is required (up to 40 characters).';
  const units = input.unitsPerPackage;
  if (!Number.isInteger(units) || units < MIN_UNITS_PER_PACKAGE || units > MAX_UNITS_PER_PACKAGE) {
    return 'A packaging holds 2 to 10,000 units.';
  }
  return null;
}

/**
 * Adds a packaging to a product. An active packaging with the same name and size is reused, so
 * confirming "Case of 24" twice does not create two cases.
 */
export async function createPackaging(
  input: PackagingInput,
  shopId: string
): Promise<{ packaging?: ProductPackaging } & Partial<BarcodeLinkError>> {
  if (!(await canEditProducts(shopId))) return FORBIDDEN;
  const invalid = validatePackagingInput(input);
  if (invalid) return { error: invalid, errorCode: 'invalid' };
  const name = input.name.trim();

  const outcome = await withWriteLock(() =>
    db.transaction(
      'rw',
      [db.products, db.packagings, db.outbox],
      async (): Promise<{ packaging?: ProductPackaging; reused?: boolean } & Partial<BarcodeLinkError>> => {
        const product = await db.products.get(input.productId);
        if (!product || product.shopId !== shopId) {
          return { error: 'Product not found in this shop.', errorCode: 'not_found' };
        }
        const existing = (await getPackagings(input.productId, shopId)).find(
          (p) => p.unitsPerPackage === input.unitsPerPackage && p.name.toLowerCase() === name.toLowerCase()
        );
        if (existing) return { packaging: existing, reused: true };

        const now = new Date().toISOString();
        const packaging: ProductPackaging = {
          id: newId(),
          shopId,
          productId: input.productId,
          name,
          unitsPerPackage: input.unitsPerPackage,
          createdAt: now,
          updatedAt: now,
          retiredAt: null,
        };
        await db.packagings.add(packaging);
        await enqueue(shopId, { type: 'packaging_create', payload: { packaging } });
        return { packaging };
      }
    )
  );

  if (outcome.packaging && !outcome.reused) emitDataChanged('local');
  return outcome;
}

/** Hides a packaging from new deliveries and unlinks its barcodes. Past deliveries keep it. */
export async function retirePackaging(
  packagingId: string,
  shopId: string
): Promise<{ packaging?: ProductPackaging } & Partial<BarcodeLinkError>> {
  if (!(await canEditProducts(shopId))) return FORBIDDEN;

  const outcome = await withWriteLock(() =>
    db.transaction(
      'rw',
      [db.packagings, db.barcodes, db.outbox],
      async (): Promise<{ packaging?: ProductPackaging; unchanged?: boolean } & Partial<BarcodeLinkError>> => {
        const packaging = await db.packagings.get(packagingId);
        if (!packaging || packaging.shopId !== shopId) {
          return { error: 'Packaging not found in this shop.', errorCode: 'not_found' };
        }
        if (packaging.retiredAt) return { packaging, unchanged: true };

        const now = new Date().toISOString();
        const retired: ProductPackaging = { ...packaging, retiredAt: now, updatedAt: now };
        await db.packagings.put(retired);
        await db.barcodes
          .where('packagingId')
          .equals(packagingId)
          .filter((b) => !b.unlinkedAt)
          .modify({ unlinkedAt: now, unlinkReason: PACKAGING_RETIRED_REASON, updatedAt: now });
        await enqueue(shopId, { type: 'packaging_retire', payload: { packagingId } });
        return { packaging: retired };
      }
    )
  );

  if (outcome.packaging && !outcome.unchanged) emitDataChanged('local');
  return outcome;
}

export interface LinkBarcodeInput {
  productId: string;
  /** Null: the barcode is on the single item. */
  packagingId: string | null;
  barcode: string;
}

/**
 * Links a barcode to a product (and optionally one of its packagings) after the user confirmed
 * they are the same. Refuses a barcode that already means something else in this shop.
 */
export async function linkBarcode(
  input: LinkBarcodeInput,
  shopId: string
): Promise<{ link?: ProductBarcode } & Partial<BarcodeLinkError>> {
  if (!(await canEditProducts(shopId))) return FORBIDDEN;
  const barcode = normalizeBarcode(input.barcode);
  if (!barcode || barcode.length > MAX_BARCODE_LENGTH) {
    return { error: 'Barcode is required (up to 64 characters).', errorCode: 'invalid' };
  }

  const outcome = await withWriteLock(() =>
    db.transaction(
      'rw',
      [db.products, db.packagings, db.barcodes, db.outbox],
      async (): Promise<{ link?: ProductBarcode; created?: boolean } & Partial<BarcodeLinkError>> => {
        const product = await db.products.get(input.productId);
        if (!product || product.shopId !== shopId) {
          return { error: 'Product not found in this shop.', errorCode: 'not_found' };
        }
        if (input.packagingId) {
          const packaging = await db.packagings.get(input.packagingId);
          if (!packaging || packaging.shopId !== shopId || packaging.productId !== product.id) {
            return { error: 'Packaging not found for this product.', errorCode: 'not_found' };
          }
          if (packaging.retiredAt) {
            return {
              error: 'This packaging has been retired. Choose another one.',
              errorCode: 'retired',
            };
          }
        }

        const existing = await resolveBarcode(barcode, shopId);
        if (existing) {
          const sameLink =
            existing.barcodeId !== null &&
            existing.product.id === product.id &&
            (existing.packaging?.id ?? null) === (input.packagingId ?? null);
          if (sameLink) return { link: await db.barcodes.get(existing.barcodeId!) };
          return {
            error: `Barcode "${barcode}" is already used by "${existing.product.name}".`,
            errorCode: 'duplicate',
            conflict: existing.product,
          };
        }

        const now = new Date().toISOString();
        const link: ProductBarcode = {
          id: newId(),
          shopId,
          productId: product.id,
          packagingId: input.packagingId ?? null,
          barcode,
          createdAt: now,
          updatedAt: now,
          unlinkedAt: null,
          unlinkReason: null,
        };
        await db.barcodes.add(link);
        await enqueue(shopId, { type: 'barcode_link', payload: { link } });
        return { link, created: true };
      }
    )
  );

  if (outcome.created) emitDataChanged('local');
  return outcome;
}

export interface UnlinkBarcodeInput {
  barcodeId: string;
  reason: string;
  /** Also take back deliveries received through this barcode that are still completely unsold. */
  reverseUnsold: boolean;
}

export interface UnlinkBarcodeResult {
  link: ProductBarcode;
  /** Deliveries taken back out of stock. */
  reversed: StockBatch[];
  /** Deliveries left alone because some of their units were already sold. */
  kept: StockBatch[];
}

/** Batches received through a barcode that still have units, oldest first. */
export async function getBatchesReceivedThrough(barcodeId: string, shopId: string): Promise<StockBatch[]> {
  const link = await db.barcodes.get(barcodeId);
  if (!link || link.shopId !== shopId) return [];
  const batches = await db.batches.where('[shopId+productId]').equals([shopId, link.productId]).toArray();
  return batches
    .filter((b) => b.receivedBarcodeId === barcodeId && b.quantity > 0)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/**
 * Corrects a mistaken link. The link is kept as history with the reason. With `reverseUnsold`
 * (needs stock.adjust), deliveries received through it that are completely unsold are taken back
 * out; partly sold ones are left alone and returned in `kept`.
 */
export async function unlinkBarcode(
  input: UnlinkBarcodeInput,
  shopId: string
): Promise<{ result?: UnlinkBarcodeResult } & Partial<BarcodeLinkError>> {
  const { role } = await getShopSettings(shopId);
  if (!can(role, 'products.edit')) return FORBIDDEN;
  if (input.reverseUnsold && !can(role, 'stock.adjust')) {
    return { error: 'Only an owner or manager can take stock back out.', errorCode: 'forbidden' };
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > MAX_UNLINK_REASON_LENGTH) {
    return { error: 'A reason is required (up to 200 characters).', errorCode: 'invalid' };
  }

  const outcome = await withWriteLock(() =>
    db.transaction(
      'rw',
      [db.barcodes, db.batches, db.movements, db.outbox],
      async (): Promise<{ result?: UnlinkBarcodeResult } & Partial<BarcodeLinkError>> => {
        const link = await db.barcodes.get(input.barcodeId);
        if (!link || link.shopId !== shopId) {
          return { error: 'Barcode link not found in this shop.', errorCode: 'not_found' };
        }
        if (link.unlinkedAt) return { result: { link, reversed: [], kept: [] } };

        const now = new Date().toISOString();
        const unlinked: ProductBarcode = {
          ...link,
          unlinkedAt: now,
          unlinkReason: reason,
          updatedAt: now,
        };
        await db.barcodes.put(unlinked);

        const reversed: StockBatch[] = [];
        const kept: StockBatch[] = [];
        for (const batch of await getBatchesReceivedThrough(link.id, shopId)) {
          if (!input.reverseUnsold || batch.quantity !== batch.initialQuantity) {
            kept.push(batch);
            continue;
          }
          const emptied: StockBatch = { ...batch, quantity: 0 };
          await db.batches.put(emptied);
          const siblings = await db.batches.where('[shopId+productId]').equals([shopId, batch.productId]).toArray();
          await db.movements.add({
            id: newId(),
            shopId,
            productId: batch.productId,
            batchId: batch.id,
            type: 'adjustment',
            quantityDelta: -batch.quantity,
            resultingTotalQuantity: siblings.reduce((sum, b) => sum + b.quantity, 0),
            idempotencyKey: `unlink:${link.id}:${batch.id}`,
            createdAt: now,
          });
          reversed.push(batch);
        }

        await enqueue(shopId, {
          type: 'barcode_unlink',
          payload: {
            barcodeId: link.id,
            reason,
            reverseUnsold: input.reverseUnsold,
            occurredAt: now,
          },
        });
        return { result: { link: unlinked, reversed, kept } };
      }
    )
  );

  if (outcome.result) emitDataChanged('local');
  return outcome;
}
