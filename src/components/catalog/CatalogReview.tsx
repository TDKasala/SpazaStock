import React, { lazy, Suspense, useEffect, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { PRODUCT_CATEGORIES } from '../stock/ProductFormFields';
import { Button } from '../ui/Button';
import { ProductThumbnail, retryFailedCatalogImages } from '../stock/ProductThumbnail';
import { useLanguage } from '../../context/LanguageContext';
import {
  confirmShopCatalog,
  listShopCatalogReview,
  reviewShopCatalog,
  type CatalogDecision,
  type CatalogReviewItem,
  type CatalogReviewProgress,
  type CatalogServiceError,
  type CatalogStockLevel,
} from '../../services/catalogService';

const BarcodeScannerModal = lazy(() =>
  import('../scanner/BarcodeScannerModal').then((mod) => ({ default: mod.BarcodeScannerModal }))
);

const PAGE_SIZE = 20;

const STOCK_LEVELS: CatalogStockLevel[] = ['in', 'out', 'low', 'expiring'];

const STOCK_LEVEL_LABEL: Record<CatalogStockLevel, string> = {
  in: 'stock.inStock',
  out: 'stock.outOfStock',
  low: 'stock.lowStock',
  expiring: 'stock.expiring',
};

const filterSelectClass = 'w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-3 text-sm text-zinc-100';

interface Props {
  shopId: string;
  canEdit: boolean;
  /** Clears the new-shop prompt after the empty skip is saved. */
  onFinishLater?: () => void;
  /** Closes the screen when it was opened from More. */
  onClose?: () => void;
}

type PriceDraft = { buy: string; sell: string };

function priceOrNull(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function errorKey(error: CatalogServiceError | undefined): string {
  if (error?.code === 'not_configured') return 'catalog.notConfigured';
  if (error?.code === 'SP001') return 'catalog.suspended';
  return 'catalog.review.saveFailed';
}

export const CatalogReview: React.FC<Props> = ({ shopId, canEdit, onFinishLater, onClose }) => {
  const { t } = useLanguage();
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [status, setStatus] = useState<'' | 'open' | 'selling' | 'hidden'>('');
  const [category, setCategory] = useState('');
  const [stock, setStock] = useState<CatalogStockLevel | ''>('');
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<CatalogReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [progress, setProgress] = useState<CatalogReviewProgress>({ total: 0, selling: 0, hidden: 0, open: 0 });
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [prices, setPrices] = useState<Record<string, PriceDraft>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTerm(query.trim());
      setPage(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [page]);

  useEffect(() => {
    const onOnline = () => {
      retryFailedCatalogImages();
      setReloadKey((value) => value + 1);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  useEffect(() => {
    let active = true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setOffline(true);
      setLoading(false);
      setItems([]);
      return;
    }
    setOffline(false);
    setLoading(true);
    void listShopCatalogReview(shopId, {
      query: term,
      status: status || null,
      category: category || null,
      stock: stock || null,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }).then((result) => {
      if (!active) return;
      setLoading(false);
      if (result.error) {
        setError(t(result.error.code === 'not_configured' ? 'catalog.notConfigured' : 'catalog.review.loadFailed'));
        setItems([]);
        return;
      }
      setError(null);
      setItems(result.data.items);
      setTotal(result.data.total);
      setProgress(result.data.progress);
    });
    return () => {
      active = false;
    };
  }, [shopId, term, status, category, stock, page, reloadKey, t]);

  const draftPrices = (item: CatalogReviewItem): { buyingPrice: number | null; sellingPrice: number | null } | undefined => {
    if (item.shopProductId) return { buyingPrice: null, sellingPrice: null };
    const draft = prices[item.id] ?? { buy: '', sell: '' };
    const buyingPrice = priceOrNull(draft.buy);
    const sellingPrice = priceOrNull(draft.sell);
    if (buyingPrice === undefined || sellingPrice === undefined) return undefined;
    return { buyingPrice, sellingPrice };
  };

  const apply = async (decisions: CatalogDecision[]) => {
    if (!canEdit || decisions.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await reviewShopCatalog(shopId, decisions);
    setBusy(false);
    if (result.error) {
      setError(t(errorKey(result.error)));
      return;
    }
    setSelected({});
    setReloadKey((n) => n + 1);
  };

  const decide = (item: CatalogReviewItem, decision: 'sell' | 'hide') => {
    const priced = decision === 'sell' ? draftPrices(item) : { buyingPrice: null, sellingPrice: null };
    if (!priced) {
      setError(t('catalog.setup.priceInvalid'));
      return;
    }
    void apply([{ catalogProductId: item.id, decision, ...priced }]);
  };

  const decideSelected = (decision: 'sell' | 'hide') => {
    const decisions: CatalogDecision[] = [];
    for (const item of items) {
      if (!selected[item.id]) continue;
      if (decision === 'sell' && item.listed === true) continue;
      if (decision === 'hide' && item.listed === false) continue;
      const priced = decision === 'sell' ? draftPrices(item) : { buyingPrice: null, sellingPrice: null };
      if (!priced) {
        setError(t('catalog.setup.priceInvalid'));
        return;
      }
      decisions.push({ catalogProductId: item.id, decision, ...priced });
    }
    void apply(decisions);
  };

  const finishLater = async () => {
    if (!onFinishLater) return;
    setBusy(true);
    setError(null);
    const result = await confirmShopCatalog(shopId, []);
    if (result.error) {
      setError(t(errorKey(result.error)));
      setBusy(false);
      return;
    }
    onFinishLater();
  };

  const reviewed = progress.selling + progress.hidden;
  const width = progress.total === 0 ? 0 : Math.round((reviewed / progress.total) * 100);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectedCount = Object.keys(selected).length;

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100">
      <div className={`mx-auto flex min-h-dvh max-w-lg flex-col gap-4 px-4 py-6 ${total > PAGE_SIZE ? 'pb-44' : 'pb-28'}`}>
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{t('catalog.review.title')}</h1>
            <p className="mt-2 text-sm text-zinc-400">{t('catalog.review.body')}</p>
          </div>
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('catalog.review.close')}
            </Button>
          )}
        </header>

        <div>
          <p className="text-sm text-zinc-300">
            {t('catalog.review.progress', { done: reviewed, total: progress.total })}
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full bg-emerald-500" style={{ width: `${width}%` }} />
          </div>
        </div>

        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('catalog.searchPlaceholder')}
          className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-3 text-sm"
        />

        <div className="flex flex-wrap gap-2">
          {(
            [
              ['', 'catalog.review.allStatuses'],
              ['open', 'catalog.review.statusOpen'],
              ['selling', 'catalog.review.statusSelling'],
              ['hidden', 'catalog.review.statusHidden'],
            ] as const
          ).map(([value, key]) => (
            <button
              key={value || 'all'}
              type="button"
              onClick={() => {
                setStatus(value);
                setPage(0);
                setSelected({});
              }}
              className={`rounded-full px-3 py-1.5 text-sm ${
                status === value ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-300'
              }`}
            >
              {t(key)}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              {t('stock.categoryFilters')}
            </span>
            <select
              aria-label={t('stock.categoryFilters')}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setPage(0);
                setSelected({});
              }}
              className={filterSelectClass}
            >
              <option value="">{t('stock.allCategories')}</option>
              {PRODUCT_CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {t(`product.categories.${item}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              {t('stock.availabilityFilters')}
            </span>
            <select
              aria-label={t('stock.availabilityFilters')}
              value={stock}
              onChange={(event) => {
                setStock(event.target.value as CatalogStockLevel | '');
                setPage(0);
                setSelected({});
              }}
              className={filterSelectClass}
            >
              <option value="">{t('stock.allLevels')}</option>
              {STOCK_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(STOCK_LEVEL_LABEL[level])}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Button variant="outline" onClick={() => setScanning(true)} leftIcon={<ScanLine className="h-4 w-4" />}>
          {t('catalog.review.scan')}
        </Button>

        {offline && <p className="text-sm text-zinc-400">{t('catalog.offline')}</p>}
        {(offline || error) && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setReloadKey((value) => value + 1)}>
            {t('common.retry')}
          </Button>
        )}
        {loading && <p className="text-sm text-zinc-400">{t('catalog.searching')}</p>}
        {!loading && !offline && items.length === 0 && (
          <p className="text-sm text-zinc-300">{t('catalog.review.empty')}</p>
        )}

        <ul className="flex flex-col gap-3">
          {items.map((item) => {
            const open = item.shopProductId == null;
            return (
              <li key={item.id} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-start gap-3">
                  {canEdit && (
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={Boolean(selected[item.id])}
                      disabled={busy}
                      aria-label={item.name}
                      onChange={() =>
                        setSelected((current) => {
                          const next = { ...current };
                          if (next[item.id]) delete next[item.id];
                          else next[item.id] = true;
                          return next;
                        })
                      }
                    />
                  )}
                  <ProductThumbnail
                    path={item.imagePath}
                    previewUrl={!item.imagePath && item.imageUrl?.startsWith('https://') ? item.imageUrl : null}
                    alt={item.name}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{item.name}</p>
                    <p className="text-sm text-zinc-400">{[item.brand, item.packageSize].filter(Boolean).join(' · ')}</p>
                    {item.barcodes.length > 0 && (
                      <p className="mt-1 text-xs text-zinc-500">
                        {item.barcodes.map((code) => code.barcode).join(', ')}
                      </p>
                    )}
                    {item.listed === false && (
                      <p className="mt-1 text-sm text-zinc-400">{t('catalog.review.stockKept')}</p>
                    )}
                  </div>
                </div>
                {canEdit && open && (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label className="text-xs text-zinc-400">
                      {t('catalog.setup.buy')}
                      <input
                        aria-label={`${item.name} ${t('catalog.setup.buy')}`}
                        inputMode="decimal"
                        value={prices[item.id]?.buy ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          setPrices((current) => ({
                            ...current,
                            [item.id]: { buy: event.target.value, sell: current[item.id]?.sell ?? '' },
                          }))
                        }
                        className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                      />
                    </label>
                    <label className="text-xs text-zinc-400">
                      {t('catalog.setup.sell')}
                      <input
                        aria-label={`${item.name} ${t('catalog.setup.sell')}`}
                        inputMode="decimal"
                        value={prices[item.id]?.sell ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          setPrices((current) => ({
                            ...current,
                            [item.id]: { buy: current[item.id]?.buy ?? '', sell: event.target.value },
                          }))
                        }
                        className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                      />
                    </label>
                  </div>
                )}
                {canEdit && (
                  <div className="mt-3 flex gap-2">
                    {item.listed !== true && (
                      <Button size="sm" disabled={busy} onClick={() => decide(item, 'sell')}>
                        {open ? t('catalog.review.sell') : t('catalog.review.unhide')}
                      </Button>
                    )}
                    {item.listed !== false && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => decide(item, 'hide')}>
                        {t('catalog.review.hide')}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {onFinishLater && (
          <Button variant="outline" fullWidth disabled={busy} onClick={() => void finishLater()}>
            {t('catalog.review.finishLater')}
          </Button>
        )}
      </div>

      {(total > PAGE_SIZE || (canEdit && selectedCount > 0)) && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-zinc-950 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-lg flex-col gap-2">
            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" disabled={page === 0 || busy} onClick={() => setPage((n) => n - 1)}>
                  {t('stock.previousPage')}
                </Button>
                <span className="text-center text-sm text-zinc-400">
                  {t('stock.pageRange', { from: page * PAGE_SIZE + 1, to: Math.min(total, (page + 1) * PAGE_SIZE), total })}
                </span>
                <Button variant="ghost" size="sm" disabled={page + 1 >= pageCount || busy} onClick={() => setPage((n) => n + 1)}>
                  {t('stock.nextPage')}
                </Button>
              </div>
            )}
            {canEdit && selectedCount > 0 && (
              <div className="flex gap-2">
                <Button fullWidth disabled={busy} onClick={() => decideSelected('sell')}>
                  {t('catalog.review.sellSelected')}
                </Button>
                <Button fullWidth variant="outline" disabled={busy} onClick={() => decideSelected('hide')}>
                  {t('catalog.review.hideSelected')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {scanning && (
        <Suspense fallback={null}>
          <BarcodeScannerModal
            isOpen
            title={t('catalog.review.scan')}
            onClose={() => setScanning(false)}
            onBarcodeScanned={(code) => {
              setScanning(false);
              setQuery(code);
              setTerm(code);
              setPage(0);
            }}
          />
        </Suspense>
      )}
    </div>
  );
};
