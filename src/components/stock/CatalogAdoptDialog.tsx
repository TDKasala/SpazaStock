import React, { useEffect, useState } from 'react';
import { BookOpen, Search } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop, useShopId } from '../../context/ShopContext';
import { adoptRemoteImage } from '../../services/productImageService';
import { retryFailedCatalogImages } from './ProductThumbnail';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { ProductThumbnail } from './ProductThumbnail';
import { PRODUCT_CATEGORIES } from './ProductFormFields';
import {
  confirmCatalogIntake,
  searchCatalog,
  type CatalogSearchHit,
  type CatalogServiceError,
  type CatalogStockLevel,
} from '../../services/catalogService';
import { loadCatalogIntakeDraft, saveCatalogIntakeDraft } from '../../services/catalogIntakeDraft';
import {
  MAX_BATCHES_PER_PRODUCT,
  MAX_INTAKE_PRODUCTS,
  emptyBatch,
  intakeItemFromHit,
  intakeProblems,
  intakeUnits,
  parseIntakePrice,
  type IntakeBatchDraft,
  type IntakeItemDraft,
  type IntakeStep,
} from '../../lib/catalogIntake';
import { todayInZone } from '../../lib/expiry';
import type { ProductCategory } from '../../types';

export interface CatalogAdoptDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function errorKey(error: CatalogServiceError | undefined): string {
  if (error?.code === 'not_configured') return 'catalog.notConfigured';
  if (error?.code === 'SP001') return 'catalog.suspended';
  if (error?.code === '22023') return 'catalog.intake.expiryPast';
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
const fieldClass = 'w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-3 text-sm text-zinc-100';

export const CatalogAdoptDialog: React.FC<CatalogAdoptDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const { settings } = useShop();
  const today = todayInZone(settings.timezone);
  const [term, setTerm] = useState('');
  const [showAdded, setShowAdded] = useState(false);
  const [category, setCategory] = useState<ProductCategory | ''>('');
  const [stock, setStock] = useState<CatalogStockLevel | ''>('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [items, setItems] = useState<CatalogSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogSearchHit | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<IntakeStep>('select');
  const [countIndex, setCountIndex] = useState(0);
  const [draftItems, setDraftItems] = useState<IntakeItemDraft[]>([]);
  const [draftReady, setDraftReady] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setDraftReady(false);
      return;
    }
    let cancelled = false;
    void loadCatalogIntakeDraft(shopId).then((draft) => {
      if (cancelled) return;
      if (draft && draft.items.length > 0) {
        setDraftItems(draft.items);
        setStep(draft.step);
        setCountIndex(Math.min(draft.countIndex, Math.max(0, draft.items.length - 1)));
      }
      setDraftReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, shopId]);

  useEffect(() => {
    if (!isOpen || !draftReady) return;
    void saveCatalogIntakeDraft(shopId, { step, countIndex, items: draftItems });
  }, [isOpen, draftReady, shopId, step, countIndex, draftItems]);

  useEffect(() => {
    if (draftItems.length === 0 && step !== 'select') setStep('select');
    else if (countIndex >= draftItems.length && draftItems.length > 0) setCountIndex(draftItems.length - 1);
  }, [draftItems.length, countIndex, step]);

  useEffect(() => {
    document.querySelector<HTMLElement>('[data-testid="dialog-body"]')?.scrollTo({ top: 0 });
  }, [page, step, countIndex]);

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
    if (!isOpen || step !== 'select') return;
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
      }).then((result) => {
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
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, shopId, term, showAdded, category, stock, page, reloadKey, step, t]);

  const visible = stock
    ? items
    : items.filter((hit) => (showAdded ? hit.shopProductId != null : hit.shopProductId == null));
  const chosenIds = new Set(draftItems.map((item) => item.hit.id));
  const selectedCount = draftItems.length;
  const current = draftItems[countIndex] ?? null;
  const problems = intakeProblems(draftItems, today);
  const reviewBlocked = problems.length > 0;

  const toggle = (hit: CatalogSearchHit) => {
    if (hit.shopProductId) return;
    setNotice(null);
    setDraftItems((currentItems) => {
      if (currentItems.some((item) => item.hit.id === hit.id)) {
        return currentItems.filter((item) => item.hit.id !== hit.id);
      }
      if (currentItems.length >= MAX_INTAKE_PRODUCTS) return currentItems;
      return [...currentItems, intakeItemFromHit(hit)];
    });
  };

  const selectAll = () => {
    setDraftItems((currentItems) => {
      const next = [...currentItems];
      for (const hit of visible) {
        if (hit.shopProductId || next.some((item) => item.hit.id === hit.id)) continue;
        if (next.length >= MAX_INTAKE_PRODUCTS) break;
        next.push(intakeItemFromHit(hit));
      }
      return next;
    });
  };

  const patchItem = (catalogProductId: string, patch: (item: IntakeItemDraft) => IntakeItemDraft) => {
    setDraftItems((currentItems) => currentItems.map((item) => (item.hit.id === catalogProductId ? patch(item) : item)));
  };

  const patchBatch = (catalogProductId: string, batchId: string, patch: (batch: IntakeBatchDraft) => IntakeBatchDraft) => {
    patchItem(catalogProductId, (item) => ({
      ...item,
      batches: item.batches.map((batch) => (batch.id === batchId ? patch(batch) : batch)),
    }));
  };

  const rememberRemotePicture = async (hit: CatalogSearchHit, productId: string, imagePath: string | null) => {
    if (imagePath || hit.imagePath || !hit.imageUrl?.startsWith('https://')) return;
    await adoptRemoteImage(productId, shopId, hit.imageUrl);
  };

  const confirm = async () => {
    if (reviewBlocked || draftItems.length === 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setNotice(t('catalog.intake.offlineConfirm'));
      return;
    }
    setSaving(true);
    setNotice(null);
    const result = await confirmCatalogIntake(shopId, draftItems, today);
    setSaving(false);
    if (result.error) {
      setNotice(t(errorKey(result.error)));
      return;
    }
    const done = new Set(result.data.map((item) => item.catalogProductId));
    for (const item of result.data) {
      if (!item.created) continue;
      const hit = draftItems.find((row) => row.hit.id === item.catalogProductId)?.hit;
      if (hit) await rememberRemotePicture(hit, item.product.id, item.product.imagePath ?? null);
    }
    const remaining = draftItems.filter((item) => !done.has(item.hit.id));
    setDraftItems(remaining);
    setItems((currentItems) => currentItems.filter((item) => !done.has(item.id)));
    setStep('select');
    setCountIndex(0);
    setNotice(t('catalog.intake.saved'));
  };

  const goCount = () => {
    if (draftItems.length === 0) return;
    setCountIndex(0);
    setStep('count');
    setNotice(null);
  };

  const footer = (() => {
    if (step === 'count' && current) {
      const last = countIndex >= draftItems.length - 1;
      return (
        <div className="flex w-full items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => (countIndex === 0 ? setStep('select') : setCountIndex((value) => value - 1))}>
            {t('stock.previousPage')}
          </Button>
          <span className="flex-1 text-center text-xs text-zinc-400">
            {t('catalog.intake.stepCount', { current: countIndex + 1, total: draftItems.length })}
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => (last ? setStep('review') : setCountIndex((value) => value + 1))}
          >
            {last ? t('catalog.intake.review') : t('stock.nextPage')}
          </Button>
        </div>
      );
    }
    if (step === 'review') {
      return (
        <div className="flex w-full gap-2">
          <Button type="button" variant="ghost" className="flex-1" disabled={saving} onClick={() => setStep('count')}>
            {t('stock.previousPage')}
          </Button>
          <Button type="button" className="flex-1" disabled={saving || reviewBlocked || draftItems.length === 0} isLoading={saving} onClick={() => void confirm()}>
            {t('catalog.add')}
          </Button>
        </div>
      );
    }
    return (
      <div className="flex w-full flex-col gap-2">
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={page === 0 || searching} onClick={() => setPage((value) => value - 1)}>
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
              disabled={page + 1 >= Math.ceil(total / PAGE_SIZE) || searching}
              onClick={() => setPage((value) => value + 1)}
            >
              {t('stock.nextPage')}
            </Button>
          </div>
        )}
        {selectedCount > 0 && (
          <Button type="button" fullWidth onClick={goCount} leftIcon={<BookOpen className="w-4 h-4" />}>
            {t('catalog.intake.countStock')} ({selectedCount})
          </Button>
        )}
        {selected?.shopProductId && (
          <Button type="button" fullWidth variant="secondary" onClick={() => setNotice(t('catalog.alreadyInShop'))}>
            {t('catalog.useExisting')}
          </Button>
        )}
      </div>
    );
  })();

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('catalog.title')}
      description={step === 'select' ? t('catalog.description') : t('catalog.intake.reviewHint')}
      footer={step !== 'select' || total > PAGE_SIZE || selectedCount > 0 || selected ? footer : undefined}
    >
      {step === 'count' && current && (
        <div className="space-y-3 pb-2" data-testid="intake-count">
          <div className="flex items-center gap-3">
            <ProductThumbnail path={current.hit.imagePath} previewUrl={picturePreview(current.hit)} alt={current.hit.name} />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-100">{current.hit.name}</p>
              <p className="text-xs text-zinc-400">{[current.hit.brand, current.hit.packageSize].filter(Boolean).join(' · ')}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              label={t('catalog.buyingPrice')}
              value={current.buyingPrice}
              onChange={(event) => patchItem(current.hit.id, (item) => ({ ...item, buyingPrice: event.target.value }))}
              inputMode="decimal"
            />
            <Input
              label={t('catalog.sellingPrice')}
              value={current.sellingPrice}
              onChange={(event) => patchItem(current.hit.id, (item) => ({ ...item, sellingPrice: event.target.value }))}
              inputMode="decimal"
            />
          </div>
          {(parseIntakePrice(current.buyingPrice) === 'invalid' || parseIntakePrice(current.sellingPrice) === 'invalid') && (
            <p className="text-xs text-rose-300">{t('catalog.setup.priceInvalid')}</p>
          )}
          {current.batches.map((batch, index) => {
            const quantityBad = problems.some((problem) => problem.batchId === batch.id && problem.field === 'quantity');
            const expiryBad = problems.some((problem) => problem.batchId === batch.id && problem.field === 'expiry');
            return (
              <fieldset key={batch.id} className="space-y-2 rounded-xl border border-zinc-800 p-3">
                <legend className="px-1 text-xs font-medium text-zinc-300">
                  {t('catalog.intake.batchLabel', { count: index + 1 })}
                </legend>
                <label className="block text-xs text-zinc-300">
                  {t('catalog.intake.quantity')}
                  <input
                    aria-label={`${current.hit.name} ${t('catalog.intake.quantity')} ${index + 1}`}
                    inputMode="numeric"
                    value={batch.quantity}
                    onChange={(event) =>
                      patchBatch(current.hit.id, batch.id, (row) => ({ ...row, quantity: event.target.value }))
                    }
                    className={`${fieldClass} mt-1`}
                  />
                </label>
                {quantityBad && <p className="text-xs text-rose-300">{t('catalog.intake.quantityInvalid')}</p>}
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={!batch.expires}
                    onChange={(event) =>
                      patchBatch(current.hit.id, batch.id, (row) => ({
                        ...row,
                        expires: !event.target.checked,
                        expiryDate: event.target.checked ? '' : row.expiryDate,
                      }))
                    }
                  />
                  {t('catalog.intake.noExpiry')}
                </label>
                {batch.expires && (
                  <label className="block text-xs text-zinc-300">
                    {t('catalog.intake.expiry')}
                    <input
                      type="date"
                      aria-label={`${current.hit.name} ${t('catalog.intake.expiry')} ${index + 1}`}
                      value={batch.expiryDate}
                      onChange={(event) =>
                        patchBatch(current.hit.id, batch.id, (row) => ({ ...row, expiryDate: event.target.value }))
                      }
                      className={`${fieldClass} mt-1`}
                    />
                  </label>
                )}
                {expiryBad && (
                  <p className="text-xs text-rose-300">
                    {batch.expiryDate && batch.expiryDate < today
                      ? t('catalog.intake.expiryPast')
                      : t('catalog.intake.expiryInvalid')}
                  </p>
                )}
                {current.batches.length > 1 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      patchItem(current.hit.id, (item) => ({
                        ...item,
                        batches: item.batches.filter((row) => row.id !== batch.id),
                      }))
                    }
                  >
                    {t('catalog.intake.removeBatch')}
                  </Button>
                )}
              </fieldset>
            );
          })}
          {current.batches.length < MAX_BATCHES_PER_PRODUCT && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => patchItem(current.hit.id, (item) => ({ ...item, batches: [...item.batches, emptyBatch()] }))}
            >
              {t('catalog.intake.addBatch')}
            </Button>
          )}
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-3" data-testid="intake-review">
          <p className="text-xs text-zinc-400">{t('catalog.intake.reviewHint')}</p>
          {draftItems.map((item, index) => {
            const itemProblems = problems.filter((problem) => problem.catalogProductId === item.hit.id);
            return (
              <div key={item.hit.id} className="rounded-xl border border-zinc-800 p-3">
                <div className="flex items-center gap-3">
                  <ProductThumbnail path={item.hit.imagePath} previewUrl={picturePreview(item.hit)} alt={item.hit.name} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-zinc-100">{item.hit.name}</p>
                    <p className="text-xs text-zinc-400">{t('catalog.intake.unitsTotal', { count: intakeUnits(item) })}</p>
                    {(item.buyingPrice.trim() || item.sellingPrice.trim()) && (
                      <p className="text-xs text-zinc-400">
                        {t('catalog.buyingPrice')}: {item.buyingPrice.trim() || '—'}
                        {' · '}
                        {t('catalog.sellingPrice')}: {item.sellingPrice.trim() || '—'}
                      </p>
                    )}
                  </div>
                </div>
                <ul className="mt-2 space-y-1 text-xs text-zinc-300">
                  {item.batches.map((batch, batchIndex) => (
                    <li key={batch.id}>
                      {t('catalog.intake.batchLabel', { count: batchIndex + 1 })}: {batch.quantity || '—'}
                      {' · '}
                      {batch.expires ? batch.expiryDate || '—' : t('catalog.intake.noExpiry')}
                    </li>
                  ))}
                </ul>
                {itemProblems.some((problem) => problem.field === 'quantity') && (
                  <p className="mt-2 text-xs text-rose-300">{t('catalog.intake.quantityInvalid')}</p>
                )}
                {itemProblems.some((problem) => problem.field === 'expiry') && (
                  <p className="mt-2 text-xs text-rose-300">{t('catalog.intake.expiryInvalid')}</p>
                )}
                {itemProblems.some((problem) => problem.field === 'price') && (
                  <p className="mt-2 text-xs text-rose-300">{t('catalog.setup.priceInvalid')}</p>
                )}
                <div className="mt-2 flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => { setCountIndex(index); setStep('count'); }}>
                    {t('catalog.intake.editItem')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraftItems((currentItems) => currentItems.filter((row) => row.hit.id !== item.hit.id));
                      setCountIndex(0);
                    }}
                  >
                    {t('catalog.intake.removeItem')}
                  </Button>
                </div>
              </div>
            );
          })}
          {notice && <p className="text-xs text-zinc-200">{notice}</p>}
        </div>
      )}

      {step === 'select' && (
        <div className="space-y-3">
          <Input
            label={t('catalog.searchPlaceholder')}
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
              setPage(0);
              setSelected(null);
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
                {!showAdded && !hit.shopProductId && (
                  <input
                    type="checkbox"
                    className="mt-3 h-5 w-5 shrink-0"
                    aria-label={hit.name}
                    checked={chosenIds.has(hit.id)}
                    disabled={saving}
                    onChange={() => toggle(hit)}
                  />
                )}
                <button
                  type="button"
                  onClick={() => (hit.shopProductId ? setSelected(hit) : toggle(hit))}
                  className={`flex min-w-0 flex-1 items-center gap-3 rounded-xl border px-3 py-2 text-left ${
                    chosenIds.has(hit.id) || selected?.id === hit.id
                      ? 'border-emerald-500 bg-emerald-950/40'
                      : 'border-zinc-800 bg-zinc-900/60'
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
            <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 py-2">
              <span className="text-sm text-zinc-200">{t('catalog.selectedCount', { count: selectedCount })}</span>
              <Button type="button" size="sm" variant="outline" disabled={saving} onClick={selectAll}>
                {t('catalog.selectAll')}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={saving || selectedCount === 0} onClick={() => setDraftItems([])}>
                {t('catalog.clearSelection')}
              </Button>
            </div>
          )}
          {notice && <p className="text-xs text-zinc-200">{notice}</p>}
        </div>
      )}
    </Dialog>
  );
};
