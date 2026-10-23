import React, { useMemo, useState } from 'react';
import { ChevronLeft, MessageCircle } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { isBatchExpired, todayInZone } from '../../lib/expiry';
import { whatsappShareUrl } from '../../lib/invite';
import { parseMinStock } from '../../lib/lowStock';
import { formatRand, lineTotal, orderTotal, parseEstimatedCost, shoppingListText } from '../../lib/wholesaleOrders';
import type { Product, StockBatch } from '../../types';
import { ProductThumbnail } from '../stock/ProductThumbnail';
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
}

const fieldClass = 'w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-3 text-sm text-zinc-100';
const compactClass = 'shrink-0 rounded-xl border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100';

function sellableUnits(productId: string, batches: StockBatch[], today: string): number {
  return batches
    .filter((batch) => batch.productId === productId && batch.quantity > 0 && !isBatchExpired(batch, today))
    .reduce((sum, batch) => sum + batch.quantity, 0);
}

/** Blank or zero stays off the list. Anything else must be a whole number of units. */
function parseBuy(text: string): number | null | 'invalid' {
  const parsed = parseMinStock(text);
  if (parsed === 'invalid') return 'invalid';
  if (parsed == null || parsed === 0) return null;
  return parsed;
}

export const WholesaleOrders: React.FC<WholesaleOrdersProps> = ({ products, batches, timezone, onClose }) => {
  const { t } = useLanguage();
  const today = useMemo(() => todayInZone(timezone), [timezone]);
  const [query, setQuery] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [reviewIds, setReviewIds] = useState<string[] | null>(null);
  const [checked, setChecked] = useState(false);

  const rows = useMemo((): ProductRow[] => {
    return products
      .filter((product) => !product.archivedAt)
      .map((product) => ({
        product,
        sellable: sellableUnits(product.id, batches, today),
      }))
      .sort((a, b) => a.product.name.localeCompare(b.product.name));
  }, [products, batches, today]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return rows.filter((row) => !term || row.product.name.toLowerCase().includes(term));
  }, [rows, query]);

  const quantityOf = (productId: string): string => quantities[productId] ?? '';
  const priceOf = (productId: string): string => prices[productId] ?? '';

  const unitCostOf = (productId: string): number | null => {
    const parsed = parseEstimatedCost(priceOf(productId));
    return typeof parsed === 'number' ? parsed : null;
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
    return [{
      name: row.product.name,
      batchLabel: null,
      quantity,
      unitCost: unitCostOf(row.product.id),
    }];
  });

  const textLabels = { line: t('wholesale.lineTotal'), total: t('wholesale.total') };
  const orderAmount = orderTotal(shareLines.map((line) => ({ quantity: line.quantity, unitCost: line.unitCost })));

  const productLine = (row: ProductRow, onRemove?: () => void) => {
    const parsed = parseBuy(quantityOf(row.product.id));
    const cost = parseEstimatedCost(priceOf(row.product.id));
    const amount = typeof parsed === 'number' ? lineTotal(parsed, typeof cost === 'number' ? cost : null) : null;
    return (
      <div key={row.product.id} className="rounded-xl border border-zinc-800 p-3">
        <div className="flex flex-wrap items-center gap-2">
            <ProductThumbnail path={row.product.imagePath} size="sm" alt={row.product.name} />
            <p className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{row.product.name}</p>
            <p className="shrink-0 text-xs text-zinc-400">{t('wholesale.inStock', { count: row.sellable })}</p>
            <input
              aria-label={`${row.product.name} ${t('wholesale.buy')}`}
              inputMode="numeric"
              placeholder={t('wholesale.buy')}
              value={quantityOf(row.product.id)}
              onChange={(event) => setQuantities((current) => ({ ...current, [row.product.id]: event.target.value }))}
              className={`${compactClass} w-16`}
            />
            <input
              aria-label={`${row.product.name} ${t('wholesale.price')}`}
              inputMode="decimal"
              placeholder={t('wholesale.price')}
              value={priceOf(row.product.id)}
              onChange={(event) => setPrices((current) => ({ ...current, [row.product.id]: event.target.value }))}
              className={`${compactClass} w-24`}
            />
            {amount != null && <span className="shrink-0 text-xs text-zinc-200">{formatRand(amount)}</span>}
            {onRemove && (
              <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
                {t('wholesale.remove')}
              </Button>
            )}
        </div>
        {checked && parsed === 'invalid' && <p className="mt-2 text-xs text-rose-300">{t('catalog.intake.quantityInvalid')}</p>}
        {checked && cost === 'invalid' && <p className="mt-2 text-xs text-rose-300">{t('wholesale.priceInvalid')}</p>}
      </div>
    );
  };

  if (reviewIds) {
    const reviewRows = rows.filter((row) => reviewIds.includes(row.product.id));
    const text = shoppingListText(t('wholesale.title'), shareLines, textLabels);
    return (
      <div className="space-y-5 pb-24">
        <button type="button" onClick={() => setReviewIds(null)} className="inline-flex items-center gap-1 text-sm text-zinc-300">
          <ChevronLeft className="w-4 h-4" />
          {t('wholesale.backToProducts')}
        </button>
        <h2 className="text-lg font-bold text-zinc-100">{t('wholesale.title')}</h2>
        {reviewRows.map((row) =>
          productLine(row, () => {
            setReviewIds((current) => current?.filter((id) => id !== row.product.id) ?? null);
            setQuantities((current) => ({ ...current, [row.product.id]: '' }));
          })
        )}
        {orderAmount != null && (
          <p className="text-sm font-semibold text-zinc-100">
            {t('wholesale.total')}: {formatRand(orderAmount)}
          </p>
        )}
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
      {visible.map((row) => productLine(row))}
      <Button type="button" fullWidth onClick={openReview}>
        {t('wholesale.review')}
      </Button>
    </div>
  );
};
