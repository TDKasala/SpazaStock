import React, { useEffect, useState } from 'react';
import { ArrowLeft, Barcode, CheckCircle2, Search } from 'lucide-react';
import type { ProductCategory, ProductPackaging, ResolvedBarcode } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { findProducts, type ProductMatch } from '../../services/productService';
import {
  createPackaging,
  getPackagings,
  linkBarcode,
  validatePackagingInput,
  type BarcodeLinkErrorCode,
} from '../../services/barcodeLinkService';
import { PRODUCT_CATEGORIES } from './ProductFormFields';
import { brandAndSize, packagingLabel } from './packagingLabel';

export interface LinkBarcodeDialogProps {
  isOpen: boolean;
  barcode: string;
  onClose: () => void;
  /** The barcode now belongs to the chosen product (and packaging); continue to stock-in. */
  onLinked: (resolved: ResolvedBarcode) => void;
}

/** 'single', an existing packaging id, or 'new'. */
type PackChoice = string;

const NAME_PRESETS = ['pack', 'case', 'crate', 'tray'] as const;
const UNIT_PRESETS = [6, 12, 24];

/**
 * Links an unknown barcode to a product that already exists, after the owner picks the product
 * and confirms they are the same. Nothing is matched automatically.
 */
export const LinkBarcodeDialog: React.FC<LinkBarcodeDialogProps> = ({ isOpen, barcode, onClose, onLinked }) => {
  const { t, dict } = useLanguage();
  const shopId = useShopId();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ProductCategory | null>(null);
  const [matches, setMatches] = useState<ProductMatch[]>([]);
  const [selected, setSelected] = useState<ProductMatch | null>(null);
  const [packagings, setPackagings] = useState<ProductPackaging[]>([]);
  const [choice, setChoice] = useState<PackChoice>('single');
  const [newName, setNewName] = useState('');
  const [newUnits, setNewUnits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setCategory(null);
    setSelected(null);
    setError(null);
  }, [isOpen, barcode]);

  useEffect(() => {
    if (!isOpen || selected) return;
    let cancelled = false;
    void findProducts(query, shopId, { category }).then((found) => {
      if (!cancelled) setMatches(found);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, selected, query, category, shopId]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setChoice('single');
    setNewName('');
    setNewUnits('24');
    void getPackagings(selected.product.id, shopId).then((found) => {
      if (!cancelled) setPackagings(found);
    });
    return () => {
      cancelled = true;
    };
  }, [selected, shopId]);

  if (!isOpen) return null;

  const units = Number(newUnits);
  const chosenPackaging = packagings.find((p) => p.id === choice) ?? null;
  const pack =
    choice === 'new' ? { name: newName.trim(), unitsPerPackage: units } : chosenPackaging;
  const newPackInvalid = choice === 'new' && validatePackagingInput({ name: newName, unitsPerPackage: units }) !== null;

  const errorText = (code: BarcodeLinkErrorCode | undefined, fallback: string | undefined, conflict?: string) => {
    if (code === 'forbidden') return t('link.forbidden');
    if (code === 'duplicate') return t('link.duplicate', { name: conflict ?? '' });
    if (code === 'retired') return t('link.retired');
    return fallback ?? t('errors.generic');
  };

  const handleConfirm = async () => {
    if (!selected || isSaving) return;
    if (newPackInvalid) {
      setError(t('link.invalidPack'));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      let packaging: ProductPackaging | null = chosenPackaging;
      if (choice === 'new') {
        const created = await createPackaging(
          { productId: selected.product.id, name: newName, unitsPerPackage: units },
          shopId
        );
        if (!created.packaging) {
          setError(errorText(created.errorCode, created.error));
          return;
        }
        packaging = created.packaging;
      }
      const linked = await linkBarcode(
        { productId: selected.product.id, packagingId: packaging?.id ?? null, barcode },
        shopId
      );
      if (!linked.link) {
        setError(errorText(linked.errorCode, linked.error, linked.conflict?.name));
        return;
      }
      onLinked({ product: selected.product, packaging, barcodeId: linked.link.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setIsSaving(false);
    }
  };

  const chipClass = (active: boolean) =>
    `shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
      active
        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
        : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
    }`;

  const optionClass = (active: boolean) =>
    `w-full text-left p-3 rounded-xl border text-sm transition-colors ${
      active ? 'bg-emerald-950/40 border-emerald-500/60 text-emerald-100' : 'bg-zinc-900 border-zinc-800 text-zinc-200'
    }`;

  if (selected) {
    const { product } = selected;
    const details = brandAndSize(product);
    const summary = pack
      ? t('link.summaryPack', {
          barcode,
          pack: packagingLabel({ name: pack.name || '…', unitsPerPackage: pack.unitsPerPackage || 0 }, t),
          name: product.name,
        })
      : t('link.summarySingle', { barcode, name: product.name });

    return (
      <Dialog
        isOpen={isOpen}
        onClose={onClose}
        title={t('link.confirmTitle')}
        description={t('link.confirmSubtitle')}
        footer={
          <div className="flex w-full gap-2">
            <Button
              onClick={() => setSelected(null)}
              variant="secondary"
              size="md"
              disabled={isSaving}
              leftIcon={<ArrowLeft className="w-4 h-4" />}
            >
              {t('link.back')}
            </Button>
            <Button
              onClick={() => void handleConfirm()}
              variant="primary"
              size="md"
              className="flex-1"
              isLoading={isSaving}
              disabled={newPackInvalid}
              leftIcon={<CheckCircle2 className="w-4 h-4" />}
              data-testid="confirm-link"
            >
              {t('link.confirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1">
          {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}

          <div className="p-3.5 rounded-2xl bg-zinc-950 border border-zinc-800">
            <p className="text-sm font-bold text-zinc-100">{product.name}</p>
            {details && <p className="text-xs text-zinc-400 mt-0.5">{details}</p>}
            <p className="text-[11px] text-zinc-500 font-mono mt-1 flex items-center gap-1">
              <Barcode className="w-3 h-3" />
              {product.barcode}
            </p>
          </div>

          <div className="space-y-2" role="radiogroup" aria-label={t('link.whatIsScanned')}>
            <p className="text-xs font-semibold text-zinc-300">{t('link.whatIsScanned')}</p>
            <button
              type="button"
              role="radio"
              aria-checked={choice === 'single'}
              className={optionClass(choice === 'single')}
              onClick={() => setChoice('single')}
            >
              {t('link.singleItem')}
            </button>
            {packagings.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={choice === p.id}
                className={optionClass(choice === p.id)}
                onClick={() => setChoice(p.id)}
              >
                {packagingLabel(p, t)}
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={choice === 'new'}
              className={optionClass(choice === 'new')}
              onClick={() => {
                setChoice('new');
                if (!newName) setNewName(t('link.presets.case'));
              }}
            >
              {t('link.newPack')}
            </button>

            {choice === 'new' && (
              <div className="p-3 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
                <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                  {NAME_PRESETS.map((preset) => {
                    const label = t(`link.presets.${preset}`);
                    return (
                      <button key={preset} type="button" className={chipClass(newName === label)} onClick={() => setNewName(label)}>
                        {label}
                      </button>
                    );
                  })}
                </div>
                <Input
                  label={t('link.packName')}
                  value={newName}
                  maxLength={40}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <div className="flex gap-1.5">
                  {UNIT_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={chipClass(newUnits === String(preset))}
                      onClick={() => setNewUnits(String(preset))}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <Input
                  label={t('link.unitsPerPack')}
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={10000}
                  step={1}
                  value={newUnits}
                  onChange={(e) => setNewUnits(e.target.value)}
                  error={newPackInvalid ? t('link.invalidPack') : undefined}
                />
              </div>
            )}
          </div>

          <div
            className="p-3.5 rounded-2xl bg-emerald-950/30 border border-emerald-500/30 text-sm font-semibold text-emerald-200 break-words"
            data-testid="link-summary"
          >
            {summary}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">{t('link.confirmHint')}</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('link.searchTitle')}
      description={t('link.searchSubtitle', { barcode })}
      footer={
        <Button onClick={onClose} variant="secondary" size="md" className="flex-1">
          {t('common.cancel')}
        </Button>
      }
    >
      <div className="space-y-3 py-1">
        <Input
          placeholder={t('link.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          leftIcon={<Search className="w-4 h-4" />}
          autoFocus
          aria-label={t('link.searchPlaceholder')}
        />
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          <button type="button" className={chipClass(category === null)} onClick={() => setCategory(null)}>
            {t('link.allCategories')}
          </button>
          {PRODUCT_CATEGORIES.map((cat) => (
            <button key={cat} type="button" className={chipClass(category === cat)} onClick={() => setCategory(cat)}>
              {dict.product.categories[cat] || cat}
            </button>
          ))}
        </div>

        {matches.length === 0 ? (
          <p className="p-4 text-center text-xs text-zinc-400 rounded-xl border border-dashed border-zinc-800">
            {t('link.noMatches')}
          </p>
        ) : (
          <ul className="space-y-2 max-h-[45vh] overflow-y-auto pr-0.5" aria-label={t('link.results')}>
            {matches.map((match) => {
              const { product } = match;
              const details = brandAndSize(product);
              return (
                <li key={product.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(match)}
                    className="w-full text-left p-3 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-emerald-500/50 active:bg-zinc-800 transition-colors"
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-zinc-100 truncate">{product.name}</span>
                        {details && <span className="block text-xs text-zinc-400 truncate">{details}</span>}
                        <span className="block text-[11px] text-zinc-500 mt-0.5">
                          {dict.product.categories[product.category] || product.category} ·{' '}
                          <span className="font-mono">{product.barcode}</span>
                        </span>
                      </span>
                      <span
                        className={`shrink-0 text-xs font-bold ${match.totalQuantity > 0 ? 'text-emerald-400' : 'text-zinc-500'}`}
                      >
                        {t('link.inStock', { count: match.totalQuantity })}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
};
