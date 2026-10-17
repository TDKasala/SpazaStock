import React, { useEffect, useState } from 'react';
import { ScanBarcode, ShoppingCart, Plus, Minus, Layers, CloudOff, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Product, Sale } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { Button } from '../ui/Button';
import { ErrorMessage } from '../ui/ErrorMessage';
import { Dialog } from '../ui/Dialog';
import { getSales, getTodaySales, saleNetAmount, saleNetQuantity } from '../../services/salesService';
import { SyncChip } from './RapidSellPanel';
import { getProducts } from '../../services/productService';
import { getProductTotalStock } from '../../services/stockService';
import { newId } from '../../lib/ids';
import type { SaleRegister } from '../../hooks/useSaleRegister';

export interface SalesRegisterProps {
  register: SaleRegister;
  onOpenScanner: () => void;
  refreshTrigger?: number;
}

const PAGE_SIZE = 15;

export const SalesRegister: React.FC<SalesRegisterProps> = ({ register, onOpenScanner, refreshTrigger }) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const { lastSaleResult, error, isProcessing, sellProduct, clearError, syncStates } = register;

  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [page, setPage] = useState(0);
  const [todaySales, setTodaySales] = useState<Sale[]>([]);
  const [productNames, setProductNames] = useState<Record<string, string>>({});

  const [adjustModalProduct, setAdjustModalProduct] = useState<Product | null>(null);
  const [adjustQuantity, setAdjustQuantity] = useState('2');
  const [adjustAvailableStock, setAdjustAvailableStock] = useState(0);
  const [adjustKey, setAdjustKey] = useState('');
  const [adjustError, setAdjustError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [sales, today, products] = await Promise.all([
        getSales(shopId),
        getTodaySales(shopId),
        getProducts(shopId, { includeArchived: true }),
      ]);
      if (cancelled) return;
      setRecentSales(sales);
      setTodaySales(today);
      setProductNames(Object.fromEntries(products.map((p) => [p.id, p.name])));
    })();
    return () => {
      cancelled = true;
    };
  }, [shopId, refreshTrigger, lastSaleResult]);

  useEffect(() => {
    setPage(0);
  }, [shopId, lastSaleResult]);

  const openAdjustModal = async (product: Product) => {
    setAdjustAvailableStock(await getProductTotalStock(product.id, shopId));
    setAdjustQuantity('2');
    setAdjustError(null);
    clearError();
    setAdjustKey(newId());
    setAdjustModalProduct(product);
  };

  const handleAdjustSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!adjustModalProduct) return;
    const qty = Number(adjustQuantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setAdjustError(t('stockIn.invalidQuantity'));
      return;
    }
    const ok = await sellProduct(adjustModalProduct, qty, adjustKey);
    if (ok) setAdjustModalProduct(null);
  };

  const todayTotalRevenue = todaySales.reduce((sum, s) => sum + saleNetAmount(s), 0);
  const todayTotalUnits = todaySales.reduce((sum, s) => sum + saleNetQuantity(s), 0);
  const firstAllocation = lastSaleResult?.allocations[0];

  const pageCount = Math.max(1, Math.ceil(recentSales.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, recentSales.length);
  const pageSales = recentSales.slice(pageStart, pageEnd);

  return (
    <div className="space-y-5 pb-24">
      <div>
        <h2 className="text-lg font-bold text-zinc-100">{t('sales.title')}</h2>
        <p className="text-xs text-zinc-400">{t('sales.subtitle')}</p>
      </div>

      <div className="p-5 bg-gradient-to-br from-zinc-900 via-zinc-950 to-zinc-900 rounded-3xl border border-zinc-800 shadow-xl space-y-4">
        <button
          onClick={onOpenScanner}
          className="w-full py-4 px-4 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-2xl shadow-lg shadow-emerald-950/50 flex items-center justify-center gap-3 font-bold text-base transition-all select-none cursor-pointer"
        >
          <ScanBarcode className="w-6 h-6" />
          <span>{t('sales.tapToScan')}</span>
        </button>
      </div>

      {error && <ErrorMessage variant="error" message={error} onDismiss={clearError} />}

      {lastSaleResult && (
        <div className="p-4 bg-emerald-950/50 border border-emerald-500/50 rounded-2xl space-y-3 animate-in fade-in zoom-in-95 shadow-md">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-emerald-500 text-zinc-950">
                  {t('sales.soldCount', { count: saleNetQuantity(lastSaleResult.sale) })}
                </span>
                <span className="text-xs text-zinc-400 font-mono">{lastSaleResult.product.barcode}</span>
                {lastSaleResult.isQueuedOffline && (
                  <CloudOff className="w-3.5 h-3.5 text-amber-400" aria-label={t('sync.queuedOffline')} />
                )}
                <SyncChip state={syncStates.get(lastSaleResult.sale.id)} />
              </div>
              <h3 className="text-base font-bold text-zinc-100 truncate mt-1">{lastSaleResult.product.name}</h3>
            </div>
            <div className="text-right shrink-0">
              <span className="text-base font-extrabold text-emerald-400 block">
                +R {saleNetAmount(lastSaleResult.sale).toFixed(2)}
              </span>
              <span className="text-[11px] text-zinc-300 font-medium block">
                {lastSaleResult.remainingTotalStock} {t('sales.unitsRemaining')}
              </span>
            </div>
          </div>

          <div className="p-2.5 bg-zinc-950/80 rounded-xl border border-zinc-800 text-[11px] text-zinc-400 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 min-w-0">
              <Layers className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate">
                {firstAllocation?.batchExpiryDate
                  ? t('sales.deductedFromExpiry', { date: firstAllocation.batchExpiryDate })
                  : t('sales.deductedNonPerishable')}
              </span>
            </span>
            <button
              onClick={() => void openAdjustModal(lastSaleResult.product)}
              className="text-emerald-400 font-semibold hover:underline text-xs shrink-0"
            >
              {t('sales.sellMore')}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="p-4 bg-zinc-900/60 rounded-2xl border border-zinc-800">
          <span className="text-[11px] text-zinc-400 block">{t('sales.totalRevenue')}</span>
          <span className="text-xl font-extrabold text-emerald-400 mt-1 block">R {todayTotalRevenue.toFixed(2)}</span>
          <span className="text-[10px] text-zinc-500 mt-0.5 block">{t('sales.today')}</span>
        </div>
        <div className="p-4 bg-zinc-900/60 rounded-2xl border border-zinc-800">
          <span className="text-[11px] text-zinc-400 block">{t('sales.unitsSold')}</span>
          <span className="text-xl font-extrabold text-zinc-100 mt-1 block">
            {todayTotalUnits} <span className="text-xs font-normal text-zinc-400">{t('stockIn.units')}</span>
          </span>
          <span className="text-[10px] text-zinc-500 mt-0.5 block">
            {t('sales.transactionsCount', { count: todaySales.length })}
          </span>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider px-1">{t('sales.recentTransactions')}</h3>

        {recentSales.length > 0 ? (
          <div className="space-y-2">
            {pageSales.map((sale) => (
              <div
                key={sale.id}
                className="p-3.5 bg-zinc-950 rounded-2xl border border-zinc-800 flex items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-zinc-100 truncate block">
                    {productNames[sale.productId] ?? t('sales.unknownProduct')}
                  </span>
                  <span className="text-[11px] text-zinc-400 block mt-0.5">
                    {t('sales.soldCount', { count: saleNetQuantity(sale) })} ·{' '}
                    {new Date(sale.createdAt).toLocaleString([], {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  {(Boolean(sale.voidedQuantity) || syncStates.has(sale.id)) && (
                    <div className="flex items-center gap-1.5 mt-1">
                      {Boolean(sale.voidedQuantity) && (
                        <span className="text-[10px] text-zinc-500 line-through">
                          {t('sales.voidedCount', { count: sale.voidedQuantity ?? 0 })}
                        </span>
                      )}
                      <SyncChip state={syncStates.get(sale.id)} />
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <span className="text-sm font-bold text-emerald-400">+R {saleNetAmount(sale).toFixed(2)}</span>
                  <span className="text-[10px] text-zinc-500 block">
                    {t('sales.eachPrice', { price: sale.unitPrice.toFixed(2) })}
                  </span>
                </div>
              </div>
            ))}
            {recentSales.length > PAGE_SIZE && (
              <nav className="flex items-center justify-between gap-3 pt-1" aria-label={t('sales.paginationLabel')}>
                <p className="text-xs text-zinc-400" aria-live="polite">
                  {t('sales.pageRange', { from: pageStart + 1, to: pageEnd, total: recentSales.length })}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(currentPage - 1)}
                    disabled={currentPage === 0}
                    leftIcon={<ChevronLeft className="w-4 h-4" />}
                  >
                    {t('sales.previousPage')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(currentPage + 1)}
                    disabled={currentPage >= pageCount - 1}
                    rightIcon={<ChevronRight className="w-4 h-4" />}
                  >
                    {t('sales.nextPage')}
                  </Button>
                </div>
              </nav>
            )}
          </div>
        ) : (
          <div className="p-8 bg-zinc-900/40 rounded-2xl border border-dashed border-zinc-800 text-center text-xs text-zinc-400">
            <ShoppingCart className="w-8 h-8 mx-auto mb-2 text-zinc-500 opacity-60" />
            <p>{t('sales.noSalesToday')}</p>
          </div>
        )}
      </div>

      {adjustModalProduct && (
        <Dialog
          isOpen={true}
          onClose={() => setAdjustModalProduct(null)}
          title={t('sales.sellMultipleTitle', { name: adjustModalProduct.name })}
          description={t('sales.availableInStock', { count: adjustAvailableStock })}
          footer={
            <div className="flex w-full gap-2">
              <Button onClick={() => setAdjustModalProduct(null)} variant="secondary" size="md" className="flex-1">
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => void handleAdjustSubmit()}
                variant="primary"
                size="md"
                className="flex-1"
                disabled={isProcessing}
                isLoading={isProcessing}
              >
                {t('sales.confirmSale')}
              </Button>
            </div>
          }
        >
          <form onSubmit={(e) => void handleAdjustSubmit(e)} className="space-y-4 py-2">
            {(adjustError || error) && (
              <ErrorMessage variant="error" message={adjustError ?? error ?? ''} onDismiss={() => setAdjustError(null)} />
            )}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-zinc-300">{t('sales.quantityToSell')}</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const cur = parseInt(adjustQuantity, 10) || 1;
                    if (cur > 1) setAdjustQuantity(String(cur - 1));
                  }}
                  className="w-12 h-12 bg-zinc-900 rounded-xl border border-zinc-800 flex items-center justify-center font-bold text-lg text-zinc-200"
                  aria-label="-"
                >
                  <Minus className="w-5 h-5" />
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max={adjustAvailableStock}
                  value={adjustQuantity}
                  onChange={(e) => setAdjustQuantity(e.target.value)}
                  className="flex-1 h-12 bg-zinc-900 border border-zinc-800 rounded-xl text-center font-bold text-xl text-zinc-100 focus:outline-none focus:border-emerald-500"
                />
                <button
                  type="button"
                  onClick={() => {
                    const cur = parseInt(adjustQuantity, 10) || 1;
                    if (cur < adjustAvailableStock) setAdjustQuantity(String(cur + 1));
                  }}
                  className="w-12 h-12 bg-zinc-900 rounded-xl border border-zinc-800 flex items-center justify-center font-bold text-lg text-zinc-200"
                  aria-label="+"
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>

              <div className="grid grid-cols-4 gap-2 pt-1">
                {[2, 3, 5, 10].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => setAdjustQuantity(String(Math.min(num, Math.max(adjustAvailableStock, 1))))}
                    className="py-1.5 px-2 bg-zinc-900 hover:bg-zinc-800 text-xs font-semibold text-zinc-300 rounded-lg border border-zinc-800"
                  >
                    {num} {t('stockIn.units')}
                  </button>
                ))}
              </div>
            </div>

            {adjustModalProduct.sellingPrice != null && (
              <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800 flex items-center justify-between text-xs">
                <span className="text-zinc-400">{t('sales.totalPrice')}</span>
                <span className="font-bold text-base text-emerald-400">
                  R {(Number(adjustModalProduct.sellingPrice) * (parseInt(adjustQuantity, 10) || 0)).toFixed(2)}
                </span>
              </div>
            )}
          </form>
        </Dialog>
      )}
    </div>
  );
};
