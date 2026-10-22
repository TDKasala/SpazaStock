import React, { useMemo, useState } from 'react';
import { ChevronLeft, MessageCircle } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { parseLocalISODate } from '../../lib/dates';
import { isBatchExpired, todayInZone } from '../../lib/expiry';
import { whatsappShareUrl } from '../../lib/invite';
import { intlTag, isLocale } from '../../lib/languages';
import { parseMinStock } from '../../lib/lowStock';
import { shoppingListText } from '../../lib/wholesaleOrders';
import type { Product, StockBatch } from '../../types';
import { Button } from '../ui/Button';

export interface WholesaleOrdersProps {
  products: Product[];
  batches: StockBatch[];
  timezone: string;
  onClose: () => void;
}

interface ProductRow {
  product: Product;
  sellable: number;
  expiryBatches: StockBatch[];
}

const fieldClass = 'w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-3 text-sm text-zinc-100';

function sellableUnits(productId: string, batches: StockBatch[], today: string): number {
  return batches
    .filter((batch) => batch.productId === productId && batch.quantity > 0 && !isBatchExpired(batch, today))
    .reduce((sum, batch) => sum + batch.quantity, 0);
}

function formatExpiry(expiry: string, locale: string): string {
  const date = parseLocalISODate(expiry);
  if (!date) return expiry;
  return date.toLocaleDateString(isLocale(locale) ? intlTag(locale) : 'en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Blank or zero stays off the list. Anything else must be a whole number of units. */
function parseBuy(text: string): number | null | 'invalid' {
  const parsed = parseMinStock(text);
  if (parsed === 'invalid') return 'invalid';
  if (parsed == null || parsed === 0) return null;
  return parsed;
}

export const WholesaleOrders: React.FC<WholesaleOrdersProps> = ({ products, batches, timezone, onClose }) => {
  const { t, locale } = useLanguage();
  const today = useMemo(() => todayInZone(timezone), [timezone]);
  const [query, setQuery] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [batchChoice, setBatchChoice] = useState<Record<string, string>>({});
  const [reviewIds, setReviewIds] = useState<string[] | null>(null);
  const [checked, setChecked] = useState(false);

  const rows = useMemo((): ProductRow[] => {
    return products
      .filter((product) => !product.archivedAt)
      .map((product) => ({
        product,
        sellable: sellableUnits(product.id, batches, today),
        expiryBatches: batches
          .filter(
            (batch) =>
              batch.productId === product.id &&
              batch.quantity > 0 &&
              batch.expiryDate != null &&
              !isBatchExpired(batch, today)
          )
          .sort((a, b) => (a.expiryDate ?? '').localeCompare(b.expiryDate ?? '')),
      }))
      .sort((a, b) => a.product.name.localeCompare(b.product.name));
  }, [products, batches, today]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return rows.filter((row) => !term || row.product.name.toLowerCase().includes(term));
  }, [rows, query]);

  const quantityOf = (productId: string): string => quantities[productId] ?? '';

  const chosenBatch = (row: ProductRow): StockBatch | null => {
    const id = batchChoice[row.product.id];
    return row.expiryBatches.find((batch) => batch.id === id) ?? null;
  };

  const batchLabel = (batch: StockBatch): string => {
    const date = batch.expiryDate ? formatExpiry(batch.expiryDate, locale) : '';
    return `${date} · ${t('wholesale.inStock', { count: batch.quantity })}`;
  };

  const openReview = () => {
    setChecked(true);
    const ids = rows
      .filter((row) => typeof parseBuy(quantityOf(row.product.id)) === 'number')
      .map((row) => row.product.id);
    if (ids.length > 0) setReviewIds(ids);
  };

  const shareLines = rows.flatMap((row) => {
    if (!reviewIds?.includes(row.product.id)) return [];
    const quantity = parseBuy(quantityOf(row.product.id));
    if (typeof quantity !== 'number') return [];
    const batch = chosenBatch(row);
    return [{
      name: row.product.name,
      batchLabel: batch?.expiryDate ? formatExpiry(batch.expiryDate, locale) : null,
      stockLabel: t('wholesale.inStock', { count: row.sellable }),
      buyLabel: t('wholesale.lineBuy', { count: quantity }),
    }];
  });

  if (reviewIds) {
    const reviewRows = rows.filter((row) => reviewIds.includes(row.product.id));
    const text = shoppingListText(t('wholesale.title'), shareLines);
    return (
      <div className="space-y-5 pb-24">
        <button type="button" onClick={() => setReviewIds(null)} className="inline-flex items-center gap-1 text-sm text-zinc-300">
          <ChevronLeft className="w-4 h-4" />
          {t('wholesale.backToProducts')}
        </button>
        <h2 className="text-lg font-bold text-zinc-100">{t('wholesale.title')}</h2>
        {reviewRows.map((row) => {
          const batch = chosenBatch(row);
          const parsed = parseBuy(quantityOf(row.product.id));
          return (
            <div key={row.product.id} className="space-y-2 rounded-xl border border-zinc-800 p-3">
              <p className="text-sm font-semibold text-zinc-100">{row.product.name}</p>
              {batch && <p className="text-xs text-zinc-400">{batchLabel(batch)}</p>}
              <p className="text-xs text-zinc-400">{t('wholesale.inStock', { count: row.sellable })}</p>
              <label className="block text-xs text-zinc-400">
                {t('wholesale.buy')}
                <input
                  aria-label={`${row.product.name} ${t('wholesale.buy')}`}
                  inputMode="numeric"
                  value={quantityOf(row.product.id)}
                  onChange={(event) => setQuantities((current) => ({ ...current, [row.product.id]: event.target.value }))}
                  className={`${fieldClass} mt-1`}
                />
              </label>
              {parsed === 'invalid' && <p className="text-xs text-rose-300">{t('catalog.intake.quantityInvalid')}</p>}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setReviewIds((current) => current?.filter((id) => id !== row.product.id) ?? null);
                  setQuantities((current) => ({ ...current, [row.product.id]: '' }));
                }}
              >
                {t('wholesale.remove')}
              </Button>
            </div>
          );
        })}
        <a
          href={whatsappShareUrl(text)}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full inline-flex items-center justify-center gap-2 min-h-[46px] rounded-xl text-sm font-semibold bg-[#25D366]/15 hover:bg-[#25D366]/25 text-emerald-100 border border-[#25D366]/40 transition-colors"
        >
          <MessageCircle className="w-4 h-4 shrink-0" aria-hidden />
          {t('wholesale.share')}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-24">
      <button type="button" onClick={onClose} className="inline-flex items-center gap-1 text-sm text-zinc-300">
        <ChevronLeft className="w-4 h-4" />
        {t('wholesale.close')}
      </button>
      <h2 className="text-lg font-bold text-zinc-100">{t('wholesale.title')}</h2>
      <input
        aria-label={t('wholesale.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('wholesale.search')}
        className={fieldClass}
      />
      {visible.length === 0 && <p className="text-sm text-zinc-400">{t('wholesale.empty')}</p>}
      {visible.map((row) => {
        const parsed = parseBuy(quantityOf(row.product.id));
        return (
          <div key={row.product.id} className="space-y-2 rounded-xl border border-zinc-800 p-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-semibold text-zinc-100">{row.product.name}</p>
              <p className="text-xs text-zinc-400">{t('wholesale.inStock', { count: row.sellable })}</p>
            </div>
            {row.expiryBatches.length > 0 && (
              <label className="block text-xs text-zinc-400">
                {t('wholesale.batch')}
                <select
                  aria-label={`${row.product.name} ${t('wholesale.batch')}`}
                  value={batchChoice[row.product.id] ?? ''}
                  onChange={(event) => setBatchChoice((current) => ({ ...current, [row.product.id]: event.target.value }))}
                  className={`${fieldClass} mt-1`}
                >
                  <option value="">{t('wholesale.noBatch')}</option>
                  {row.expiryBatches.map((batch) => (
                    <option key={batch.id} value={batch.id}>
                      {batchLabel(batch)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-xs text-zinc-400">
              {t('wholesale.buy')}
              <input
                aria-label={`${row.product.name} ${t('wholesale.buy')}`}
                inputMode="numeric"
                value={quantityOf(row.product.id)}
                onChange={(event) => setQuantities((current) => ({ ...current, [row.product.id]: event.target.value }))}
                className={`${fieldClass} mt-1`}
              />
            </label>
            {checked && parsed === 'invalid' && <p className="text-xs text-rose-300">{t('catalog.intake.quantityInvalid')}</p>}
          </div>
        );
      })}
      <Button type="button" fullWidth onClick={openReview}>
        {t('wholesale.review')}
      </Button>
    </div>
  );
};
