import { describe, expect, it } from 'vitest';
import { whatsappShareUrl } from '../lib/invite';
import { lineTotal, orderSummaryText, orderTotal, suggestedOrderLines } from '../lib/wholesaleOrders';

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

  it('leaves a blank cost out of the total and encodes an ampersand for WhatsApp', () => {
    expect(lineTotal(4, null)).toBeNull();
    expect(lineTotal(4, 12.5)).toBe(50);
    expect(orderTotal([{ quantity: 4, unitCost: null }])).toBeNull();
    expect(orderTotal([{ quantity: 4, unitCost: null }, { quantity: 2, unitCost: 1 }])).toBe(2);
    const text = orderSummaryText(
      'Fish & Chips',
      [{ name: 'Bread', quantity: 4, unitCost: 12.5, purchased: true }],
      { purchased: 'Purchased', total: 'Estimated total' }
    );
    expect(text).toContain('Bread · 4 × R 12.50 = R 50.00 · Purchased');
    expect(text).toContain('Estimated total: R 50.00');
    expect(whatsappShareUrl(text)).toBe(`https://wa.me/?text=${encodeURIComponent(text)}`);
    expect(whatsappShareUrl(text)).toContain('Fish%20%26%20Chips');
  });
});
