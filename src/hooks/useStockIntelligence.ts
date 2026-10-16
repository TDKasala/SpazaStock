import { useEffect, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { DEVICE_SHOP_ID } from '../lib/constants';
import { signalAlert } from '../lib/feedback';
import { lowStockItems, recoveredProductIds, type LowStockItem } from '../lib/lowStock';
import { showLocalNotification } from '../lib/push';
import { getShopSettings } from '../lib/shopSettings';
import { forgetLowStockEpisodes, takeUnnotifiedLowStock } from '../services/alertNotifier';
import { clearLowStockDismissal, getLowStockDismissals } from '../services/lowStockService';
import { getSales } from '../services/salesService';
import { getProducts } from '../services/productService';
import { getAllProductsStockSummary } from '../services/stockService';
import type { Product, Sale, StockBatch } from '../types';

export interface StockIntelligenceState {
  lowStock: LowStockItem[];
  products: Product[];
  sales: Sale[];
  batches: StockBatch[];
  timezone: string;
  isLoading: boolean;
}

/**
 * Low-stock alerts and the sales used for best-seller rankings. Sound plays once per episode
 * on this phone. A dismissal, or stock rising above the minimum, ends that episode.
 */
export function useStockIntelligence(shopId: string, refreshTrigger: number): StockIntelligenceState {
  const { t } = useLanguage();
  const [state, setState] = useState<StockIntelligenceState>({
    lowStock: [],
    products: [],
    sales: [],
    batches: [],
    timezone: 'Africa/Johannesburg',
    isLoading: true,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [summaries, products, sales, dismissals, settings] = await Promise.all([
          getAllProductsStockSummary(shopId),
          getProducts(shopId, { includeArchived: true }),
          getSales(shopId),
          getLowStockDismissals(shopId),
          getShopSettings(shopId),
        ]);
        if (cancelled) return;

        const stock = summaries.map((summary) => ({
          ...summary.product,
          sellable: summary.totalQuantity,
          expired: summary.expiredQuantity,
        }));
        const recovered = recoveredProductIds(stock, dismissals);
        const recoveredIds = new Set(recovered);
        const openDismissals = dismissals.map((row) =>
          recoveredIds.has(row.productId) ? { ...row, clearedAt: row.clearedAt ?? new Date().toISOString() } : row
        );
        if (recovered.length > 0) {
          await forgetLowStockEpisodes(shopId, recovered);
          for (const productId of recovered) await clearLowStockDismissal(productId, shopId);
        }

        const lowStock = lowStockItems(stock, openDismissals);
        const batches = summaries.flatMap((summary) => summary.batches);
        setState({
          lowStock,
          products,
          sales,
          batches,
          timezone: settings.timezone,
          isLoading: false,
        });

        const fresh = await takeUnnotifiedLowStock(
          shopId,
          lowStock.filter((item) => !item.dismissed).map((item) => item.productId)
        );
        if (cancelled || fresh.length === 0) return;
        signalAlert();
        if (shopId === DEVICE_SHOP_ID && document.visibilityState === 'hidden') {
          for (const productId of fresh) {
            const item = lowStock.find((row) => row.productId === productId);
            if (!item) continue;
            await showLocalNotification(
              t('intelligence.notifyTitle', { name: item.name }),
              t('intelligence.notifyBody', { count: item.sellable, minimum: item.minimum }),
              `low-stock:${productId}`
            );
          }
        }
      } catch (err) {
        console.warn('Failed to load stock intelligence:', err);
        if (!cancelled) setState((current) => ({ ...current, isLoading: false }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` is a new function every render; the language does not change which products are low.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId, refreshTrigger]);

  return state;
}
