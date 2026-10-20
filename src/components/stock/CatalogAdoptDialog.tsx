import React, { useEffect, useState } from 'react';
import { BookOpen, Search } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import {
  adoptCatalogProduct,
  searchCatalog,
  type CatalogSearchHit,
  type CatalogServiceError,
} from '../../services/catalogService';

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

export const CatalogAdoptDialog: React.FC<CatalogAdoptDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<CatalogSearchHit[]>([]);
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
    setItems([]);
    setSelected(null);
    setBuyingPrice('');
    setSellingPrice('');
    setPriceError(null);
    setNotice(null);
    setSearchError(null);
    setSearched(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setSearchError(t('catalog.offline'));
      setItems([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      void searchCatalog(shopId, term.trim()).then((result) => {
        if (cancelled) return;
        setSearching(false);
        setSearched(true);
        if (result.error) {
          setItems([]);
          setSearchError(t(errorKey(result.error)));
          return;
        }
        setItems(result.data.items);
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, shopId, term, t]);

  const choose = (hit: CatalogSearchHit) => {
    setSelected(hit);
    setBuyingPrice('');
    setSellingPrice('');
    setPriceError(null);
    setNotice(null);
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
    setNotice(t('catalog.added'));
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('catalog.title')}
      description={t('catalog.description')}
      footer={
        selected ? (
          <Button onClick={() => void save()} isLoading={saving} fullWidth leftIcon={<BookOpen className="w-4 h-4" />}>
            {selected.shopProductId ? t('catalog.useExisting') : t('catalog.add')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <Input
          label={t('catalog.searchPlaceholder')}
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setSelected(null);
          }}
          leftIcon={<Search className="w-4 h-4" />}
          autoComplete="off"
        />
        {searching && <p className="text-xs text-zinc-400">{t('catalog.searching')}</p>}
        {searchError && <p className="text-xs text-rose-300">{searchError}</p>}
        {searched && !searching && !searchError && items.length === 0 && (
          <p className="text-xs text-zinc-400">{t('catalog.empty')}</p>
        )}
        <ul className="space-y-2">
          {items.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => choose(hit)}
                className={`w-full text-left rounded-xl border px-3 py-2 ${
                  selected?.id === hit.id ? 'border-emerald-500 bg-emerald-950/40' : 'border-zinc-800 bg-zinc-900/60'
                }`}
              >
                <span className="block text-sm font-semibold text-zinc-100">{hit.name}</span>
                <span className="block text-xs text-zinc-400">
                  {[hit.brand, hit.packageSize, hit.barcodes[0]?.barcode].filter(Boolean).join(' · ')}
                </span>
                {hit.shopProductId && (
                  <span className="mt-1 inline-block text-[10px] uppercase tracking-wide text-emerald-300">
                    {t('catalog.inShop')}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
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
