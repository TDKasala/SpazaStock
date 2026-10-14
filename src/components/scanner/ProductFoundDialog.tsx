import React from 'react';
import { PackageCheck, Barcode, Tag, ArrowUpRight, Plus, ShoppingCart, RefreshCw } from 'lucide-react';
import { Product } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';

export interface ProductFoundDialogProps {
  isOpen: boolean;
  product: Product | null;
  onClose: () => void;
  onScanAnother: () => void;
  onQuickAction?: (action: 'add_stock' | 'quick_sale', product: Product) => void;
}

export const ProductFoundDialog: React.FC<ProductFoundDialogProps> = ({
  isOpen,
  product,
  onClose,
  onScanAnother,
  onQuickAction,
}) => {
  const { t, dict } = useLanguage();

  if (!isOpen || !product) return null;

  // Calculate margin/markup if both prices present
  let marginText: string | null = null;
  if (product.buyingPrice && product.sellingPrice && product.buyingPrice > 0) {
    const profit = product.sellingPrice - product.buyingPrice;
    const markupPct = ((profit / product.buyingPrice) * 100).toFixed(0);
    marginText = `+R ${profit.toFixed(2)} (${markupPct}%)`;
  }

  const categoryLabel = dict.product.categories[product.category] || product.category;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('product.productFound')}
      description={t('product.foundInCatalog')}
      footer={
        <div className="flex w-full gap-2">
          <Button onClick={onScanAnother} variant="secondary" size="md" className="flex-1" leftIcon={<RefreshCw className="w-4 h-4" />}>
            {t('product.scanAnother')}
          </Button>
          <Button onClick={onClose} variant="primary" size="md" className="flex-1">
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 py-2">
        {/* Product Card Highlight */}
        <div className="p-4 rounded-2xl bg-zinc-950 border border-zinc-800 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20 shrink-0">
              <PackageCheck className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-[11px] font-semibold uppercase text-emerald-400 tracking-wider">
                {categoryLabel}
              </span>
              <h3 className="text-base font-bold text-zinc-100 mt-0.5 leading-snug">
                {product.name}
              </h3>
            </div>
          </div>

          {/* Barcode badge */}
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-mono text-zinc-300">
            <Barcode className="w-4 h-4 text-zinc-400 shrink-0" />
            <span className="tracking-wider">{product.barcode}</span>
          </div>

          {/* Price Metrics Grid */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800">
              <span className="text-[11px] text-zinc-400 block">{t('product.buyingPrice')}</span>
              <span className="text-sm font-semibold text-zinc-200 mt-0.5 block">
                {product.buyingPrice != null ? `R ${Number(product.buyingPrice).toFixed(2)}` : '—'}
              </span>
            </div>

            <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800">
              <span className="text-[11px] text-zinc-400 block">{t('product.sellingPrice')}</span>
              <span className="text-base font-bold text-emerald-400 mt-0.5 block">
                {product.sellingPrice != null ? `R ${Number(product.sellingPrice).toFixed(2)}` : '—'}
              </span>
            </div>
          </div>

          {marginText && (
            <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-emerald-950/30 border border-emerald-800/40 text-xs text-emerald-300">
              <span>{t('product.margin')}</span>
              <span className="font-semibold flex items-center gap-0.5">
                <ArrowUpRight className="w-3.5 h-3.5" />
                {marginText}
              </span>
            </div>
          )}
        </div>

        {/* Note stating no assumptions regarding stock or expiry in barcode */}
        <p className="text-[11px] text-zinc-400 italic leading-relaxed px-1">
          {t('product.priceNotice')}
        </p>

        {/* Quick Action Buttons */}
        {onQuickAction && (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button
              onClick={() => onQuickAction('add_stock', product)}
              variant="secondary"
              size="sm"
              leftIcon={<Plus className="w-4 h-4 text-emerald-400" />}
            >
              Add Stock Batch
            </Button>
            <Button
              onClick={() => onQuickAction('quick_sale', product)}
              variant="secondary"
              size="sm"
              leftIcon={<ShoppingCart className="w-4 h-4 text-emerald-400" />}
            >
              Quick Sale
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
};
