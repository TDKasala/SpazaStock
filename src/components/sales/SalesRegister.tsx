import React, { useState, useEffect } from 'react';
import {
  ScanBarcode,
  ShoppingCart,
  Plus,
  Minus,
  CheckCircle2,
  AlertCircle,
  Clock,
  WifiOff,
  RefreshCw,
  Barcode,
  Layers,
  ArrowRight,
} from 'lucide-react';
import { Product, Sale, SaleResult, OfflineQueueItem } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { Dialog } from '../ui/Dialog';
import {
  recordSale,
  getSales,
  getOfflineQueue,
  syncOfflineQueue,
} from '../../services/salesService';
import { searchProductByBarcode } from '../../services/productService';
import { getProductTotalStock } from '../../services/stockService';

export interface SalesRegisterProps {
  onOpenScanner: () => void;
  onOpenRegisterProduct: (barcode: string) => void;
  refreshTrigger?: number;
}

export const SalesRegister: React.FC<SalesRegisterProps> = ({
  onOpenScanner,
  onOpenRegisterProduct,
  refreshTrigger,
}) => {
  const { t, dict } = useLanguage();

  const [salesHistory, setSalesHistory] = useState<Sale[]>([]);
  const [offlineQueue, setOfflineQueue] = useState<OfflineQueueItem[]>([]);
  const [lastSaleResult, setLastSaleResult] = useState<SaleResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [manualBarcode, setManualBarcode] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatusMsg, setSyncStatusMsg] = useState<string | null>(null);

  // Multi-unit adjustment modal state
  const [adjustModalProduct, setAdjustModalProduct] = useState<Product | null>(null);
  const [adjustQuantity, setAdjustQuantity] = useState<string>('2');
  const [adjustAvailableStock, setAdjustAvailableStock] = useState<number>(0);

  // Load sales history & offline queue
  const loadData = async () => {
    const sales = await getSales();
    setSalesHistory(sales);
    setOfflineQueue(getOfflineQueue());
  };

  useEffect(() => {
    loadData();
  }, [refreshTrigger]);

  // Audio / tactile feedback helper
  const triggerSaleFeedback = () => {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([40, 30, 80]);
      } catch {
        // Ignore
      }
    }
  };

  /**
   * Rapid Sale Handler: Deducts 1 unit immediately on scan.
   */
  const handleRapidSale = async (barcode: string) => {
    setIsProcessing(true);
    setErrorMessage(null);
    setSyncStatusMsg(null);

    const cleanBarcode = barcode.trim();
    if (!cleanBarcode) {
      setIsProcessing(false);
      return;
    }

    try {
      const product = await searchProductByBarcode(cleanBarcode);
      if (!product) {
        setErrorMessage(`Product with barcode "${cleanBarcode}" is not registered in your shop.`);
        onOpenRegisterProduct(cleanBarcode);
        setIsProcessing(false);
        return;
      }

      // Generate unique idempotency key for this scan
      const idempotencyKey = `scan_${product.id}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      const res = await recordSale({
        productId: product.id,
        quantity: 1,
        idempotencyKey,
      });

      if (res.error) {
        setErrorMessage(res.error);
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate([150, 100, 150]);
        }
      } else if (res.result) {
        triggerSaleFeedback();
        setLastSaleResult(res.result);
        await loadData();
      }
    } catch (err: any) {
      setErrorMessage(err?.message || t('errors.generic'));
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Manual Multi-unit Sale Submit
   */
  const handleAdjustSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustModalProduct) return;

    const qty = parseInt(adjustQuantity, 10);
    if (isNaN(qty) || qty <= 0) {
      setErrorMessage(t('stockIn.invalidQuantity'));
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      const idempotencyKey = `adjust_${adjustModalProduct.id}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const res = await recordSale({
        productId: adjustModalProduct.id,
        quantity: qty,
        idempotencyKey,
      });

      if (res.error) {
        setErrorMessage(res.error);
      } else if (res.result) {
        triggerSaleFeedback();
        setLastSaleResult(res.result);
        setAdjustModalProduct(null);
        await loadData();
      }
    } catch (err: any) {
      setErrorMessage(err?.message || t('errors.generic'));
    } finally {
      setIsProcessing(false);
    }
  };

  const openAdjustModal = async (product: Product) => {
    const stock = await getProductTotalStock(product.id);
    setAdjustAvailableStock(stock);
    setAdjustModalProduct(product);
    setAdjustQuantity('2');
  };

  const handleManualSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualBarcode.trim()) {
      handleRapidSale(manualBarcode.trim());
      setManualBarcode('');
    }
  };

  // Sync Offline Queue
  const handleSyncOffline = async () => {
    setIsSyncing(true);
    setSyncStatusMsg(null);
    try {
      const res = await syncOfflineQueue();
      if (res.errors.length > 0) {
        setErrorMessage(res.errors[0]);
      } else {
        setSyncStatusMsg(t('sales.syncedSuccess'));
      }
      setOfflineQueue(getOfflineQueue());
    } catch (err: any) {
      setErrorMessage(err?.message || 'Sync failed');
    } finally {
      setIsSyncing(false);
    }
  };

  // Today's summary calculations
  const todayStr = new Date().toISOString().split('T')[0];
  const todaySales = salesHistory.filter((s) => s.createdAt.startsWith(todayStr));
  const todayTotalRevenue = todaySales.reduce((sum, s) => sum + s.totalAmount, 0);
  const todayTotalUnits = todaySales.reduce((sum, s) => sum + s.quantity, 0);

  return (
    <div className="space-y-5 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">{t('sales.title')}</h2>
          <p className="text-xs text-zinc-400">{t('sales.subtitle')}</p>
        </div>

        <Button
          onClick={onOpenScanner}
          variant="primary"
          size="sm"
          leftIcon={<ScanBarcode className="w-4 h-4" />}
        >
          {t('sales.scanToSell')}
        </Button>
      </div>

      {/* Offline Queue Banner if items pending */}
      {offlineQueue.length > 0 && (
        <div className="p-3.5 bg-amber-950/40 border border-amber-800/80 rounded-2xl flex items-center justify-between gap-3 text-amber-200">
          <div className="flex items-center gap-2.5 min-w-0">
            <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="text-xs font-medium truncate">
              {t('sales.offlineQueuedCount').replace('{{count}}', String(offlineQueue.length))}
            </span>
          </div>
          <Button
            onClick={handleSyncOffline}
            variant="secondary"
            size="sm"
            className="h-8 text-xs shrink-0"
            isLoading={isSyncing}
            leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            {t('sales.syncNow')}
          </Button>
        </div>
      )}

      {syncStatusMsg && (
        <div className="p-3 bg-emerald-950/40 border border-emerald-800 text-emerald-300 rounded-xl text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{syncStatusMsg}</span>
        </div>
      )}

      {/* Primary Rapid Scan Action Card */}
      <div className="p-5 bg-gradient-to-br from-zinc-900 via-zinc-950 to-zinc-900 rounded-3xl border border-zinc-800 shadow-xl space-y-4">
        <button
          onClick={onOpenScanner}
          className="w-full py-4 px-4 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-2xl shadow-lg shadow-emerald-950/50 flex items-center justify-center gap-3 font-bold text-base transition-all select-none cursor-pointer"
        >
          <ScanBarcode className="w-6 h-6" />
          <span>Tap to Rapid Scan-to-Sell</span>
        </button>

        <p className="text-[11px] text-zinc-400 text-center leading-relaxed px-2">
          {t('sales.scanInstruction')}
        </p>

        {/* Manual Barcode entry for sales */}
        <form onSubmit={handleManualSearchSubmit} className="flex gap-2 pt-1">
          <Input
            placeholder="Type barcode to sell 1 unit..."
            value={manualBarcode}
            onChange={(e) => setManualBarcode(e.target.value)}
            leftIcon={<Barcode className="w-4 h-4 text-zinc-400" />}
          />
          <Button type="submit" variant="secondary" size="md" disabled={isProcessing}>
            Sell
          </Button>
        </form>
      </div>

      {/* Error Message if insufficient stock or unknown product */}
      {errorMessage && (
        <ErrorMessage
          variant="error"
          message={errorMessage}
          onDismiss={() => setErrorMessage(null)}
        />
      )}

      {/* Instant Scanned Item Result Banner */}
      {lastSaleResult && (
        <div className="p-4 bg-emerald-950/50 border border-emerald-500/50 rounded-2xl space-y-3 animate-in fade-in zoom-in-95 shadow-md">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-emerald-500 text-zinc-950">
                  {t('sales.soldOne')}
                </span>
                <span className="text-xs text-zinc-400 font-mono">
                  {lastSaleResult.product.barcode}
                </span>
              </div>
              <h3 className="text-base font-bold text-zinc-100 truncate mt-1">
                {lastSaleResult.product.name}
              </h3>
            </div>

            <div className="text-right shrink-0">
              <span className="text-base font-extrabold text-emerald-400 block">
                +R {Number(lastSaleResult.sale.totalAmount).toFixed(2)}
              </span>
              <span className="text-[11px] text-zinc-300 font-medium block">
                {lastSaleResult.remainingTotalStock} {t('sales.unitsRemaining')}
              </span>
            </div>
          </div>

          {/* Allocation details (FEFO confirmation) */}
          {lastSaleResult.allocations.length > 0 && (
            <div className="p-2.5 bg-zinc-950/80 rounded-xl border border-zinc-800 text-[11px] text-zinc-400 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-emerald-400" />
                <span>
                  Deducted from batch{' '}
                  {lastSaleResult.allocations[0].batchExpiryDate ? (
                    <strong className="text-amber-300 font-mono">
                      (Exp: {lastSaleResult.allocations[0].batchExpiryDate})
                    </strong>
                  ) : (
                    '(Non-perishable)'
                  )}
                </span>
              </span>
              <button
                onClick={() => openAdjustModal(lastSaleResult.product)}
                className="text-emerald-400 font-semibold hover:underline text-xs"
              >
                + Sell More Units
              </button>
            </div>
          )}
        </div>
      )}

      {/* Today's Counter Sales Metric Cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-4 bg-zinc-900/60 rounded-2xl border border-zinc-800">
          <span className="text-[11px] text-zinc-400 block">{t('sales.totalRevenue')}</span>
          <span className="text-xl font-extrabold text-emerald-400 mt-1 block">
            R {todayTotalRevenue.toFixed(2)}
          </span>
          <span className="text-[10px] text-zinc-500 mt-0.5 block">Today</span>
        </div>

        <div className="p-4 bg-zinc-900/60 rounded-2xl border border-zinc-800">
          <span className="text-[11px] text-zinc-400 block">{t('sales.unitsSold')}</span>
          <span className="text-xl font-extrabold text-zinc-100 mt-1 block">
            {todayTotalUnits} <span className="text-xs font-normal text-zinc-400">units</span>
          </span>
          <span className="text-[10px] text-zinc-500 mt-0.5 block">{todaySales.length} transactions</span>
        </div>
      </div>

      {/* Recent Transactions Feed */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold text-zinc-300 uppercase tracking-wider px-1">
          {t('sales.recentTransactions')}
        </h3>

        {salesHistory.length > 0 ? (
          <div className="space-y-2">
            {salesHistory.slice(0, 15).map((sale) => (
              <div
                key={sale.id}
                className="p-3.5 bg-zinc-950 rounded-2xl border border-zinc-800 flex items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-100">
                      Sold {sale.quantity} {sale.quantity === 1 ? 'unit' : 'units'}
                    </span>
                    <span className="text-[10px] text-zinc-400">
                      {new Date(sale.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <span className="text-[11px] text-zinc-400 truncate block mt-0.5 font-mono">
                    ID: {sale.id.slice(0, 16)}...
                  </span>
                </div>

                <div className="text-right shrink-0">
                  <span className="text-sm font-bold text-emerald-400">
                    +R {Number(sale.totalAmount).toFixed(2)}
                  </span>
                  <span className="text-[10px] text-zinc-500 block">
                    @ R {Number(sale.unitPrice).toFixed(2)} each
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 bg-zinc-900/40 rounded-2xl border border-dashed border-zinc-800 text-center text-xs text-zinc-400">
            <ShoppingCart className="w-8 h-8 mx-auto mb-2 text-zinc-500 opacity-60" />
            <p>{t('sales.noSalesToday')}</p>
          </div>
        )}
      </div>

      {/* Adjust Quantity Dialog */}
      {adjustModalProduct && (
        <Dialog
          isOpen={true}
          onClose={() => setAdjustModalProduct(null)}
          title={`Sell Multiple: ${adjustModalProduct.name}`}
          description={`Available in stock: ${adjustAvailableStock} units`}
          footer={
            <div className="flex w-full gap-2">
              <Button
                onClick={() => setAdjustModalProduct(null)}
                variant="secondary"
                size="md"
                className="flex-1"
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleAdjustSubmit}
                variant="primary"
                size="md"
                className="flex-1"
                disabled={isProcessing}
                isLoading={isProcessing}
              >
                Confirm Sale
              </Button>
            </div>
          }
        >
          <form onSubmit={handleAdjustSubmit} className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-zinc-300">
                Quantity to Sell
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const cur = parseInt(adjustQuantity, 10) || 1;
                    if (cur > 1) setAdjustQuantity(String(cur - 1));
                  }}
                  className="w-12 h-12 bg-zinc-900 rounded-xl border border-zinc-800 flex items-center justify-center font-bold text-lg text-zinc-200"
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
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>

              {/* Quick preset buttons */}
              <div className="grid grid-cols-4 gap-2 pt-1">
                {[2, 3, 5, 10].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => setAdjustQuantity(String(Math.min(num, adjustAvailableStock)))}
                    className="py-1.5 px-2 bg-zinc-900 hover:bg-zinc-800 text-xs font-semibold text-zinc-300 rounded-lg border border-zinc-800"
                  >
                    {num} units
                  </button>
                ))}
              </div>
            </div>

            {adjustModalProduct.sellingPrice != null && (
              <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800 flex items-center justify-between text-xs">
                <span className="text-zinc-400">Total Price:</span>
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
