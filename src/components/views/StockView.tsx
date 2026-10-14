import React, { useState, useEffect } from 'react';
import { Package, Search, Plus, Barcode, Layers, CalendarClock, Archive, ArchiveRestore } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop, useShopId } from '../../context/ShopContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import type { Product, ProductStockSummary } from '../../types';
import { getAllProductsStockSummary } from '../../services/stockService';
import { getArchivedProducts, setProductArchived } from '../../services/productService';
import { can } from '../../lib/permissions';

export interface StockViewProps {
  onOpenScanner: () => void;
  onSelectProduct: (product: Product) => void;
  onQuickStockIn: (product: Product) => void;
  refreshTrigger?: number;
}

export const StockView: React.FC<StockViewProps> = ({
  onOpenScanner,
  onSelectProduct,
  onQuickStockIn,
  refreshTrigger,
}) => {
  const { t, dict } = useLanguage();
  const shopId = useShopId();
  const { settings } = useShop();
  const canEdit = can(settings.role, 'products.edit');
  const [searchTerm, setSearchTerm] = useState('');
  const [summaries, setSummaries] = useState<ProductStockSummary[]>([]);
  const [archived, setArchived] = useState<Product[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [items, archivedItems] = await Promise.all([
          getAllProductsStockSummary(shopId),
          getArchivedProducts(shopId),
        ]);
        if (cancelled) return;
        setSummaries(items);
        setArchived(archivedItems);
      } catch (err) {
        console.warn('Failed to load stock summaries:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shopId, refreshTrigger]);

  const term = searchTerm.trim().toLowerCase();
  const matches = (product: Product) =>
    product.name.toLowerCase().includes(term) || product.barcode.toLowerCase().includes(term);
  const filteredSummaries = summaries.filter(({ product }) => matches(product));
  const filteredArchived = archived.filter(matches);

  return (
    <div className="space-y-5 pb-24">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">{t('navigation.stock')}</h2>
          <p className="text-xs text-zinc-400">{t('stock.registeredCount', { count: summaries.length })}</p>
        </div>
        <Button onClick={onOpenScanner} variant="primary" size="sm" leftIcon={<Plus className="w-4 h-4" />}>
          {t('scanner.scanAction')}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Input
          placeholder={t('stock.searchPlaceholder')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          leftIcon={<Search className="w-4 h-4" />}
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-zinc-900/60 rounded-2xl animate-pulse border border-zinc-800/60" />
          ))}
        </div>
      ) : filteredSummaries.length > 0 ? (
        <div className="space-y-3">
          {filteredSummaries.map(({ product, totalQuantity, expiredQuantity, batches, earliestExpiry, isExpired, isExpiringSoon }) => (
            <div
              key={product.id}
              className="p-4 bg-zinc-950 hover:bg-zinc-900/90 rounded-2xl border border-zinc-800/80 hover:border-zinc-700 transition-all shadow-sm flex flex-col gap-3"
            >
              <div
                onClick={() => onSelectProduct(product)}
                className="flex items-start justify-between gap-3 cursor-pointer select-none"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                      {dict.product.categories[product.category] ?? product.category}
                    </span>
                    <span className="text-xs text-zinc-400 font-mono flex items-center gap-1">
                      <Barcode className="w-3.5 h-3.5 text-zinc-500" />
                      {product.barcode}
                    </span>
                  </div>

                  <h4 className="text-sm font-bold text-zinc-100 truncate mt-1">{product.name}</h4>

                  {earliestExpiry && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border ${
                          isExpired
                            ? 'bg-rose-950/60 text-rose-300 border-rose-800'
                            : isExpiringSoon
                            ? 'bg-amber-950/60 text-amber-300 border-amber-800'
                            : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                        }`}
                      >
                        <CalendarClock className="w-3 h-3" />
                        <span>{t('stock.expiresOn', { date: earliestExpiry })}</span>
                        {isExpired && <span>({t('stock.expiredTag')})</span>}
                        {isExpiringSoon && !isExpired && <span>({t('stock.soonTag')})</span>}
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        {t('stock.batchCount', { count: batches.length })}
                      </span>
                    </div>
                  )}
                </div>

                <div className="text-right shrink-0">
                  <span className="text-[10px] text-zinc-400 block uppercase font-medium">{t('stock.available')}</span>
                  <span className={`text-base font-extrabold ${totalQuantity > 0 ? 'text-emerald-400' : 'text-zinc-500'}`}>
                    {totalQuantity} <span className="text-xs font-normal text-zinc-400">{t('stockIn.units')}</span>
                  </span>
                  {expiredQuantity > 0 && (
                    <span className="text-[10px] font-semibold text-rose-300 block">
                      {t('expiry.expiredUnits', { count: expiredQuantity })}
                    </span>
                  )}
                  {product.sellingPrice != null && (
                    <span className="text-[11px] text-zinc-400 block mt-0.5">R {Number(product.sellingPrice).toFixed(2)}</span>
                  )}
                </div>
              </div>

              <div className="pt-2 border-t border-zinc-900 flex items-center justify-between gap-2">
                <button
                  onClick={() => onSelectProduct(product)}
                  className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 font-medium"
                >
                  <Layers className="w-3.5 h-3.5 text-zinc-500" />
                  <span>{t('stock.viewBatches', { count: batches.length })}</span>
                </button>
                <Button
                  onClick={() => onQuickStockIn(product)}
                  variant="secondary"
                  size="sm"
                  className="h-8 px-3 text-xs"
                  leftIcon={<Plus className="w-3.5 h-3.5 text-emerald-400" />}
                >
                  {t('stock.stockIn')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-zinc-900/40 border border-dashed border-zinc-800 rounded-2xl p-8 text-center flex flex-col items-center justify-center">
          <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 flex items-center justify-center text-zinc-400 mb-3 border border-zinc-700/50">
            <Package className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-semibold text-zinc-200">
            {searchTerm ? t('stock.noMatchesTitle') : t('stock.emptyTitle')}
          </h3>
          <p className="text-xs text-zinc-400 max-w-xs mt-1.5 leading-relaxed">
            {searchTerm ? t('stock.noMatchesMessage', { term: searchTerm }) : t('stock.emptyMessage')}
          </p>
          <Button onClick={onOpenScanner} variant="primary" size="sm" className="mt-4" leftIcon={<Plus className="w-4 h-4" />}>
            {t('scanner.scanAction')}
          </Button>
        </div>
      )}

      {!isLoading && archived.length > 0 && (
        <div className="space-y-2">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="w-full flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200"
            aria-expanded={showArchived}
          >
            <Archive className="w-3.5 h-3.5" />
            {showArchived ? t('product.hideArchived') : t('product.showArchived', { count: archived.length })}
          </button>

          {showArchived &&
            (filteredArchived.length > 0 ? (
              filteredArchived.map((product) => (
                <div
                  key={product.id}
                  className="p-3 bg-zinc-950/60 rounded-2xl border border-dashed border-zinc-800 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                      {t('product.archived')}
                    </span>
                    <h4 className="text-sm font-semibold text-zinc-300 truncate mt-1">{product.name}</h4>
                    <span className="text-xs text-zinc-500 font-mono flex items-center gap-1">
                      <Barcode className="w-3.5 h-3.5" />
                      {product.barcode}
                    </span>
                  </div>
                  {canEdit && (
                    <Button
                      onClick={() => void setProductArchived(product.id, false, shopId)}
                      variant="secondary"
                      size="sm"
                      className="h-8 px-3 text-xs shrink-0"
                      leftIcon={<ArchiveRestore className="w-3.5 h-3.5 text-emerald-400" />}
                    >
                      {t('product.restore')}
                    </Button>
                  )}
                </div>
              ))
            ) : (
              <p className="text-center text-xs text-zinc-500 py-2">{t('product.archivedEmpty')}</p>
            ))}
        </div>
      )}
    </div>
  );
};
