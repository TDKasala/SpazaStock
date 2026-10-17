import React from 'react';
import { Barcode, CalendarClock, ChevronRight, Plus, Tag } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import type { ProductStockSummary } from '../../types';
import { Button } from '../ui/Button';
import { ProductThumbnail } from './ProductThumbnail';

export interface StockProductCardProps {
  summary: ProductStockSummary;
  onSelect: () => void;
  onStockIn: () => void;
}

export const StockProductCard: React.FC<StockProductCardProps> = ({ summary, onSelect, onStockIn }) => {
  const { t, dict } = useLanguage();
  const { product, totalQuantity, expiredQuantity, earliestExpiry, isExpired, isExpiringSoon } = summary;
  const categoryLabel = dict.product.categories[product.category] ?? product.category;
  const size = product.size?.trim() || null;

  const expiryTone = isExpired
    ? 'text-rose-300'
    : isExpiringSoon
      ? 'text-amber-300'
      : 'text-zinc-400';

  return (
    <div className="p-3.5 bg-zinc-950 hover:bg-zinc-900/90 rounded-2xl border border-zinc-800/80 hover:border-zinc-700 transition-all shadow-sm flex flex-col gap-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[9px] text-zinc-500 uppercase tracking-wide font-medium leading-none">
          {t('stock.available')}
        </span>
        <span
          className={`text-xl font-extrabold leading-none tabular-nums ${
            totalQuantity > 0 ? 'text-emerald-400' : 'text-zinc-500'
          }`}
        >
          {totalQuantity}
        </span>
        <span className="text-[10px] text-zinc-500 leading-none">{t('stockIn.units')}</span>
        {expiredQuantity > 0 && (
          <span className="text-[10px] font-semibold text-rose-300">
            {t('expiry.expiredUnits', { count: expiredQuantity })}
          </span>
        )}
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        className="flex items-start gap-3 cursor-pointer select-none min-w-0"
      >
        <ProductThumbnail path={product.imagePath} size="md" alt={product.name} className="mt-0.5" />

        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <h4 className="text-base font-bold text-zinc-100 leading-snug line-clamp-2">{product.name}</h4>

          {(size || categoryLabel) && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {size && (
                <span className="inline-flex items-center gap-1 max-w-full px-1.5 py-0.5 rounded-md bg-zinc-900 text-[10px] font-medium text-zinc-400 border border-zinc-800">
                  <Tag className="w-2.5 h-2.5 text-zinc-500 shrink-0" aria-hidden />
                  <span className="truncate">{size}</span>
                </span>
              )}
              <span className="inline-flex items-center gap-1 max-w-full px-1.5 py-0.5 rounded-md bg-zinc-900/80 text-[10px] font-medium text-zinc-500 border border-zinc-800/80">
                <Tag className="w-2.5 h-2.5 text-zinc-600 shrink-0" aria-hidden />
                <span className="truncate">{categoryLabel}</span>
              </span>
            </div>
          )}

          <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1">
            <span className="inline-flex items-start gap-1.5 min-w-0 text-xs text-zinc-300 font-mono">
              <Barcode className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-0.5" aria-hidden />
              <span className="break-all">{product.barcode}</span>
            </span>
            {earliestExpiry && (
              <span className={`inline-flex items-center gap-1.5 min-w-0 text-xs font-medium ${expiryTone}`}>
                <CalendarClock className="w-3.5 h-3.5 shrink-0 opacity-80" aria-hidden />
                <span>
                  {t('stock.expiresOn', { date: earliestExpiry })}
                  {isExpired ? ` (${t('stock.expiredTag')})` : ''}
                  {isExpiringSoon && !isExpired ? ` (${t('stock.soonTag')})` : ''}
                </span>
              </span>
            )}
          </div>
        </div>

        <ChevronRight className="w-4 h-4 text-zinc-600 mt-1 shrink-0" aria-hidden />
      </div>

      <div className="flex items-center justify-end">
        <Button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onStockIn();
          }}
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs text-emerald-400 border-emerald-700/70 hover:bg-emerald-950/50 hover:text-emerald-300 hover:border-emerald-600"
          leftIcon={<Plus className="w-3.5 h-3.5" />}
        >
          {t('stock.stockIn')}
        </Button>
      </div>
    </div>
  );
};
