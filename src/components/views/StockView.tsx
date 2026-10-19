import React, { useState, useEffect } from 'react';
import { Package, Search, Barcode, Archive, ArchiveRestore, ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop, useShopId } from '../../context/ShopContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import type { Product, ProductStockSummary } from '../../types';
import { getAllProductsStockSummary } from '../../services/stockService';
import { getArchivedProducts, setProductArchived } from '../../services/productService';
import { can } from '../../lib/permissions';
import { StockProductCard } from '../stock/StockProductCard';
import { ScanInput } from '../scanner/ScanInput';
import { attachGlobalHidListener } from '../../lib/scanner/hid';

const PAGE_SIZE = 15;

export interface StockViewProps {
  onOpenScanner: () => void;
  onSelectProduct: (product: Product) => void;
  onQuickStockIn: (product: Product) => void;
  /** Called when a hardware scanner burst is detected (GS1 element string or plain EAN/UPC). */
  onHardwareScan?: (barcode: string) => void;
  refreshTrigger?: number;
}

export const StockView: React.FC<StockViewProps> = ({
  onOpenScanner,
  onSelectProduct,
  onQuickStockIn,
  onHardwareScan,
  refreshTrigger,
}) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const { settings } = useShop();
  const canEdit = can(settings.role, 'products.edit');
  const [searchTerm, setSearchTerm] = useState('');
  const [summaries, setSummaries] = useState<ProductStockSummary[]>([]);
  const [archived, setArchived] = useState<Product[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(0);

  // Page-level HID listener in Stock view.
  useEffect(() => {
    if (!onHardwareScan) return;
    return attachGlobalHidListener((code) => onHardwareScan(code), { active: true, feedback: false });
  }, [onHardwareScan]);

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

  const pageCount = Math.max(1, Math.ceil(filteredSummaries.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, filteredSummaries.length);
  const pageSummaries = filteredSummaries.slice(pageStart, pageEnd);

  return (
    <div className="space-y-5 pb-24">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">{t('navigation.stock')}</h2>
          <p className="text-xs text-zinc-400">{t('stock.registeredCount', { count: summaries.length })}</p>
        </div>
        <Button onClick={onOpenScanner} variant="primary" size="sm" leftIcon={<Barcode className="w-4 h-4" />}>
          {t('scanner.scanAction')}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        {onHardwareScan && (
          <ScanInput
            onScan={(code) => onHardwareScan(code)}
            label={t('scanner.manualEntryTitle')}
            placeholder={t('scanner.manualEntryPlaceholder')}
          />
        )}
        <Input
          placeholder={t('stock.searchPlaceholder')}
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setPage(0);
          }}
          leftIcon={<Search className="w-4 h-4" />}
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 bg-zinc-900/60 rounded-2xl animate-pulse border border-zinc-800/60" />
          ))}
        </div>
      ) : filteredSummaries.length > 0 ? (
        <div className="space-y-3">
          {pageSummaries.map((summary) => (
            <StockProductCard
              key={summary.product.id}
              summary={summary}
              onSelect={() => onSelectProduct(summary.product)}
              onStockIn={() => onQuickStockIn(summary.product)}
            />
          ))}
          {filteredSummaries.length > PAGE_SIZE && (
            <nav className="flex items-center justify-between gap-3 pt-1" aria-label={t('stock.paginationLabel')}>
              <p className="text-xs text-zinc-400" aria-live="polite">
                {t('stock.pageRange', { from: pageStart + 1, to: pageEnd, total: filteredSummaries.length })}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(currentPage - 1)}
                  disabled={currentPage === 0}
                  leftIcon={<ChevronLeft className="w-4 h-4" />}
                >
                  {t('stock.previousPage')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(currentPage + 1)}
                  disabled={currentPage >= pageCount - 1}
                  rightIcon={<ChevronRight className="w-4 h-4" />}
                >
                  {t('stock.nextPage')}
                </Button>
              </div>
            </nav>
          )}
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
          <Button onClick={onOpenScanner} variant="primary" size="sm" className="mt-4" leftIcon={<Barcode className="w-4 h-4" />}>
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
