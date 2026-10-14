import React, { useEffect, useState } from 'react';
import { Ban, Barcode, Calendar, Layers, Plus } from 'lucide-react';
import type { Product, StockBatch } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShop, useShopId } from '../../context/ShopContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { batchCode, daysUntil, todayInZone } from '../../lib/expiry';
import { getProductBatches } from '../../services/stockService';

export interface ProductStockDetailDialogProps {
  isOpen: boolean;
  product: Product | null;
  refreshTrigger?: number;
  onClose: () => void;
  onOpenStockIn: (product: Product) => void;
}

export const ProductStockDetailDialog: React.FC<ProductStockDetailDialogProps> = ({
  isOpen,
  product,
  refreshTrigger,
  onClose,
  onOpenStockIn,
}) => {
  const { t, dict } = useLanguage();
  const shopId = useShopId();
  const { settings } = useShop();
  const [batches, setBatches] = useState<StockBatch[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isOpen || !product) return;
    let cancelled = false;
    void getProductBatches(product.id, shopId).then((items) => {
      if (cancelled) return;
      setBatches(items);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, product, shopId, refreshTrigger]);

  if (!isOpen || !product) return null;

  const today = todayInZone(settings.timezone);
  const isExpiredBatch = (batch: StockBatch) => batch.expiryDate !== null && batch.expiryDate < today;
  const totalStock = batches.reduce((sum, b) => sum + (isExpiredBatch(b) ? 0 : b.quantity), 0);
  const expiredStock = batches.reduce((sum, b) => sum + (isExpiredBatch(b) ? b.quantity : 0), 0);
  const categoryLabel = dict.product.categories[product.category] || product.category;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={product.name}
      description={t('stockDetail.description')}
      footer={
        <div className="flex w-full gap-2">
          <Button
            onClick={() => {
              onClose();
              onOpenStockIn(product);
            }}
            variant="primary"
            size="md"
            className="flex-1"
            leftIcon={<Plus className="w-4 h-4" />}
          >
            {t('stockIn.title')}
          </Button>
          <Button onClick={onClose} variant="secondary" size="md">
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 py-1">
        {/* Top Summary Card */}
        <div className="p-4 bg-zinc-950 rounded-2xl border border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              {categoryLabel}
            </span>
            <span className="text-xs text-zinc-400 font-mono flex items-center gap-1">
              <Barcode className="w-3.5 h-3.5 text-zinc-500" />
              {product.barcode}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
              <span className="text-[10px] text-zinc-400 block">{t('stockIn.currentStock')}</span>
              <span className="text-lg font-extrabold text-emerald-400 mt-0.5 block">
                {totalStock} <span className="text-xs font-normal text-zinc-400">{t('stockIn.units')}</span>
              </span>
              {expiredStock > 0 && (
                <span className="text-[10px] font-semibold text-rose-300 block mt-0.5">
                  {t('expiry.expiredUnits', { count: expiredStock })}
                </span>
              )}
            </div>
            <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
              <span className="text-[10px] text-zinc-400 block">{t('product.sellingPrice')}</span>
              <span className="text-base font-bold text-zinc-100 mt-0.5 block">
                {product.sellingPrice != null ? `R ${Number(product.sellingPrice).toFixed(2)}` : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* Distinct Delivery Batches Breakdown */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              <span>{t('stockDetail.batchesHeading', { count: batches.length })}</span>
            </h4>
          </div>

          {isLoading ? (
            <div className="h-20 bg-zinc-900 rounded-xl animate-pulse" />
          ) : batches.length > 0 ? (
            <div className="space-y-2 max-h-56 overflow-y-auto pr-0.5">
              {batches.map((batch, idx) => {
                const daysRemaining = batch.expiryDate ? daysUntil(batch.expiryDate, today) : null;
                const isExpired = isExpiredBatch(batch);
                const isUrgent = daysRemaining !== null && daysRemaining >= 0 && daysRemaining <= 7;
                const flagged = isExpired && batch.quantity > 0;

                return (
                  <div
                    key={batch.id}
                    className={`p-3 rounded-xl border flex items-center justify-between gap-3 text-xs ${
                      flagged ? 'bg-rose-950/30 border-rose-800/80' : 'bg-zinc-900/80 border-zinc-800/80'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-zinc-100">
                          {t('stockDetail.batchNumber', { number: batches.length - idx })}
                        </span>
                        <span className={`font-semibold ${flagged ? 'text-rose-300 line-through' : 'text-emerald-400'}`}>
                          {batch.quantity} / {batch.initialQuantity} {t('stockIn.units')}
                        </span>
                      </div>
                      <span className="text-[10px] text-zinc-400 block mt-0.5">
                        {t('stockDetail.received', { date: new Date(batch.receivedAt).toLocaleDateString() })}
                        <span className="font-mono ml-1.5">{batchCode(batch.id)}</span>
                      </span>
                      {flagged && (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-bold uppercase text-rose-300">
                          <Ban className="w-3 h-3" />
                          {t('expiry.notSellable')}
                        </span>
                      )}
                    </div>

                    <div className="text-right">
                      {batch.expiryDate ? (
                        <div
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold border ${
                            isExpired
                              ? 'bg-rose-950/60 text-rose-300 border-rose-800'
                              : isUrgent
                              ? 'bg-amber-950/60 text-amber-300 border-amber-800'
                              : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                          }`}
                        >
                          <Calendar className="w-3 h-3" />
                          <span>{batch.expiryDate}</span>
                          {daysRemaining !== null && (
                            <span className="opacity-80">
                              (
                              {isExpired
                                ? t('stockDetail.daysAgoShort', { count: Math.abs(daysRemaining) })
                                : t('stockDetail.daysShort', { count: daysRemaining })}
                              )
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-zinc-500">{t('stockDetail.noExpiry')}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-4 bg-zinc-900/40 rounded-xl border border-dashed border-zinc-800 text-center text-xs text-zinc-400">
              {t('stockDetail.empty')}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
};
