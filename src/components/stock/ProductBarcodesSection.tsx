import React, { useEffect, useState } from 'react';
import { Barcode, Boxes, Unlink } from 'lucide-react';
import type { Product, ProductBarcode, ProductPackaging, StockBatch } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import {
  getBatchesReceivedThrough,
  getPackagings,
  getProductBarcodes,
  retirePackaging,
  setPackagingPrice,
  unlinkBarcode,
  MAX_UNLINK_REASON_LENGTH,
} from '../../services/barcodeLinkService';
import { packagingLabel } from './packagingLabel';

export interface ProductBarcodesSectionProps {
  product: Product;
  /** products.edit: unlink barcodes and retire packs. */
  canEdit: boolean;
  /** stock.adjust: also take back unsold deliveries when unlinking. */
  canAdjust: boolean;
  refreshTrigger?: number;
}

/** Lists a product's barcodes and packs, and lets owners and managers correct mistaken links. */
export const ProductBarcodesSection: React.FC<ProductBarcodesSectionProps> = ({
  product,
  canEdit,
  canAdjust,
  refreshTrigger,
}) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const [packagings, setPackagings] = useState<ProductPackaging[]>([]);
  const [links, setLinks] = useState<ProductBarcode[]>([]);
  const [unlinking, setUnlinking] = useState<ProductBarcode | null>(null);
  const [received, setReceived] = useState<StockBatch[]>([]);
  const [reason, setReason] = useState('');
  const [reverse, setReverse] = useState(false);
  const [retiring, setRetiring] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getPackagings(product.id, shopId), getProductBarcodes(product.id, shopId)]).then(
      ([packs, barcodes]) => {
        if (cancelled) return;
        setPackagings(packs);
        setLinks(barcodes);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [product.id, shopId, refreshTrigger, reload]);

  const packOf = (link: ProductBarcode) => packagings.find((p) => p.id === link.packagingId) ?? null;

  const startUnlink = async (link: ProductBarcode) => {
    setMessage(null);
    setReason('');
    setReverse(false);
    setUnlinking(link);
    setReceived(await getBatchesReceivedThrough(link.id, shopId));
  };

  const confirmUnlink = async () => {
    if (!unlinking || isSaving) return;
    setIsSaving(true);
    try {
      const outcome = await unlinkBarcode({ barcodeId: unlinking.id, reason, reverseUnsold: reverse }, shopId);
      if (!outcome.result) {
        setMessage({
          tone: 'error',
          text: outcome.errorCode === 'invalid' ? t('barcodes.reasonRequired') : outcome.error ?? t('errors.generic'),
        });
        return;
      }
      const reversedUnits = outcome.result.reversed.reduce((sum, b) => sum + b.quantity, 0);
      const keptUnits = outcome.result.kept.reduce((sum, b) => sum + b.quantity, 0);
      setMessage({
        tone: 'success',
        text: [
          t('barcodes.unlinked', { barcode: unlinking.barcode }),
          reversedUnits > 0 ? t('barcodes.reversed', { count: reversedUnits }) : '',
          reverse && keptUnits > 0 ? t('barcodes.kept', { count: keptUnits }) : '',
        ]
          .filter(Boolean)
          .join(' '),
      });
      setUnlinking(null);
      setReload((n) => n + 1);
    } finally {
      setIsSaving(false);
    }
  };

  const savePackPrice = async (pack: ProductPackaging) => {
    if (isSaving) return;
    const raw = (priceDraft[pack.id] ?? (pack.sellingPrice == null ? '' : String(pack.sellingPrice))).trim();
    const price = raw === '' ? null : Number(raw);
    if (price != null && (!Number.isFinite(price) || price < 0)) {
      setMessage({ tone: 'error', text: t('link.invalidPackPrice') });
      return;
    }
    setIsSaving(true);
    try {
      const outcome = await setPackagingPrice(pack.id, price, shopId);
      setMessage(
        outcome.packaging
          ? { tone: 'success', text: t('barcodes.packPriceSaved') }
          : { tone: 'error', text: outcome.error ?? t('errors.generic') }
      );
      setReload((n) => n + 1);
    } finally {
      setIsSaving(false);
    }
  };

  const confirmRetire = async (packagingId: string) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const outcome = await retirePackaging(packagingId, shopId);
      setMessage(
        outcome.packaging
          ? { tone: 'success', text: t('barcodes.retired', { pack: packagingLabel(outcome.packaging, t) }) }
          : { tone: 'error', text: outcome.error ?? t('errors.generic') }
      );
      setRetiring(null);
      setReload((n) => n + 1);
    } finally {
      setIsSaving(false);
    }
  };

  const unsoldUnits = received.filter((b) => b.quantity === b.initialQuantity).reduce((s, b) => s + b.quantity, 0);

  return (
    <section className="space-y-2" aria-labelledby="barcodes-heading">
      <h4
        id="barcodes-heading"
        className="px-1 text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5"
      >
        <Barcode className="w-3.5 h-3.5 text-emerald-400" />
        {t('barcodes.heading')}
      </h4>

      {message && (
        <ErrorMessage variant={message.tone} message={message.text} onDismiss={() => setMessage(null)} />
      )}

      <ul className="space-y-1.5 text-xs">
        <li className="p-2.5 rounded-xl bg-zinc-900/80 border border-zinc-800/80 flex items-center justify-between gap-2">
          <span className="font-mono text-zinc-200 break-all">{product.barcode}</span>
          <span className="text-[10px] text-zinc-400 shrink-0">{t('barcodes.main')}</span>
        </li>
        {links.map((link) => {
          const pack = packOf(link);
          return (
            <li
              key={link.id}
              className="p-2.5 rounded-xl bg-zinc-900/80 border border-zinc-800/80 flex items-center justify-between gap-2"
            >
              <span className="min-w-0">
                <span className="block font-mono text-zinc-200 break-all">{link.barcode}</span>
                <span className="block text-[10px] text-zinc-400">
                  {pack ? packagingLabel(pack, t) : t('barcodes.singleItem')}
                </span>
              </span>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-rose-300"
                  leftIcon={<Unlink className="w-3.5 h-3.5" />}
                  onClick={() => void startUnlink(link)}
                >
                  {t('barcodes.unlink')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {unlinking && (
        <div className="p-3 rounded-xl bg-rose-950/20 border border-rose-800/50 space-y-3">
          <p className="text-xs text-zinc-200">{t('barcodes.unlinkTitle', { barcode: unlinking.barcode })}</p>
          <Input
            label={t('barcodes.reasonLabel')}
            placeholder={t('barcodes.reasonPlaceholder')}
            value={reason}
            maxLength={MAX_UNLINK_REASON_LENGTH}
            onChange={(e) => setReason(e.target.value)}
          />
          {canAdjust && unsoldUnits > 0 && (
            <label className="flex items-start gap-2 text-xs text-zinc-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={reverse}
                onChange={(e) => setReverse(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded"
              />
              <span>{t('barcodes.reverseUnsold', { count: unsoldUnits })}</span>
            </label>
          )}
          {received.some((b) => b.quantity !== b.initialQuantity) && (
            <p className="text-[11px] text-amber-300">{t('barcodes.partlySoldNote')}</p>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" className="flex-1" onClick={() => setUnlinking(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="flex-1"
              isLoading={isSaving}
              disabled={!reason.trim()}
              onClick={() => void confirmUnlink()}
            >
              {t('barcodes.confirmUnlink')}
            </Button>
          </div>
        </div>
      )}

      {packagings.length > 0 && (
        <ul className="space-y-1.5 text-xs" aria-label={t('barcodes.packs')}>
          {packagings.map((pack) => (
            <li
              key={pack.id}
              className="p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 flex items-center justify-between gap-2"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-zinc-200">
                  <Boxes className="w-3.5 h-3.5 text-zinc-400" />
                  {packagingLabel(pack, t)}
                </span>
                <span className="block text-[10px] text-zinc-400 mt-0.5">
                  {pack.sellingPrice != null
                    ? t('barcodes.packPrice', { amount: Number(pack.sellingPrice).toFixed(2) })
                    : t('barcodes.noPackPrice')}
                </span>
                {canEdit && !pack.retiredAt && (
                  <span className="mt-1.5 flex items-center gap-1.5">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      aria-label={t('link.packPrice')}
                      value={priceDraft[pack.id] ?? (pack.sellingPrice == null ? '' : String(pack.sellingPrice))}
                      onChange={(e) => setPriceDraft((current) => ({ ...current, [pack.id]: e.target.value }))}
                      className="w-24 h-8 bg-zinc-950 border border-zinc-700 rounded-lg px-2 text-xs text-zinc-100"
                    />
                    <Button variant="secondary" size="sm" disabled={isSaving} onClick={() => void savePackPrice(pack)}>
                      {t('barcodes.savePackPrice')}
                    </Button>
                  </span>
                )}
              </span>
              {canEdit &&
                (retiring === pack.id ? (
                  <span className="flex gap-1.5 shrink-0">
                    <Button variant="secondary" size="sm" onClick={() => setRetiring(null)}>
                      {t('common.cancel')}
                    </Button>
                    <Button variant="danger" size="sm" isLoading={isSaving} onClick={() => void confirmRetire(pack.id)}>
                      {t('barcodes.confirmRetire')}
                    </Button>
                  </span>
                ) : (
                  <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setRetiring(pack.id)}>
                    {t('barcodes.retire')}
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {packagings.length > 0 && canEdit && <p className="px-1 text-[11px] text-zinc-500">{t('barcodes.retireHint')}</p>}
    </section>
  );
};
