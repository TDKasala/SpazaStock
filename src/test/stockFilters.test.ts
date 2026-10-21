import { describe, expect, it } from 'vitest';
import { categoryFacets, conditionFacets, productMatchesQuery } from '../lib/stockFilters';
import type { Product, ProductCategory, ProductStockSummary } from '../types';

function summary(
  name: string,
  category: ProductCategory,
  quantity: number,
  extras: { barcode?: string; min?: number | null; expired?: boolean; soon?: boolean } = {}
): ProductStockSummary {
  const product: Product = {
    id: name,
    shopId: 'shop',
    barcode: extras.barcode ?? name,
    name,
    category,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    minStockUnits: extras.min ?? null,
  };
  return {
    product,
    totalQuantity: quantity,
    expiredQuantity: extras.expired ? 1 : 0,
    batches: [],
    earliestExpiry: extras.expired || extras.soon ? '2026-10-22' : null,
    isExpired: extras.expired ?? false,
    isExpiringSoon: extras.soon ?? false,
  };
}

describe('stock list filters', () => {
  const items = [
    summary('Bread', 'bakery', 4),
    summary('Coke', 'beverages', 0, { barcode: '5449000000996' }),
    summary('Fanta', 'beverages', 1, { min: 3 }),
    summary('Milk', 'dairy', 2, { soon: true, min: 1 }),
  ];

  it('puts the fullest category first and keeps a selected empty category', () => {
    expect(categoryFacets(items, '', null, null).map((facet) => facet.category)).toEqual([
      'beverages',
      'bakery',
      'dairy',
    ]);
    const narrowed = categoryFacets(items, 'coke', null, 'bakery');
    expect(narrowed).toEqual([
      { category: 'beverages', count: 1 },
      { category: 'bakery', count: 0 },
    ]);
  });

  it('matches a name or a barcode', () => {
    expect(productMatchesQuery(items[1].product, '5449')).toBe(true);
    expect(productMatchesQuery(items[0].product, 'soap')).toBe(false);
  });

  it('offers only stock levels that change the list', () => {
    expect(conditionFacets(items, '', null, null).map((facet) => [facet.condition, facet.count])).toEqual([
      ['out', 1],
      ['low', 1],
      ['expiring', 1],
      ['in', 3],
    ]);
    expect(conditionFacets([summary('Bread', 'bakery', 4)], '', null, null)).toEqual([]);
    expect(conditionFacets(items, '', 'bakery', 'out')).toEqual([{ condition: 'out', count: 0 }]);
  });
});
