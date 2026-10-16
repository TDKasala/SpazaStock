import React, { useMemo, useState } from 'react';
import { TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { rankSales, type InsightMeasure, type InsightPeriod, type InsightTrend } from '../../lib/salesInsights';
import type { LowStockItem } from '../../lib/lowStock';
import type { Product, Sale, StockBatch } from '../../types';

export interface StockIntelligenceCardProps {
  lowStock: LowStockItem[];
  products: Product[];
  sales: Sale[];
  batches: StockBatch[];
  timezone: string;
  isLoading: boolean;
  onOpenAlerts: () => void;
}

const PERIODS: InsightPeriod[] = ['day', 'week', 'month'];
const MEASURES: InsightMeasure[] = ['units', 'transactions', 'revenue'];

function money(amount: number): string {
  return amount.toFixed(2);
}

export const StockIntelligenceCard: React.FC<StockIntelligenceCardProps> = ({
  lowStock,
  products,
  sales,
  batches,
  timezone,
  isLoading,
  onOpenAlerts,
}) => {
  const { t } = useLanguage();
  const [period, setPeriod] = useState<InsightPeriod>('week');
  const [measure, setMeasure] = useState<InsightMeasure>('units');
  const names = useMemo(() => new Map(products.map((product) => [product.id, product.name])), [products]);

  const ranking = useMemo(
    () => rankSales(sales, batches, { period, measure, timezone, limit: 3 }),
    [sales, batches, period, measure, timezone]
  );

  const periodLabel: Record<InsightPeriod, string> = {
    day: t('intelligence.periodDay'),
    week: t('intelligence.periodWeek'),
    month: t('intelligence.periodMonth'),
  };
  const measureLabel: Record<InsightMeasure, string> = {
    units: t('intelligence.measureUnits'),
    transactions: t('intelligence.measureTransactions'),
    revenue: t('intelligence.measureRevenue'),
  };

  return (
    <section className="p-4 rounded-2xl bg-zinc-900 border border-zinc-800 space-y-3">
      <h3 className="text-sm font-bold text-zinc-100">{t('intelligence.title')}</h3>

      <button
        type="button"
        onClick={onOpenAlerts}
        className="w-full text-left rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 active:scale-[0.99]"
      >
        <p className="text-sm font-semibold text-amber-100">
          {isLoading ? t('common.loading') : t('intelligence.lowStockCount', { count: lowStock.length })}
        </p>
        <p className="text-[11px] text-zinc-400 mt-0.5">{t('intelligence.lowStockHint')}</p>
      </button>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">{t('intelligence.topSellers')}</h4>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setPeriod(value)}
              className={`text-[11px] font-medium px-2.5 py-1 rounded-lg border ${
                period === value
                  ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40'
                  : 'bg-zinc-950 text-zinc-400 border-zinc-800'
              }`}
            >
              {periodLabel[value]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {MEASURES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setMeasure(value)}
              className={`text-[11px] font-medium px-2.5 py-1 rounded-lg border ${
                measure === value
                  ? 'bg-zinc-100 text-zinc-950 border-zinc-100'
                  : 'bg-zinc-950 text-zinc-400 border-zinc-800'
              }`}
            >
              {measureLabel[value]}
            </button>
          ))}
        </div>

        {ranking.empty ? (
          <p className="text-xs text-zinc-400">{t('intelligence.noSales')}</p>
        ) : (
          <ul className="space-y-2">
            {ranking.products.map((row) => (
              <li key={row.productId} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-zinc-100 truncate">
                    {names.get(row.productId) ?? row.productId}
                  </p>
                  <p className="text-[11px] text-zinc-400">
                    {t('intelligence.units', { count: row.units })}
                    {' · '}
                    {t('intelligence.transactions', { count: row.transactions })}
                    {' · '}
                    {t('intelligence.revenue', { amount: money(row.revenue) })}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {row.grossProfit == null
                      ? t('intelligence.profitMissing')
                      : t('intelligence.profit', { amount: money(row.grossProfit) })}
                  </p>
                </div>
                <Trend trend={row.trend} label={trendLabel(row.trend, t)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};

function trendLabel(trend: InsightTrend, t: (key: string) => string): string {
  if (trend === 'up') return t('intelligence.trendUp');
  if (trend === 'down') return t('intelligence.trendDown');
  if (trend === 'flat') return t('intelligence.trendFlat');
  return t('intelligence.notEnoughHistory');
}

const Trend: React.FC<{ trend: InsightTrend; label: string }> = ({ trend, label }) => {
  const Icon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;
  const color =
    trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-rose-300' : 'text-zinc-500';
  return (
    <span className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-medium ${color}`}>
      {trend !== 'insufficient' && <Icon className="w-3.5 h-3.5" />}
      {label}
    </span>
  );
};
