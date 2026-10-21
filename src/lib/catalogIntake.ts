import type { CatalogSearchHit } from '../services/catalogService';
import { newId } from './ids';

export const MAX_INTAKE_PRODUCTS = 40;
export const MAX_BATCHES_PER_PRODUCT = 8;

export interface IntakeBatchDraft {
  id: string;
  quantity: string;
  /** False stores a null expiry: the batch does not expire. */
  expires: boolean;
  expiryDate: string;
}

export interface IntakeItemDraft {
  hit: CatalogSearchHit;
  productId: string;
  buyingPrice: string;
  sellingPrice: string;
  batches: IntakeBatchDraft[];
}

export type IntakeStep = 'select' | 'count' | 'review';

export interface CatalogIntakeDraft {
  step: IntakeStep;
  countIndex: number;
  items: IntakeItemDraft[];
}

export type IntakeProblemField = 'quantity' | 'expiry' | 'price';

export interface IntakeProblem {
  catalogProductId: string;
  batchId?: string;
  field: IntakeProblemField;
}

export interface IntakeBatchPayload {
  id: string;
  quantity: number;
  expiry_date: string | null;
}

export interface IntakeItemPayload {
  catalog_product_id: string;
  product_id: string;
  buying_price: number | null;
  selling_price: number | null;
  batches: IntakeBatchPayload[];
}

export function emptyBatch(): IntakeBatchDraft {
  return { id: newId(), quantity: '', expires: true, expiryDate: '' };
}

export function intakeItemFromHit(hit: CatalogSearchHit): IntakeItemDraft {
  return {
    hit,
    productId: newId(),
    buyingPrice: '',
    sellingPrice: '',
    batches: [emptyBatch()],
  };
}

export function parseIntakePrice(text: string): number | null | 'invalid' {
  if (!text.trim()) return null;
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value < 0) return 'invalid';
  return Math.round(value * 100) / 100;
}

export function parseIntakeQuantity(text: string): number | 'invalid' {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const value = Number(trimmed);
  return value >= 1 && value <= 1_000_000 ? value : 'invalid';
}

/** Problems that block confirm. Dates compare as YYYY-MM-DD, which matches the shop calendar. */
export function intakeProblems(items: IntakeItemDraft[], today: string): IntakeProblem[] {
  const problems: IntakeProblem[] = [];
  for (const item of items) {
    if (parseIntakePrice(item.buyingPrice) === 'invalid' || parseIntakePrice(item.sellingPrice) === 'invalid') {
      problems.push({ catalogProductId: item.hit.id, field: 'price' });
    }
    for (const batch of item.batches) {
      if (parseIntakeQuantity(batch.quantity) === 'invalid') {
        problems.push({ catalogProductId: item.hit.id, batchId: batch.id, field: 'quantity' });
      }
      if (batch.expires && !/^\d{4}-\d{2}-\d{2}$/.test(batch.expiryDate)) {
        problems.push({ catalogProductId: item.hit.id, batchId: batch.id, field: 'expiry' });
      } else if (batch.expires && batch.expiryDate < today) {
        problems.push({ catalogProductId: item.hit.id, batchId: batch.id, field: 'expiry' });
      }
    }
  }
  return problems;
}

export function intakeUnits(item: IntakeItemDraft): number {
  return item.batches.reduce((sum, batch) => {
    const quantity = parseIntakeQuantity(batch.quantity);
    return sum + (quantity === 'invalid' ? 0 : quantity);
  }, 0);
}

export function intakePayload(items: IntakeItemDraft[]): IntakeItemPayload[] {
  return items.map((item) => ({
    catalog_product_id: item.hit.id,
    product_id: item.productId,
    buying_price: parseIntakePrice(item.buyingPrice) as number | null,
    selling_price: parseIntakePrice(item.sellingPrice) as number | null,
    batches: item.batches.map((batch) => ({
      id: batch.id,
      quantity: parseIntakeQuantity(batch.quantity) as number,
      expiry_date: batch.expires ? batch.expiryDate : null,
    })),
  }));
}
