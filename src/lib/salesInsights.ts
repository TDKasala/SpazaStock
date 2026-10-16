/**
 * Best-seller rankings from completed sale lines. Voids are removed. Profit uses the cost stored
 * on the batches that were actually sold, and is left blank when any of those units has no cost.
 */

import type { BatchAllocation, Sale, StockBatch } from '../types';
import { saleNetAmount, saleNetQuantity } from '../services/salesService';
import { todayInZone } from './expiry';

export type InsightPeriod = 'day' | 'week' | 'month';
export type InsightMeasure = 'units' | 'transactions' | 'revenue';
export type InsightTrend = 'up' | 'down' | 'flat' | 'insufficient';

export interface SaleForInsight {
  productId: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  voidedQuantity?: number;
  allocations: BatchAllocation[];
  /** `sold_at`, stored on the device as `createdAt`. */
  createdAt: string;
}

export interface RankedProduct {
  productId: string;
  units: number;
  transactions: number;
  revenue: number;
  /** Null when any remaining sold unit has no recorded batch cost. */
  grossProfit: number | null;
  trend: InsightTrend;
}

export interface SalesRanking {
  period: InsightPeriod;
  measure: InsightMeasure;
  /** Shop-local dates, inclusive. */
  from: string;
  to: string;
  /** True when the window contains no sale with units still counted. */
  empty: boolean;
  products: RankedProduct[];
}

const PERIOD_DAYS: Record<InsightPeriod, number> = { day: 1, week: 7, month: 30 };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Adds calendar days to a YYYY-MM-DD date. */
export function addIsoDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** Units of each allocation that are still sold after voids (shortfall first, then last batch). */
export function remainingAllocations(sale: Pick<SaleForInsight, 'quantity' | 'voidedQuantity' | 'allocations'>): BatchAllocation[] {
  const voided = sale.voidedQuantity ?? 0;
  const allocated = sale.allocations.reduce((sum, allocation) => sum + allocation.quantityDeducted, 0);
  const shortfall = Math.max(sale.quantity - allocated, 0);
  const voidedFromShortfall = Math.min(voided, shortfall);
  let skip = voided - voidedFromShortfall;
  const remaining: BatchAllocation[] = [];
  for (const allocation of [...sale.allocations].reverse()) {
    let available = allocation.quantityDeducted;
    const skipped = Math.min(skip, available);
    skip -= skipped;
    available -= skipped;
    if (available > 0) remaining.push({ ...allocation, quantityDeducted: available });
  }
  return remaining.reverse();
}

function lineCost(
  sale: SaleForInsight,
  costs: Map<string, number | null>
): number | null {
  const net = saleNetQuantity(sale);
  if (net <= 0) return 0;
  const remaining = remainingAllocations(sale);
  const remainingUnits = remaining.reduce((sum, allocation) => sum + allocation.quantityDeducted, 0);
  if (remainingUnits !== net) return null;
  let cost = 0;
  for (const allocation of remaining) {
    const unitCost = costs.get(allocation.batchId);
    if (unitCost == null) return null;
    cost += unitCost * allocation.quantityDeducted;
  }
  return roundMoney(cost);
}

interface Totals {
  units: number;
  transactions: number;
  revenue: number;
  cost: number;
  costKnown: boolean;
}

function emptyTotals(): Totals {
  return { units: 0, transactions: 0, revenue: 0, cost: 0, costKnown: true };
}

function addSale(totals: Totals, sale: SaleForInsight, costs: Map<string, number | null>): void {
  const units = saleNetQuantity(sale);
  if (units <= 0) return;
  totals.units += units;
  totals.transactions += 1;
  totals.revenue = roundMoney(totals.revenue + saleNetAmount(sale));
  const cost = lineCost(sale, costs);
  if (cost == null) totals.costKnown = false;
  else totals.cost = roundMoney(totals.cost + cost);
}

function measureOf(totals: Pick<Totals, 'units' | 'transactions' | 'revenue'>, measure: InsightMeasure): number {
  if (measure === 'units') return totals.units;
  if (measure === 'transactions') return totals.transactions;
  return totals.revenue;
}

function trendFor(current: number, previous: number, history: boolean): InsightTrend {
  if (!history) return 'insufficient';
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

/**
 * Ranks products in the shop-local window. `limit` keeps the top of the chosen measure.
 * Trend compares that measure with the previous window of the same length, and is
 * "insufficient" when the shop has no sale dated before this window.
 */
export function rankSales(
  sales: SaleForInsight[],
  batches: Pick<StockBatch, 'id' | 'costPricePerUnit'>[],
  options: {
    period: InsightPeriod;
    measure: InsightMeasure;
    timezone: string;
    now?: Date;
    limit?: number;
  }
): SalesRanking {
  const today = todayInZone(options.timezone, options.now ?? new Date());
  const length = PERIOD_DAYS[options.period];
  const from = addIsoDays(today, -(length - 1));
  const previousFrom = addIsoDays(from, -length);
  const previousTo = addIsoDays(from, -1);
  const costs = new Map(batches.map((batch) => [batch.id, batch.costPricePerUnit ?? null]));

  let earliest: string | null = null;
  const current = new Map<string, Totals>();
  const previous = new Map<string, Totals>();
  let anyCurrent = false;

  for (const sale of sales) {
    if (saleNetQuantity(sale) <= 0) continue;
    const day = todayInZone(options.timezone, new Date(sale.createdAt));
    if (!earliest || day < earliest) earliest = day;
    if (day >= from && day <= today) {
      anyCurrent = true;
      const totals = current.get(sale.productId) ?? emptyTotals();
      addSale(totals, sale, costs);
      current.set(sale.productId, totals);
    } else if (day >= previousFrom && day <= previousTo) {
      const totals = previous.get(sale.productId) ?? emptyTotals();
      addSale(totals, sale, costs);
      previous.set(sale.productId, totals);
    }
  }

  const history = earliest !== null && earliest < from;
  const products: RankedProduct[] = [...current.entries()].map(([productId, totals]) => {
    const before = previous.get(productId) ?? emptyTotals();
    return {
      productId,
      units: totals.units,
      transactions: totals.transactions,
      revenue: totals.revenue,
      grossProfit: totals.costKnown ? roundMoney(totals.revenue - totals.cost) : null,
      trend: trendFor(measureOf(totals, options.measure), measureOf(before, options.measure), history),
    };
  });

  products.sort(
    (a, b) => measureOf(b, options.measure) - measureOf(a, options.measure) || b.units - a.units || a.productId.localeCompare(b.productId)
  );

  return {
    period: options.period,
    measure: options.measure,
    from,
    to: today,
    empty: !anyCurrent,
    products: products.slice(0, options.limit ?? products.length),
  };
}

/** Sale rows already use the fields the ranking needs. */
export function salesForInsights(sales: Sale[]): SaleForInsight[] {
  return sales;
}
