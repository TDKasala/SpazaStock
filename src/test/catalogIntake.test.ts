import { describe, expect, it } from 'vitest';
import { intakeItemFromHit, intakeProblems, intakeUnits, type IntakeItemDraft } from '../lib/catalogIntake';
import type { CatalogSearchHit } from '../services/catalogService';

const hit: CatalogSearchHit = {
  id: 'catalog-1',
  name: 'Maize',
  brand: null,
  category: 'groceries',
  packageSize: null,
  packageQuantity: null,
  packageUnit: null,
  imageUrl: null,
  imagePath: null,
  verificationStatus: 'verified',
  shopProductId: null,
  barcodes: [],
};

function counted(patch: Partial<IntakeItemDraft['batches'][number]> = {}): IntakeItemDraft {
  const item = intakeItemFromHit(hit);
  item.batches[0] = { ...item.batches[0], quantity: '4', expires: true, expiryDate: '2026-12-01', ...patch };
  return item;
}

describe('catalogue intake rules', () => {
  it('accepts a counted batch and a batch that does not expire', () => {
    const open = counted();
    const lasting = counted({ expires: false, expiryDate: '' });
    expect(intakeProblems([open, lasting], '2026-10-21')).toEqual([]);
    expect(intakeUnits(open)).toBe(4);
  });

  it('blocks a missing quantity, a past date, and a bad price', () => {
    const item = counted({ quantity: '', expiryDate: '2026-01-01' });
    item.sellingPrice = '-1';
    const fields = intakeProblems([item], '2026-10-21').map((problem) => problem.field);
    expect(fields).toEqual(['price', 'quantity', 'expiry']);
  });
});
