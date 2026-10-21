import React, { useEffect, useState } from 'react';
import { BookOpen, Search } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { adoptRemoteImage } from '../../services/productImageService';
import { retryFailedCatalogImages } from './ProductThumbnail';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { ProductThumbnail } from './ProductThumbnail';
import { PRODUCT_CATEGORIES } from './ProductFormFields';
import {
  adoptCatalogProduct,
  searchCatalog,
  type CatalogSearchHit,
  type CatalogServiceError,
  type CatalogStockLevel,
} from '../../services/catalogService';
import type { ProductCategory } from '../../types';

export interface CatalogAdoptDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function parsePrice(text: string): number | null | 'invalid' {
  if (!text.trim()) return null;
  const value = parseFloat(text.trim());
  return isNaN(value) || value < 0 ? 'invalid' : value;
}

function errorKey(error: CatalogServiceError | undefined): string {
  if (error?.code === 'not_configured') return 'catalog.notConfigured';
  if (error?.code === 'SP001') return 'catalog.suspended';
  return 'catalog.failed';
}

function picturePreview(hit: CatalogSearchHit): string | null {
  if (hit.imagePath || !hit.imageUrl?.startsWith('https://')) return null;
  return hit.imageUrl;
}

const PAGE_SIZE = 20;

const STOCK_LEVELS: CatalogStockLevel[] = ['in', 'out', 'low', 'expiring'];

const STOCK_LEVEL_LABEL: Record<CatalogStockLevel, string> = {
  in: 'stock.inStock',
  out: 'stock.outOfStock',
  low: 'stock.lowStock',
  expiring: 'stock.expiring',
};

const filterSelectClass = 'w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-3 text-sm text-zinc-100';

export const CatalogAdoptDialog: React.FC<CatalogAdoptDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const [term, setTerm] = useState('');
  const [showAdded, setShowAdded] = useState(false);
  const [category, setCategory] = useState<ProductCategory | ''>('');
  const [stock, setStock] = useState<CatalogStockLevel | ''>('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [items, setItems] = useState<CatalogSearchHit[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogSearchHit | null>(null);
  const [buyingPrice, setBuyingPrice] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [priceError, setPriceError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTerm('');
    setShowAdded(false);
    setCategory('');
    setStock('');
    setPage(0);
    setTotal(0);
    setItems([]);
    setChecked({});
    setSelected(null);
    setBuyingPrice('');
    setSellingPrice('');
    setPriceError(null);
    setNotice(null);
    setSearchError(null);
    setSearched(false);
  }, [isOpen]);

  useEffect(() => {
    document.querySelector<HTMLElement>('[data-testid="dialog-body"]')?.scrollTo({ top: 0 });
  }, [page]);

  useEffect(() => {
    if (!isOpen) return;
    const onOnline = () => {
      retryFailedCatalogImages();
      setReloadKey((value) => value + 1);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setSearchError(t('catalog.offline'));
      setSearching(false);
      setItems([]);
      setTotal(0);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      void searchCatalog(shopId, term.trim(), {
        inShop: stock ? null : showAdded,
        category: category || null,
        stock: stock || null,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }).then(
        (result) => {
          if (cancelled) return;
          setSearching(false);
          setSearched(true);
          if (result.error) {
            setItems([]);
            setTotal(0);
            setSearchError(t(errorKey(result.error)));
            return;
          }
          setItems(result.data.items);
          setTotal(result.data.total);
        }
      );
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, shopId, term, showAdded, category, stock, page, reloadKey, t]);

  const visible = stock
    ? items
    : items.filter((hit) => (showAdded ? hit.shopProductId != null : hit.shopProductId == null));
  const selectedCount = visible.filter((hit) => checked[hit.id]).length;

  const choose = (hit: CatalogSearchHit) => {
    setSelected(hit);
    setBuyingPrice('');
    setSellingPrice('');
    setPriceError(null);
    setNotice(null);
  };

  const toggle = (id: string) => {
    setChecked((current) => {
      const next = { ...current };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  };

  const selectAll = () => {
    setChecked((current) => {
      const next = { ...current };
      for (const hit of visible) next[hit.id] = true;
      return next;
    });
  };

  const rememberRemotePicture = async (hit: CatalogSearchHit, productId: string, imagePath: string | null) => {
    if (imagePath || hit.imagePath || !hit.imageUrl?.startsWith('https://')) return;
    await adoptRemoteImage(productId, shopId, hit.imageUrl);
  };

  const save = async () => {
    if (!selected) return;
    const buying = parsePrice(buyingPrice);
    const selling = parsePrice(sellingPrice);
    if (buying === 'invalid' || selling === 'invalid') {
      setPriceError(t('errors.invalidNumber'));
      return;
    }
    setSaving(true);
    setPriceError(null);
    const result = await adoptCatalogProduct(shopId, selected.id, {
      buyingPrice: selected.shopProductId ? null : buying,
      sellingPrice: selected.shopProductId ? null : selling,
    });
    setSaving(false);
    if (result.error) {
      setNotice(t(errorKey(result.error)));
      return;
    }
    if (result.data.product.archivedAt) {
      setNotice(t('catalog.archived'));
      return;
    }
    if (!result.data.created) {
      setNotice(t('catalog.alreadyInShop'));
      return;
    }
    await rememberRemotePicture(selected, result.data.product.id, result.data.product.imagePath ?? null);
    setItems((current) => current.filter((item) => item.id !== selected.id));
    setChecked((current) => {
      const next = { ...current };
      delete next[selected.id];
      return next;
    });
    setNotice(t('catalog.added'));
  };

  const addSelected = async () => {
    const chosen = visible.filter((hit) => checked[hit.id]);
    if (chosen.length === 0) return;
    setSaving(true);
    setNotice(null);
    const succeeded = new Set<string>();
    const failed: string[] = [];
    for (const hit of chosen) {
      const result = await adoptCatalogProduct(shopId, hit.id, { buyingPrice: null, sellingPrice: null });
      if (result.error) {
        failed.push(`${hit.name}: ${t(errorKey(result.error))}`);
        continue;
      }
      if (result.data.product.archivedAt) {
        failed.push(`${hit.name}: ${t('catalog.archived')}`);
        continue;
      }
      if (result.data.created) {
        await rememberRemotePicture(hit, result.data.product.id, result.data.product.imagePath ?? null);
      }
      succeeded.add(hit.id);
    }
    setItems((current) => current.filter((item) => !succeeded.has(item.id)));
    setChecked((current) => {
      const next = { ...current };
      for (const id of succeeded) delete next[id];
      return next;
    });
    if (selected && succeeded.has(selected.id)) setSelected(null);
    setSaving(false);
    if (failed.length > 0) setNotice(failed.join(' '));
    else setNotice(t('catalog.added'));
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('catalog.title')}
      description={t('catalog.description')}
      footer={
        total > PAGE_SIZE || selected ? (
          <div className="flex w-full flex-col gap-2">
            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={page === 0 || searching || saving}
                  onClick={() => {
                    setPage((value) => value - 1);
                    setChecked({});
                    setSelected(null);
                  }}
                >
                  {t('stock.previousPage')}
                </Button>
                <span className="text-center text-xs text-zinc-400">
                  {t('stock.pageRange', {
                    from: page * PAGE_SIZE + 1,
                    to: Math.min(total, (page + 1) * PAGE_SIZE),
                    total,
                  })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={page + 1 >= Math.ceil(total / PAGE_SIZE) || searching || saving}
                  onClick={() => {
                    setPage((value) => value + 1);
                    setChecked({});
                    setSelected(null);
                  }}
                >
                  {t('stock.nextPage')}
                </Button>
              </div>
            )}
            {selected && (
              <Button onClick={() => void save()} isLoading={saving} fullWidth leftIcon={<BookOpen className="w-4 h-4" />}>
                {selected.shopProductId ? t('catalog.useExisting') : t('catalog.add')}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <Input
          label={t('catalog.searchPlaceholder')}
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setPage(0);
            setSelected(null);
            setChecked({});
          }}
          leftIcon={<Search className="w-4 h-4" />}
          autoComplete="off"
        />
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={showAdded}
            disabled={Boolean(stock)}
            onChange={(event) => {
              setShowAdded(event.target.checked);
              setPage(0);
              setChecked({});
              setSelected(null);
            }}
          />
          {t('catalog.showInShop')}
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              {t('stock.categoryFilters')}
            </span>
            <select
              aria-label={t('stock.categoryFilters')}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value as ProductCategory | '');
                setPage(0);
                setChecked({});
                setSelected(null);
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
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              {t('stock.availabilityFilters')}
            </span>
            <select
              aria-label={t('stock.availabilityFilters')}
              value={stock}
              onChange={(event) => {
                setStock(event.target.value as CatalogStockLevel | '');
                setPage(0);
                setChecked({});
                setSelected(null);
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
        {searching && <p className="text-xs text-zinc-400">{t('catalog.searching')}</p>}
        {searchError && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-rose-300">{searchError}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {searched && !searching && !searchError && visible.length === 0 && (
          <p className="text-xs text-zinc-400">{t('catalog.empty')}</p>
        )}
        <ul className="space-y-2">
          {visible.map((hit) => (
            <li key={hit.id} className="flex items-start gap-2">
              {!showAdded && (
                <input
                  type="checkbox"
                  className="mt-3 h-5 w-5 shrink-0"
                  aria-label={hit.name}
                  checked={Boolean(checked[hit.id])}
                  disabled={saving}
                  onChange={() => toggle(hit.id)}
                />
              )}
              <button
                type="button"
                onClick={() => choose(hit)}
                className={`flex min-w-0 flex-1 items-center gap-3 rounded-xl border px-3 py-2 text-left ${
                  selected?.id === hit.id ? 'border-emerald-500 bg-emerald-950/40' : 'border-zinc-800 bg-zinc-900/60'
                }`}
              >
                <ProductThumbnail path={hit.imagePath} previewUrl={picturePreview(hit)} alt={hit.name} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-zinc-100">{hit.name}</span>
                  <span className="block text-xs text-zinc-400">
                    {[hit.brand, hit.packageSize, hit.barcodes[0]?.barcode].filter(Boolean).join(' · ')}
                  </span>
                  {hit.shopProductId && (
                    <span className="mt-1 inline-block text-[10px] uppercase tracking-wide text-emerald-300">
                      {t('catalog.inShop')}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!showAdded && visible.length > 0 && (
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-950 py-2">
            <span className="text-sm text-zinc-200">{t('catalog.selectedCount', { count: selectedCount })}</span>
            <Button type="button" size="sm" variant="outline" disabled={saving} onClick={selectAll}>
              {t('catalog.selectAll')}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={saving || selectedCount === 0} onClick={() => setChecked({})}>
              {t('catalog.clearSelection')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saving || selectedCount === 0}
              isLoading={saving}
              onClick={() => void addSelected()}
            >
              {t('catalog.addSelected')}
            </Button>
          </div>
        )}
        {selected && !selected.shopProductId && (
          <div className="grid grid-cols-2 gap-2">
            <Input
              label={t('catalog.buyingPrice')}
              value={buyingPrice}
              onChange={(event) => setBuyingPrice(event.target.value)}
              inputMode="decimal"
            />
            <Input
              label={t('catalog.sellingPrice')}
              value={sellingPrice}
              onChange={(event) => setSellingPrice(event.target.value)}
              inputMode="decimal"
            />
          </div>
        )}
        {priceError && <p className="text-xs text-rose-300">{priceError}</p>}
        {notice && <p className="text-xs text-zinc-200">{notice}</p>}
      </div>
    </Dialog>
  );
};
