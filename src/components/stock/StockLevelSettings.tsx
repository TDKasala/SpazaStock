import React, { useMemo, useState } from 'react';
import { Package } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { isBatchExpired, todayInZone } from '../../lib/expiry';
import { parseMinStock } from '../../lib/lowStock';
import { setProductMinStock } from '../../services/productService';
import type { Product, StockBatch } from '../../types';

export interface StockLevelSettingsProps {
  shopId: string;
  canEdit: boolean;
  products: Product[];
  batches: StockBatch[];
  timezone: string;
}

function sellableUnits(productId: string, batches: StockBatch[], today: string): number {
  return batches
    .filter((batch) => batch.productId === productId && batch.quantity > 0 && !isBatchExpired(batch, today))
    .reduce((sum, batch) => sum + batch.quantity, 0);
}

/** Owners and managers set each product's minimum. Staff can read the numbers. */
export const StockLevelSettings: React.FC<StockLevelSettingsProps> = ({
  shopId,
  canEdit,
  products,
  batches,
  timezone,
}) => {
  const { t } = useLanguage();
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const today = useMemo(() => todayInZone(timezone), [timezone]);

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return products
      .filter((product) => !product.archivedAt)
      .filter((product) => !term || product.name.toLowerCase().includes(term))
      .map((product) => ({ product, sellable: sellableUnits(product.id, batches, today) }))
      .sort((a, b) => a.product.name.localeCompare(b.product.name));
  }, [products, batches, today, query]);

  const valueFor = (product: Product): string =>
    drafts[product.id] ?? (product.minStockUnits == null ? '' : String(product.minStockUnits));

  const save = async (product: Product) => {
    if (!canEdit) return;
    const text = valueFor(product);
    const parsed = parseMinStock(text);
    if (parsed === 'invalid') {
      setErrors((current) => ({ ...current, [product.id]: t('intelligence.minStockInvalid') }));
      setSaved(false);
      return;
    }
    setErrors((current) => {
      const next = { ...current };
      delete next[product.id];
      return next;
    });
    if (parsed === (product.minStockUnits ?? null)) return;

    setSavingId(product.id);
    try {
      const result = await setProductMinStock(product.id, parsed, shopId);
      if (result.product) {
        setSaved(true);
        setDrafts((current) => {
          const next = { ...current };
          delete next[product.id];
          return next;
        });
      } else setErrors((current) => ({ ...current, [product.id]: t('intelligence.minStockInvalid') }));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3.5 space-y-3">
      <h3 className="text-xs font-semibold text-zinc-100 flex items-center gap-1.5">
        <Package className="w-3.5 h-3.5 text-zinc-400" />
        {t('intelligence.levelsTitle')}
      </h3>
      <p className="text-[11px] text-zinc-400 leading-relaxed">{t('intelligence.levelsHint')}</p>
      <p className="text-[11px] text-zinc-400 leading-relaxed">{t('intelligence.levelsPhone')}</p>
      {!canEdit && <p className="text-[11px] text-zinc-500">{t('intelligence.levelsReadOnly')}</p>}

      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('intelligence.levelsSearch')}
        aria-label={t('intelligence.levelsSearch')}
        className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500"
      />

      <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
        {rows.length === 0 ? (
          <p className="text-xs text-zinc-500 px-1">{t('intelligence.levelsEmpty')}</p>
        ) : (
          rows.map(({ product, sellable }) => (
            <div key={product.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-zinc-100 truncate">{product.name}</span>
                <span className="text-[11px] text-zinc-400 shrink-0">{t('intelligence.onHand', { count: sellable })}</span>
              </div>
              <input
                inputMode="numeric"
                aria-label={`${product.name} ${t('intelligence.minStock')}`}
                value={valueFor(product)}
                disabled={!canEdit || savingId === product.id}
                placeholder={t('intelligence.minStock')}
                onChange={(event) => {
                  setDrafts((current) => ({ ...current, [product.id]: event.target.value }));
                  setSaved(false);
                  setErrors((current) => {
                    const next = { ...current };
                    delete next[product.id];
                    return next;
                  });
                }}
                onBlur={() => void save(product)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void save(product);
                  }
                }}
                className="mt-2 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-100 disabled:opacity-60"
              />
              {errors[product.id] && <p className="mt-1 text-[11px] text-rose-400">{errors[product.id]}</p>}
            </div>
          ))
        )}
      </div>
      {saved && <p className="text-xs text-emerald-400">{t('intelligence.levelsSaved')}</p>}
    </section>
  );
};
