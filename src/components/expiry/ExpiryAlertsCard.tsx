import React from 'react';
import { CalendarClock, ShieldCheck } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop } from '../../context/ShopContext';
import type { Product } from '../../types';
import type { ExpiryAlertItem } from '../../services/stockService';
import { ExpiryAlertRow } from './ExpiryAlertRow';

const PREVIEW_COUNT = 3;

export interface ExpiryAlertsCardProps {
  alerts: ExpiryAlertItem[];
  isLoading: boolean;
  onViewAll: () => void;
  onSelectProduct: (product: Product) => void;
}

/** Dashboard summary of the most urgent expiry alerts. */
export const ExpiryAlertsCard: React.FC<ExpiryAlertsCardProps> = ({ alerts, isLoading, onViewAll, onSelectProduct }) => {
  const { t } = useLanguage();
  const { settings } = useShop();
  const expiredCount = alerts.filter((a) => a.kind === 'expired').length;

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-1.5">
          <CalendarClock className="w-4 h-4 text-amber-400" />
          <span>{t('expiry.dashboardTitle')}</span>
          {alerts.length > 0 && (
            <span
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                expiredCount > 0 ? 'bg-rose-900/80 text-rose-200' : 'bg-amber-900/80 text-amber-200'
              }`}
            >
              {alerts.length}
            </span>
          )}
        </h3>
        {alerts.length > 0 && (
          <button onClick={onViewAll} className="text-xs font-semibold text-emerald-400 hover:text-emerald-300">
            {t('expiry.viewAll')}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="h-20 bg-zinc-900/60 rounded-2xl animate-pulse border border-zinc-800/60" />
      ) : alerts.length === 0 ? (
        <div className="p-3.5 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/40 flex items-center gap-2.5 text-xs text-zinc-400">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          {t('expiry.dashboardEmpty')}
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.slice(0, PREVIEW_COUNT).map((item) => (
            <ExpiryAlertRow
              key={item.key}
              item={item}
              timezone={settings.timezone}
              onSelect={() => onSelectProduct(item.product)}
            />
          ))}
          {alerts.length > PREVIEW_COUNT && (
            <button onClick={onViewAll} className="w-full text-center text-xs text-zinc-400 hover:text-zinc-200 py-1">
              {t('expiry.moreCount', { count: alerts.length - PREVIEW_COUNT })}
            </button>
          )}
        </div>
      )}
    </section>
  );
};
