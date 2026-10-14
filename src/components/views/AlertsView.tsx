import React, { useEffect, useState } from 'react';
import { CalendarClock, ShieldCheck, AlertTriangle, AlertCircle, Clock, Plus, ClipboardCheck } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { Button } from '../ui/Button';
import type { Product } from '../../types';
import {
  getExpiringBatches,
  getOpenDiscrepancies,
  resolveDiscrepancy,
  type DiscrepancyAlert,
  type ExpiringBatchAlert,
} from '../../services/stockService';

export interface AlertsViewProps {
  onOpenScanner: () => void;
  onSelectProduct: (product: Product) => void;
  onQuickStockIn: (product: Product) => void;
  refreshTrigger?: number;
}

export const AlertsView: React.FC<AlertsViewProps> = ({
  onOpenScanner,
  onSelectProduct,
  onQuickStockIn,
  refreshTrigger,
}) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const [alerts, setAlerts] = useState<ExpiringBatchAlert[]>([]);
  const [discrepancies, setDiscrepancies] = useState<DiscrepancyAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [expiring, open] = await Promise.all([getExpiringBatches(shopId), getOpenDiscrepancies(shopId)]);
        if (cancelled) return;
        setAlerts(expiring);
        setDiscrepancies(open);
      } catch (err) {
        console.warn('Failed to load alerts:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shopId, refreshTrigger]);

  const handleResolve = async (id: string) => {
    setResolvingId(id);
    try {
      await resolveDiscrepancy(id, shopId);
    } finally {
      setResolvingId(null);
    }
  };

  const urgentAlerts = alerts.filter((a) => a.status === 'expired' || a.status === 'urgent');
  const warningAlerts = alerts.filter((a) => a.status === 'warning');

  const expiryLabel = (days: number) => {
    if (days < 0) return t('expiry.expiredDaysAgo', { count: Math.abs(days) });
    if (days === 0) return t('expiry.today');
    return t('expiry.daysLeftCount', { count: days });
  };

  const renderAlert = ({ batch, product, daysUntilExpiry, status }: ExpiringBatchAlert) => {
    const tone =
      status === 'expired'
        ? 'bg-rose-950/30 border-rose-800/80 text-rose-200'
        : status === 'urgent'
        ? 'bg-amber-950/30 border-amber-800/80 text-amber-200'
        : 'bg-zinc-950 border-zinc-800';
    const pill =
      status === 'expired'
        ? 'bg-rose-900/80 text-rose-200'
        : status === 'urgent'
        ? 'bg-amber-900/80 text-amber-200'
        : 'bg-zinc-800 text-amber-400 border border-amber-500/20';

    return (
      <div key={batch.id} className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 transition-all ${tone}`}>
        <div onClick={() => onSelectProduct(product)} className="min-w-0 flex-1 cursor-pointer">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${pill}`}>
              {expiryLabel(daysUntilExpiry)}
            </span>
            <span className="text-[11px] font-mono opacity-80">{batch.expiryDate}</span>
          </div>
          <h4 className="text-sm font-bold text-zinc-100 truncate mt-1">{product.name}</h4>
          <span className="text-xs text-zinc-400 block mt-0.5">
            {t('expiry.batchQuantity', { count: batch.quantity })}
          </span>
        </div>
        <Button
          onClick={() => onQuickStockIn(product)}
          variant="secondary"
          size="sm"
          className="shrink-0 h-8 text-xs"
          leftIcon={<Plus className="w-3.5 h-3.5 text-emerald-400" />}
        >
          {t('expiry.addStock')}
        </Button>
      </div>
    );
  };

  const hasAnything = alerts.length > 0 || discrepancies.length > 0;

  return (
    <div className="space-y-5 pb-24">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">{t('expiry.alertsTitle')}</h2>
          <p className="text-xs text-zinc-400">{t('expiry.alertsSubtitle')}</p>
        </div>
        <Button
          onClick={onOpenScanner}
          variant="secondary"
          size="sm"
          leftIcon={<CalendarClock className="w-4 h-4 text-amber-500" />}
        >
          {t('scanner.scanAction')}
        </Button>
      </div>

      <div className="bg-amber-950/20 border border-amber-900/50 rounded-2xl p-4 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <div className="text-xs text-zinc-300">
          <span className="font-semibold text-zinc-100 block mb-0.5">{t('expiry.policyTitle')}</span>
          {t('expiry.policyMessage')}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-20 bg-zinc-900/60 rounded-2xl animate-pulse border border-zinc-800/60" />
          ))}
        </div>
      ) : hasAnything ? (
        <div className="space-y-4">
          {discrepancies.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-rose-400 uppercase tracking-wider px-1 flex items-center gap-1.5">
                <ClipboardCheck className="w-3.5 h-3.5" />
                <span>
                  {t('discrepancy.title')} ({discrepancies.length})
                </span>
              </h3>
              <p className="text-[11px] text-zinc-400 px-1">{t('discrepancy.explanation')}</p>
              <div className="space-y-2">
                {discrepancies.map(({ discrepancy, product }) => (
                  <div
                    key={discrepancy.id}
                    className="p-3.5 rounded-2xl border bg-rose-950/30 border-rose-800/80 flex items-center justify-between gap-3"
                  >
                    <div onClick={() => onSelectProduct(product)} className="min-w-0 flex-1 cursor-pointer">
                      <h4 className="text-sm font-bold text-zinc-100 truncate">{product.name}</h4>
                      <span className="text-xs text-rose-200 block mt-0.5">
                        {t('discrepancy.shortfall', { count: discrepancy.shortfall })}
                      </span>
                      <span className="text-[10px] text-zinc-400 block mt-0.5">
                        {new Date(discrepancy.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <Button
                      onClick={() => void handleResolve(discrepancy.id)}
                      variant="secondary"
                      size="sm"
                      className="shrink-0 h-8 text-xs"
                      isLoading={resolvingId === discrepancy.id}
                    >
                      {t('discrepancy.resolve')}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {urgentAlerts.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-rose-400 uppercase tracking-wider px-1 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>
                  {t('expiry.urgentExpiring')} ({urgentAlerts.length})
                </span>
              </h3>
              <div className="space-y-2">{urgentAlerts.map(renderAlert)}</div>
            </div>
          )}

          {warningAlerts.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-amber-400 uppercase tracking-wider px-1 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span>
                  {t('expiry.warningExpiring')} ({warningAlerts.length})
                </span>
              </h3>
              <div className="space-y-2">{warningAlerts.map(renderAlert)}</div>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-zinc-900/40 border border-dashed border-zinc-800 rounded-2xl p-8 text-center flex flex-col items-center justify-center">
          <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 flex items-center justify-center text-emerald-400 mb-3 border border-zinc-700/50">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-semibold text-zinc-200">{t('expiry.noAlertsTitle')}</h3>
          <p className="text-xs text-zinc-400 max-w-xs mt-1.5 leading-relaxed">{t('expiry.noAlertsMessage')}</p>
        </div>
      )}
    </div>
  );
};
