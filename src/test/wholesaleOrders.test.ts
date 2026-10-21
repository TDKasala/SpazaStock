import { describe, expect, it } from 'vitest';
import { suggestedOrderLines } from '../lib/wholesaleOrders';

describe('suggested wholesale lines', () => {
  const bread = { id: 'bread', name: 'Bread', minStockUnits: 5, targetStockUnits: 12, sellable: 2, archivedAt: null };
  const milk = { id: 'milk', name: 'Milk', minStockUnits: 4, targetStockUnits: null, sellable: 4, archivedAt: null };
  const coke = { id: 'coke', name: 'Coke', minStockUnits: 2, targetStockUnits: 1, sellable: 3, archivedAt: null };
  const rice = { id: 'rice', name: 'Rice', minStockUnits: null, targetStockUnits: 8, sellable: 0, archivedAt: null };
  const old = { id: 'old', name: 'Old', minStockUnits: 1, targetStockUnits: 4, sellable: 0, archivedAt: '2026-01-01' };

  it('suggests products at the minimum and never a negative quantity', () => {
    expect(suggestedOrderLines([bread, milk, coke, rice, old])).toEqual([
      { productId: 'bread', name: 'Bread', sellable: 2, minimum: 5, target: 12, quantity: 10 },
      { productId: 'milk', name: 'Milk', sellable: 4, minimum: 4, target: null, quantity: 0 },
    ]);
  });
});
