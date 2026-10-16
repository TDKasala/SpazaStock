import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Product, ProductPackaging, SaleResult } from '../types';
import { isArchived, resolveBarcode } from '../services/productService';
import { getPendingSaleIds, saleNetQuantity, type SaleSyncState } from '../services/salesService';
import { createScanSeller, UNDO_WINDOW_MS, type ScanSellOutcome } from '../services/scanSell';
import { newId } from '../lib/ids';
import { onDataChanged } from '../lib/events';
import { signalError, signalNeutral, signalSuccess } from '../lib/feedback';
import { useLanguage } from '../context/LanguageContext';
import { useSyncStatus } from './useSyncStatus';

/** One sale recorded during the current rapid-sell session. */
export interface ScanLine {
  saleId: string;
  product: Product;
  quantity: number;
  voidedQuantity: number;
  unitPrice: number;
  remainingStock: number;
  expiryDate: string | null;
  soldAt: number;
}

/** Product read from the camera, waiting for the cashier to confirm quantity. */
export interface PendingScan {
  product: Product;
  packaging: ProductPackaging | null;
  quantity: number;
}

export interface RegisterNotice {
  tone: 'success' | 'info' | 'error';
  message: string;
  /** Changes on every notice so the UI can re-run its flash animation. */
  id: string;
}

export function canUndoLine(line: ScanLine, now: number = Date.now()): boolean {
  return saleNetQuantity(line) > 0 && now - line.soldAt < UNDO_WINDOW_MS;
}

/**
 * Counter register state shared by camera scans (handled in App) and the Sales tab, so both
 * show the same result banner, session lines and inline errors.
 */
export function useSaleRegister(shopId: string, onUnknownBarcode: (barcode: string) => void) {
  const { t } = useLanguage();
  const { status } = useSyncStatus();
  const seller = useMemo(() => createScanSeller(shopId), [shopId]);
  const [lastSaleResult, setLastSaleResult] = useState<SaleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<RegisterNotice | null>(null);
  const [inFlight, setInFlight] = useState(0);
  const [lines, setLines] = useState<ScanLine[]>([]);
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [syncStates, setSyncStates] = useState<Map<string, SaleSyncState>>(() => new Map());
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const refreshSyncStates = useCallback(async () => {
    setSyncStates(await getPendingSaleIds(shopId));
  }, [shopId]);

  useEffect(() => {
    void refreshSyncStates();
    return onDataChanged(() => void refreshSyncStates());
  }, [refreshSyncStates, status.pending, status.failed]);

  useEffect(() => {
    setLines([]);
    setLastSaleResult(null);
  }, [shopId]);

  const announce = useCallback((tone: RegisterNotice['tone'], message: string) => {
    setNotice({ tone, message, id: newId() });
    if (tone === 'success') signalSuccess();
    else if (tone === 'error') signalError();
    else signalNeutral();
  }, []);

  const track = useCallback(async <T,>(operation: Promise<T>): Promise<T> => {
    setInFlight((n) => n + 1);
    try {
      return await operation;
    } finally {
      setInFlight((n) => n - 1);
    }
  }, []);

  const updateStock = (productId: string, remainingStock: number) =>
    setLines((current) => current.map((l) => (l.product.id === productId ? { ...l, remainingStock } : l)));

  const handleSaleOutcome = useCallback(
    (outcome: ScanSellOutcome): boolean => {
      switch (outcome.kind) {
        case 'sold': {
          const { result } = outcome;
          setError(null);
          setLastSaleResult(result);
          setLines((current) => [
            {
              saleId: result.sale.id,
              product: result.product,
              quantity: result.sale.quantity,
              voidedQuantity: 0,
              unitPrice: result.sale.unitPrice,
              remainingStock: result.remainingTotalStock,
              expiryDate: result.allocations[0]?.batchExpiryDate ?? null,
              soldAt: Date.parse(result.sale.createdAt),
            },
            ...current.map((l) =>
              l.product.id === result.product.id ? { ...l, remainingStock: result.remainingTotalStock } : l
            ),
          ]);
          announce(
            'success',
            outcome.packaging
              ? t('rapid.soldPackageNotice', {
                  package: outcome.packaging.name,
                  count: result.sale.quantity,
                  name: result.product.name,
                  left: result.remainingTotalStock,
                })
              : t('rapid.soldNotice', {
                  count: result.sale.quantity,
                  name: result.product.name,
                  left: result.remainingTotalStock,
                })
          );
          void refreshSyncStates();
          return true;
        }
        case 'duplicate':
          announce('info', t('sales.duplicateSale'));
          return true;
        case 'insufficient_stock': {
          const base =
            outcome.available === 0
              ? t('rapid.outOfStock', { name: outcome.product.name })
              : t('sales.insufficientStockCount', { count: outcome.available });
          const message =
            outcome.expired > 0 ? `${base} ${t('expiry.expiredNotSellable', { count: outcome.expired })}` : base;
          setError(message);
          announce('error', message);
          return false;
        }
        case 'unknown_barcode': {
          const message = t('sales.notRegistered', { barcode: outcome.barcode });
          setError(message);
          announce('error', message);
          onUnknownBarcode(outcome.barcode);
          return false;
        }
        case 'archived': {
          const message = t('product.archivedNotice', { name: outcome.product.name });
          setError(message);
          announce('error', message);
          return false;
        }
        case 'error':
          setError(outcome.message || t('errors.generic'));
          announce('error', outcome.message || t('errors.generic'));
          return false;
      }
    },
    [announce, onUnknownBarcode, refreshSyncStates, t]
  );

  const runSale = useCallback(
    async (operation: Promise<ScanSellOutcome>): Promise<boolean> => {
      try {
        return handleSaleOutcome(await track(operation));
      } catch (err) {
        const message = err instanceof Error ? err.message : t('errors.generic');
        setError(message);
        announce('error', message);
        return false;
      }
    },
    [announce, handleSaleOutcome, t, track]
  );

  /**
   * Sells `quantity` units. Pass the same `idempotencyKey` when retrying one user action so a
   * double tap can never record the sale twice.
   */
  const sellProduct = useCallback(
    (product: Product, quantity: number, idempotencyKey: string = newId(), packaging?: ProductPackaging | null) =>
      runSale(seller.sell(product, quantity, idempotencyKey, packaging)),
    [runSale, seller]
  );

  /** Rapid scan-to-sell: one unit per scan. Unknown barcodes go to product registration. */
  const sellBarcode = useCallback(
    (barcode: string) => {
      if (!barcode.trim()) return Promise.resolve(false);
      return runSale(seller.scan(barcode, newId()));
    },
    [runSale, seller]
  );

  /**
   * Camera rapid sell: resolve the barcode and let the cashier set quantity before recording
   * the sale. Scanning the same code again bumps the staged quantity by one.
   */
  const stageBarcode = useCallback(
    async (barcode: string): Promise<boolean> => {
      const clean = barcode.trim();
      if (!clean) return false;
      const resolved = await resolveBarcode(clean, shopId);
      if (!resolved) {
        return handleSaleOutcome({ kind: 'unknown_barcode', barcode: clean });
      }
      const { product, packaging } = resolved;
      if (isArchived(product)) {
        return handleSaleOutcome({ kind: 'archived', product });
      }
      const defaultQty = packaging?.unitsPerPackage ?? 1;
      setPendingScan((current) => {
        if (current && current.product.id === product.id) {
          return { ...current, quantity: current.quantity + 1 };
        }
        return { product, packaging, quantity: defaultQty };
      });
      setError(null);
      announce('info', t('rapid.stagedNotice', { name: product.name }));
      return true;
    },
    [announce, handleSaleOutcome, shopId, t]
  );

  const setPendingQuantity = useCallback((quantity: number) => {
    if (!Number.isInteger(quantity) || quantity <= 0) return;
    setPendingScan((current) => (current ? { ...current, quantity } : null));
  }, []);

  const adjustPendingQuantity = useCallback((delta: number) => {
    setPendingScan((current) => {
      if (!current) return null;
      const next = Math.max(1, current.quantity + delta);
      return { ...current, quantity: next };
    });
  }, []);

  const clearPendingScan = useCallback(() => setPendingScan(null), []);

  const commitPendingSale = useCallback(() => {
    const staged = pendingScan;
    if (!staged) return Promise.resolve(false);
    setPendingScan(null);
    return sellProduct(staged.product, staged.quantity, newId(), staged.packaging);
  }, [pendingScan, sellProduct]);

  /** Undoes `quantity` units of a session line (all remaining units by default). */
  const undo = useCallback(
    async (saleId: string, quantity?: number): Promise<boolean> => {
      const line = linesRef.current.find((l) => l.saleId === saleId);
      if (!line || !canUndoLine(line)) return false;
      const amount = quantity ?? saleNetQuantity(line);
      try {
        const outcome = await track(seller.void(saleId, amount, newId()));
        switch (outcome.kind) {
          case 'voided': {
            const { result } = outcome;
            setLines((current) =>
              current.map((l) =>
                l.saleId === saleId ? { ...l, voidedQuantity: result.sale.voidedQuantity ?? 0 } : l
              )
            );
            updateStock(result.product.id, result.remainingTotalStock);
            setLastSaleResult((last) =>
              last && last.sale.id === saleId
                ? { ...last, sale: result.sale, remainingTotalStock: result.remainingTotalStock }
                : last
            );
            setError(null);
            announce(
              'info',
              t('rapid.undoneNotice', { count: amount, name: result.product.name, left: result.remainingTotalStock })
            );
            void refreshSyncStates();
            return true;
          }
          case 'duplicate':
            announce('info', t('rapid.alreadyUndone'));
            return true;
          case 'over_void':
            announce('error', t('rapid.nothingToUndo'));
            return false;
          case 'error':
            setError(outcome.message);
            announce('error', outcome.message);
            return false;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : t('errors.generic');
        setError(message);
        announce('error', message);
        return false;
      }
    },
    [announce, refreshSyncStates, seller, t, track]
  );

  const lastLine = lines[0] ?? null;

  /** Sells `n` more of the most recently scanned product as a new sale. */
  const increaseLast = useCallback(
    (n: number = 1) => {
      const line = linesRef.current[0];
      if (!line || !Number.isInteger(n) || n <= 0) return Promise.resolve(false);
      return sellProduct(line.product, n);
    },
    [sellProduct]
  );

  /** Takes one unit off the most recent undoable line of the last scanned product. */
  const decreaseLast = useCallback(() => {
    const last = linesRef.current[0];
    if (!last) return Promise.resolve(false);
    const line = linesRef.current.find((l) => l.product.id === last.product.id && canUndoLine(l));
    if (!line) return Promise.resolve(false);
    return undo(line.saleId, 1);
  }, [undo]);

  const resetSession = useCallback(() => {
    setLines([]);
    setPendingScan(null);
    setNotice(null);
    setError(null);
  }, []);

  return {
    lastSaleResult,
    error,
    notice,
    isProcessing: inFlight > 0,
    lines,
    lastLine,
    syncStates,
    sellProduct,
    sellBarcode,
    pendingScan,
    stageBarcode,
    setPendingQuantity,
    adjustPendingQuantity,
    clearPendingScan,
    commitPendingSale,
    increaseLast,
    decreaseLast,
    undo,
    resetSession,
    clearError: useCallback(() => setError(null), []),
  };
}

export type SaleRegister = ReturnType<typeof useSaleRegister>;
