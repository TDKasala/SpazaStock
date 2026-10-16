import { describe, expect, it } from 'vitest';
import { packSaleCharge } from '../lib/packPrice';

const box = { unitsPerPackage: 20, sellingPrice: 180 };

describe('pack sale charge', () => {
  it('charges whole packs at the pack price and one leftover unit at the unit price', () => {
    expect(packSaleCharge(21, 10, box)).toEqual({ total: 190, unitPrice: 9.05 });
  });

  it('charges only the pack price when the quantity is exact packs', () => {
    expect(packSaleCharge(40, 10, box)).toEqual({ total: 360, unitPrice: 9 });
  });

  it('uses the product price for every unit when the pack has no price', () => {
    expect(packSaleCharge(21, 10, { unitsPerPackage: 20, sellingPrice: null })).toEqual({
      total: 210,
      unitPrice: 10,
    });
  });
});
