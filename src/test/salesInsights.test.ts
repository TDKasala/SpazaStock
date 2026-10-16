import { describe, it, expect } from 'vitest';
import { rankSales, type SaleForInsight } from '../lib/salesInsights';

const NOW = new Date('2026-10-16T10:00:00+02:00');
const ZONE = 'Africa/Johannesburg';

function sale(partial: Partial<SaleForInsight> & Pick<SaleForInsight, 'productId' | 'createdAt'>): SaleForInsight {
  const quantity = partial.quantity ?? 2;
  return {
    productId: partial.productId,
    quantity,
    unitPrice: partial.unitPrice ?? 10,
    totalAmount: partial.totalAmount ?? quantity * (partial.unitPrice ?? 10),
    voidedQuantity: partial.voidedQuantity,
    allocations: partial.allocations ?? [{ batchId: 'batch', quantityDeducted: quantity, batchExpiryDate: null }],
    createdAt: partial.createdAt,
  };
}

describe('rankSales', () => {
  it('ranks by units, revenue and sales, and drops fully voided lines', () => {
    const ranking = rankSales(
      [
        sale({ productId: 'bread', createdAt: '2026-10-16T08:00:00+02:00', quantity: 4, unitPrice: 10 }),
        sale({ productId: 'milk', createdAt: '2026-10-15T08:00:00+02:00', quantity: 1, unitPrice: 50 }),
        sale({
          productId: 'coke',
          createdAt: '2026-10-14T08:00:00+02:00',
          quantity: 3,
          voidedQuantity: 3,
        }),
        sale({ productId: 'bread', createdAt: '2026-10-05T08:00:00+02:00', quantity: 9 }),
      ],
      [{ id: 'batch', costPricePerUnit: 4 }],
      { period: 'week', measure: 'units', timezone: ZONE, now: NOW }
    );

    expect(ranking.empty).toBe(false);
    expect(ranking.products.map((row) => row.productId)).toEqual(['bread', 'milk']);
    expect(ranking.products[0]).toMatchObject({ units: 4, transactions: 1, revenue: 40, grossProfit: 24, trend: 'down' });
    expect(ranking.products[1]).toMatchObject({ units: 1, transactions: 1, revenue: 50, grossProfit: 46, trend: 'up' });

    const byRevenue = rankSales(
      [
        sale({ productId: 'bread', createdAt: '2026-10-16T08:00:00+02:00', quantity: 4, unitPrice: 10 }),
        sale({ productId: 'milk', createdAt: '2026-10-15T08:00:00+02:00', quantity: 1, unitPrice: 50 }),
        sale({ productId: 'bread', createdAt: '2026-09-01T08:00:00+02:00', quantity: 1 }),
      ],
      [{ id: 'batch', costPricePerUnit: 4 }],
      { period: 'week', measure: 'revenue', timezone: ZONE, now: NOW }
    );
    expect(byRevenue.products.map((row) => row.productId)).toEqual(['milk', 'bread']);
  });

  it('omits profit when a sold unit has no batch cost, and does not invent one', () => {
    const ranking = rankSales(
      [sale({ productId: 'bread', createdAt: '2026-10-16T08:00:00+02:00', quantity: 2 })],
      [{ id: 'batch', costPricePerUnit: null }],
      { period: 'day', measure: 'units', timezone: ZONE, now: NOW }
    );
    expect(ranking.products[0]?.grossProfit).toBeNull();
  });

  it('omits profit when some units were never taken from a batch', () => {
    const ranking = rankSales(
      [
        sale({
          productId: 'bread',
          createdAt: '2026-10-16T08:00:00+02:00',
          quantity: 4,
          allocations: [{ batchId: 'batch', quantityDeducted: 3, batchExpiryDate: null }],
        }),
      ],
      [{ id: 'batch', costPricePerUnit: 4 }],
      { period: 'day', measure: 'units', timezone: ZONE, now: NOW }
    );
    expect(ranking.products[0]).toMatchObject({ units: 4, grossProfit: null });
  });

  it('subtracts voided units from the count, the revenue and the cost', () => {
    const ranking = rankSales(
      [
        sale({
          productId: 'bread',
          createdAt: '2026-10-16T08:00:00+02:00',
          quantity: 4,
          unitPrice: 10,
          totalAmount: 40,
          voidedQuantity: 1,
        }),
        sale({ productId: 'bread', createdAt: '2026-09-01T08:00:00+02:00', quantity: 1 }),
      ],
      [{ id: 'batch', costPricePerUnit: 4 }],
      { period: 'day', measure: 'units', timezone: ZONE, now: NOW }
    );
    expect(ranking.products[0]).toMatchObject({ units: 3, revenue: 30, grossProfit: 18 });
  });

  it('says when the period is empty and when there is no earlier history', () => {
    const empty = rankSales([], [], { period: 'month', measure: 'transactions', timezone: ZONE, now: NOW });
    expect(empty.empty).toBe(true);
    expect(empty.products).toEqual([]);

    const firstWeek = rankSales(
      [sale({ productId: 'bread', createdAt: '2026-10-16T08:00:00+02:00', quantity: 2 })],
      [{ id: 'batch', costPricePerUnit: 4 }],
      { period: 'week', measure: 'units', timezone: ZONE, now: NOW }
    );
    expect(firstWeek.products[0]?.trend).toBe('insufficient');
  });
});
