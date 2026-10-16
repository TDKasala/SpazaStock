import React, { useEffect, useState } from 'react';
import { CalendarClock, ShieldCheck, AlertCircle, Clock, Plus, ClipboardCheck, Ban, ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop, useShopId } from '../../context/ShopContext';
import { canManageExpiry } from '../../lib/shopSettings';
import { Button } from '../ui/Button';
import type { Product, Sale, StockBatch } from '../../types';
import {
  getOpenDiscrepancies,
  resolveDiscrepancy,
  type DiscrepancyAlert,
  type ExpiryAlertItem,
} from '../../services/stockService';
import { ExpiryAlertRow } from '../expiry/ExpiryAlertRow';
import { PushAlertsToggle } from '../expiry/PushAlertsToggle';
import { ReminderSettings } from '../expiry/ReminderSettings';
import { ResolveExpiryDialog } from '../expiry/ResolveExpiryDialog';
import { LowStockSection } from '../stock/LowStockSection';
import { StockIntelligenceCard } from '../dashboard/StockIntelligenceCard';
import { dismissLowStock } from '../../services/lowStockService';
import type { LowStockItem } from '../../lib/lowStock';

const PAGE_SIZE = 15;

export interface AlertsViewProps {
  alerts: ExpiryAlertItem[];
  isLoading: boolean;
  onOpenScanner: () => void;
  onSelectProduct: (product: Product) => void;
  onQuickStockIn: (product: Product) => void;
  refreshTrigger?: number;
  lowStock: LowStockItem[];
  products: Product[];
  sales: Sale[];
  batches: StockBatch[];
  timezone: string;
  isLoadingIntelligence: boolean;
}

export const AlertsView: React.FC<AlertsViewProps> = ({
  alerts,
  isLoading,
  onOpenScanner,
  onSelectProduct,
  onQuickStockIn,
  refreshTrigger,
  lowStock,
  products,
  sales,
  batches,
  timezone,
  isLoadingIntelligence,
}) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const { settings } = useShop();
  const canResolve = canManageExpiry(settings.role);
  const [discrepancies, setDiscrepancies] = useState<DiscrepancyAlert[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveItem, setResolveItem] = useState<ExpiryAlertItem | null>(null);
  const [alertPage, setAlertPage] = useState(0);
  const [discrepancyPage, setDiscrepancyPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getOpenDiscrepancies(shopId)
      .then((open) => {
        if (!cancelled) setDiscrepancies(open);
      })
      .catch((err) => console.warn('Failed to load discrepancies:', err));
    return () => {
      cancelled = true;
    };
  }, [shopId, refreshTrigger]);

  const handleResolveDiscrepancy = async (id: string) => {
    setResolvingId(id);
    try {
      await resolveDiscrepancy(id, shopId);
    } finally {
      setResolvingId(null);
    }
  };

  const expiredAlerts = alerts.filter((a) => a.status === 'expired');
  const urgentAlerts = alerts.filter((a) => a.status === 'urgent');
  const warningAlerts = alerts.filter((a) => a.status === 'warning');
  const orderedAlerts = [...expiredAlerts, ...urgentAlerts, ...warningAlerts];
  const alertPageCount = Math.max(1, Math.ceil(orderedAlerts.length / PAGE_SIZE));
  const currentAlertPage = Math.min(alertPage, alertPageCount - 1);
  const alertStart = currentAlertPage * PAGE_SIZE;
  const alertEnd = Math.min(alertStart + PAGE_SIZE, orderedAlerts.length);
  const pageAlerts = orderedAlerts.slice(alertStart, alertEnd);
  const pageExpired = pageAlerts.filter((a) => a.status === 'expired');
  const pageUrgent = pageAlerts.filter((a) => a.status === 'urgent');
  const pageWarning = pageAlerts.filter((a) => a.status === 'warning');

  const discrepancyPageCount = Math.max(1, Math.ceil(discrepancies.length / PAGE_SIZE));
  const currentDiscrepancyPage = Math.min(discrepancyPage, discrepancyPageCount - 1);
  const discrepancyStart = currentDiscrepancyPage * PAGE_SIZE;
  const discrepancyEnd = Math.min(discrepancyStart + PAGE_SIZE, discrepancies.length);
  const pageDiscrepancies = discrepancies.slice(discrepancyStart, discrepancyEnd);

  const renderAlert = (item: ExpiryAlertItem) => (
    <ExpiryAlertRow
      key={item.key}
      item={item}
      timezone={settings.timezone}
      onSelect={() => onSelectProduct(item.product)}
      action={
        <>
          {canResolve && (
            <Button onClick={() => setResolveItem(item)} variant="secondary" size="sm" className="h-8 text-xs">
              {t('expiry.resolve')}
            </Button>
          )}
          {item.kind !== 'expired' && (
            <Button
              onClick={() => onQuickStockIn(item.product)}
              variant="secondary"
              size="sm"
              className="h-8 text-xs"
              leftIcon={<Plus className="w-3.5 h-3.5 text-emerald-400" />}
            >
              {t('expiry.addStock')}
            </Button>
          )}
        </>
      }
    />
  );

  const section = (
    items: ExpiryAlertItem[],
    title: string,
    icon: React.ReactNode,
    color: string,
    total = items.length
  ) =>
    items.length > 0 && (
      <div className="space-y-2">
        <h3 className={`text-xs font-bold uppercase tracking-wider px-1 flex items-center gap-1.5 ${color}`}>
          {icon}
          <span>
            {title} ({total})
          </span>
        </h3>
        <div className="space-y-2">{items.map(renderAlert)}</div>
      </div>
    );

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

      <PushAlertsToggle />
      <ReminderSettings />
      <StockIntelligenceCard
        lowStock={lowStock}
        products={products}
        sales={sales}
        batches={batches}
        timezone={timezone}
        isLoading={isLoadingIntelligence}
      />

      {!isLoading && (
        <LowStockSection
          items={lowStock}
          products={products}
          onSelectProduct={onSelectProduct}
          onRestock={onQuickStockIn}
          onDismiss={(productId) => void dismissLowStock(productId, shopId)}
        />
      )}

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
                {pageDiscrepancies.map(({ discrepancy, product }) => (
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
                      onClick={() => void handleResolveDiscrepancy(discrepancy.id)}
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
              {discrepancies.length > PAGE_SIZE && (
                <nav className="flex items-center justify-between gap-3 pt-1" aria-label={t('expiry.paginationLabel')}>
                  <p className="text-xs text-zinc-400" aria-live="polite">
                    {t('expiry.pageRange', {
                      from: discrepancyStart + 1,
                      to: discrepancyEnd,
                      total: discrepancies.length,
                    })}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDiscrepancyPage(currentDiscrepancyPage - 1)}
                      disabled={currentDiscrepancyPage === 0}
                      leftIcon={<ChevronLeft className="w-4 h-4" />}
                    >
                      {t('expiry.previousPage')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDiscrepancyPage(currentDiscrepancyPage + 1)}
                      disabled={currentDiscrepancyPage >= discrepancyPageCount - 1}
                      rightIcon={<ChevronRight className="w-4 h-4" />}
                    >
                      {t('expiry.nextPage')}
                    </Button>
                  </div>
                </nav>
              )}
            </div>
          )}

          {section(pageExpired, t('expiry.expired'), <Ban className="w-3.5 h-3.5" />, 'text-rose-400', expiredAlerts.length)}
          {section(pageUrgent, t('expiry.urgentExpiring'), <AlertCircle className="w-3.5 h-3.5" />, 'text-amber-400', urgentAlerts.length)}
          {section(pageWarning, t('expiry.warningExpiring'), <Clock className="w-3.5 h-3.5" />, 'text-amber-400', warningAlerts.length)}
          {orderedAlerts.length > PAGE_SIZE && (
            <nav className="flex items-center justify-between gap-3 pt-1" aria-label={t('expiry.paginationLabel')}>
              <p className="text-xs text-zinc-400" aria-live="polite">
                {t('expiry.pageRange', { from: alertStart + 1, to: alertEnd, total: orderedAlerts.length })}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAlertPage(currentAlertPage - 1)}
                  disabled={currentAlertPage === 0}
                  leftIcon={<ChevronLeft className="w-4 h-4" />}
                >
                  {t('expiry.previousPage')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAlertPage(currentAlertPage + 1)}
                  disabled={currentAlertPage >= alertPageCount - 1}
                  rightIcon={<ChevronRight className="w-4 h-4" />}
                >
                  {t('expiry.nextPage')}
                </Button>
              </div>
            </nav>
          )}
        </div>
      ) : lowStock.length === 0 ? (
        <div className="bg-zinc-900/40 border border-dashed border-zinc-800 rounded-2xl p-8 text-center flex flex-col items-center justify-center">
          <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 flex items-center justify-center text-emerald-400 mb-3 border border-zinc-700/50">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-semibold text-zinc-200">{t('expiry.noAlertsTitle')}</h3>
          <p className="text-xs text-zinc-400 max-w-xs mt-1.5 leading-relaxed">{t('expiry.noAlertsMessage')}</p>
        </div>
      ) : null}

      <ResolveExpiryDialog item={resolveItem} onClose={() => setResolveItem(null)} />
    </div>
  );
};
