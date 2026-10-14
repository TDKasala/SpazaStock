import { useCallback, useRef, useState } from 'react';
import type { Product, SaleResult } from '../types';
import { recordSale, type RecordSaleOutcome } from '../services/salesService';
import { searchProductByBarcode } from '../services/productService';
import { newId } from '../lib/ids';
import { useLanguage } from '../context/LanguageContext';

function vibrate(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Vibration can be blocked by the browser; feedback is best-effort.
  }
}

/**
 * Counter register state shared by camera scans (handled in App) and the Sales tab, so both
 * show the same result banner and inline errors.
 */
export function useSaleRegister(shopId: string, onUnknownBarcode: (barcode: string) => void) {
  const { t } = useLanguage();
  const [lastSaleResult, setLastSaleResult] = useState<SaleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const busyRef = useRef(false);

  const describeError = useCallback(
    (outcome: RecordSaleOutcome): string => {
      switch (outcome.errorCode) {
        case 'insufficient_stock':
          return t('sales.insufficientStockCount', { count: outcome.available ?? 0 });
        case 'duplicate':
          return t('sales.duplicateSale');
        case 'invalid_quantity':
          return t('stockIn.invalidQuantity');
        default:
          return outcome.error ?? t('errors.generic');
      }
    },
    [t]
  );

  /**
   * Sells `quantity` units. Pass the same `idempotencyKey` when retrying one user action so a
   * double tap can never record the sale twice.
   */
  const sellProduct = useCallback(
    async (product: Product, quantity: number, idempotencyKey: string = newId()) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setIsProcessing(true);
      setError(null);
      try {
        const outcome = await recordSale({ productId: product.id, quantity, idempotencyKey }, shopId);
        if (outcome.result) {
          vibrate([40, 30, 80]);
          setLastSaleResult(outcome.result);
          return true;
        }
        vibrate([150, 100, 150]);
        setError(describeError(outcome));
        return false;
      } catch (err) {
        setError(err instanceof Error ? err.message : t('errors.generic'));
        return false;
      } finally {
        busyRef.current = false;
        setIsProcessing(false);
      }
    },
    [shopId, describeError, t]
  );

  /** Rapid scan-to-sell: one unit per scan. Unknown barcodes go to product registration. */
  const sellBarcode = useCallback(
    async (barcode: string) => {
      const clean = barcode.trim();
      if (!clean) return false;
      const product = await searchProductByBarcode(clean, shopId);
      if (!product) {
        setError(t('sales.notRegistered', { barcode: clean }));
        onUnknownBarcode(clean);
        return false;
      }
      return sellProduct(product, 1);
    },
    [shopId, sellProduct, onUnknownBarcode, t]
  );

  return {
    lastSaleResult,
    error,
    isProcessing,
    sellProduct,
    sellBarcode,
    clearError: useCallback(() => setError(null), []),
  };
}

export type SaleRegister = ReturnType<typeof useSaleRegister>;
