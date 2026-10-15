import type { Product, ProductPackaging, SaleResult } from '../types';
import { newId } from '../lib/ids';
import { createSerialQueue, type SerialQueue } from '../lib/serialQueue';
import { isArchived, resolveBarcode } from './productService';
import { recordSale, voidSale, type VoidSaleResult } from './salesService';

/** Staff may undo their own sales for this long; the server enforces the same limit. */
export const UNDO_WINDOW_MS = 15 * 60 * 1000;

export type ScanSellOutcome =
  /** `packaging` is set when a pack or case barcode sold the whole package. */
  | { kind: 'sold'; result: SaleResult; packaging?: ProductPackaging | null }
  | { kind: 'duplicate' }
  | { kind: 'unknown_barcode'; barcode: string }
  | { kind: 'archived'; product: Product }
  | { kind: 'insufficient_stock'; product: Product; available: number; expired: number }
  | { kind: 'error'; message: string };

export type ScanVoidOutcome =
  | { kind: 'voided'; result: VoidSaleResult }
  | { kind: 'duplicate' }
  | { kind: 'over_void'; available: number }
  | { kind: 'error'; message: string };

/**
 * The rapid-sell core, independent of React. Every operation goes through one serial queue so
 * scans are recorded strictly in arrival order and none is dropped while another is in flight.
 * Idempotency keys are minted when the action happens (not when it runs), so a retried action
 * reuses its key and can never be recorded twice.
 */
export interface ScanSeller {
  /** Sells one unit, or a whole package when the barcode is on a pack or case. */
  scan(barcode: string, idempotencyKey?: string): Promise<ScanSellOutcome>;
  sell(product: Product, quantity: number, idempotencyKey?: string): Promise<ScanSellOutcome>;
  void(saleId: string, quantity: number, idempotencyKey?: string): Promise<ScanVoidOutcome>;
  /** Operations queued or running. */
  readonly pending: number;
}

export function createScanSeller(shopId: string, queue: SerialQueue = createSerialQueue()): ScanSeller {
  const sellNow = async (product: Product, quantity: number, key: string): Promise<ScanSellOutcome> => {
    const outcome = await recordSale({ productId: product.id, quantity, idempotencyKey: key }, shopId);
    if (outcome.result) return { kind: 'sold', result: outcome.result };
    switch (outcome.errorCode) {
      case 'duplicate':
        return { kind: 'duplicate' };
      case 'insufficient_stock':
        return {
          kind: 'insufficient_stock',
          product,
          available: outcome.available ?? 0,
          expired: outcome.expired ?? 0,
        };
      default:
        return { kind: 'error', message: outcome.error ?? 'Sale failed.' };
    }
  };

  return {
    scan(barcode, idempotencyKey = newId()) {
      const clean = barcode.trim();
      return queue.run(async (): Promise<ScanSellOutcome> => {
        if (!clean) return { kind: 'error', message: 'Empty barcode.' };
        const resolved = await resolveBarcode(clean, shopId);
        if (!resolved) return { kind: 'unknown_barcode', barcode: clean };
        const { product, packaging } = resolved;
        if (isArchived(product)) return { kind: 'archived', product };
        // A pack or case barcode sells the whole package at the unit price per unit.
        const outcome = await sellNow(product, packaging?.unitsPerPackage ?? 1, idempotencyKey);
        return outcome.kind === 'sold' && packaging ? { ...outcome, packaging } : outcome;
      });
    },

    sell(product, quantity, idempotencyKey = newId()) {
      return queue.run(() => sellNow(product, quantity, idempotencyKey));
    },

    void(saleId, quantity, idempotencyKey = newId()) {
      return queue.run(async (): Promise<ScanVoidOutcome> => {
        const outcome = await voidSale({ saleId, quantity, idempotencyKey }, shopId);
        if (outcome.result) return { kind: 'voided', result: outcome.result };
        switch (outcome.errorCode) {
          case 'duplicate':
            return { kind: 'duplicate' };
          case 'over_void':
            return { kind: 'over_void', available: outcome.available ?? 0 };
          default:
            return { kind: 'error', message: outcome.error ?? 'Undo failed.' };
        }
      });
    },

    get pending() {
      return queue.size;
    },
  };
}
