import React, { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { useLanguage } from '../../context/LanguageContext';
import {
  confirmShopCatalog,
  listCommonCatalog,
  type CatalogSelection,
  type CommonCatalogItem,
} from '../../services/catalogService';

interface Props {
  shopId: string;
  onDone: () => void;
}

type PriceDraft = { buy: string; sell: string };

function priceOrNull(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export const CommonCatalogSetup: React.FC<Props> = ({ shopId, onDone }) => {
  const { t } = useLanguage();
  const [items, setItems] = useState<CommonCatalogItem[] | null>(null);
  const [selected, setSelected] = useState<Record<string, PriceDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void listCommonCatalog(shopId).then((result) => {
      if (!active) return;
      if (result.error) {
        setError(t('catalog.setup.loadFailed'));
        setItems([]);
        return;
      }
      setItems(result.data);
    });
    return () => {
      active = false;
    };
  }, [shopId, t]);

  const toggle = (id: string) => {
    setSelected((current) => {
      if (current[id]) {
        const next = { ...current };
        delete next[id];
        return next;
      }
      return { ...current, [id]: { buy: '', sell: '' } };
    });
  };

  const submit = async (skip: boolean) => {
    const selections: CatalogSelection[] = [];
    if (!skip) {
      for (const [catalogProductId, prices] of Object.entries(selected)) {
        const buyingPrice = priceOrNull(prices.buy);
        const sellingPrice = priceOrNull(prices.sell);
        if (buyingPrice === undefined || sellingPrice === undefined) {
          setError(t('catalog.setup.priceInvalid'));
          return;
        }
        selections.push({ catalogProductId, buyingPrice, sellingPrice });
      }
    }

    setBusy(true);
    setError(null);
    const result = await confirmShopCatalog(shopId, selections);
    if (result.error) {
      setError(t('catalog.setup.saveFailed'));
      setBusy(false);
      return;
    }
    onDone();
  };

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100 px-4 py-8">
      <div className="mx-auto flex max-w-lg flex-col gap-6">
        <header>
          <h1 className="text-2xl font-semibold">{t('catalog.setup.title')}</h1>
          <p className="mt-2 text-sm text-zinc-400">{t('catalog.setup.body')}</p>
        </header>

        {items === null && <p className="text-sm text-zinc-400">{t('catalog.setup.loading')}</p>}

        {items !== null && items.length === 0 && (
          <p className="text-sm text-zinc-300">{t('catalog.setup.empty')}</p>
        )}

        {items !== null && items.length > 0 && (
          <ul className="flex flex-col gap-3">
            {items.map((item) => {
              const draft = selected[item.id];
              const already = item.shopProductId !== null;
              return (
                <li key={item.id} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={already || Boolean(draft)}
                      disabled={already || busy}
                      onChange={() => toggle(item.id)}
                    />
                    <span>
                      <span className="block font-medium">{item.name}</span>
                      <span className="block text-sm text-zinc-400">
                        {[item.brand, item.packageSize].filter(Boolean).join(' · ')}
                      </span>
                      {already && (
                        <span className="mt-1 block text-sm text-emerald-400">{t('catalog.inShop')}</span>
                      )}
                    </span>
                  </label>
                  {draft && (
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <label className="text-xs text-zinc-400">
                        {t('catalog.setup.buy')}
                        <input
                          aria-label={t('catalog.setup.buy')}
                          inputMode="decimal"
                          value={draft.buy}
                          disabled={busy}
                          onChange={(event) =>
                            setSelected((current) => ({
                              ...current,
                              [item.id]: { ...draft, buy: event.target.value },
                            }))
                          }
                          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                        />
                      </label>
                      <label className="text-xs text-zinc-400">
                        {t('catalog.setup.sell')}
                        <input
                          aria-label={t('catalog.setup.sell')}
                          inputMode="decimal"
                          value={draft.sell}
                          disabled={busy}
                          onChange={(event) =>
                            setSelected((current) => ({
                              ...current,
                              [item.id]: { ...draft, sell: event.target.value },
                            }))
                          }
                          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                        />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex flex-col gap-3">
          <Button
            fullWidth
            disabled={busy || items === null || Object.keys(selected).length === 0}
            isLoading={busy}
            onClick={() => void submit(false)}
          >
            {t('catalog.setup.confirm')}
          </Button>
          <Button variant="outline" fullWidth disabled={busy || items === null} onClick={() => void submit(true)}>
            {t('catalog.setup.skip')}
          </Button>
        </div>
      </div>
    </div>
  );
};
