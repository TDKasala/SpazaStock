import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, PackageMinus } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop } from '../../context/ShopContext';
import { orderListText, type LowStockItem } from '../../lib/lowStock';
import { whatsappShareUrl } from '../../lib/invite';
import type { Product } from '../../types';
import { Button } from '../ui/Button';

const PAGE_SIZE = 15;

export interface LowStockSectionProps {
  items: LowStockItem[];
  products: Product[];
  onSelectProduct: (product: Product) => void;
  onRestock: (product: Product) => void;
  onDismiss: (productId: string) => void;
}

export const LowStockSection: React.FC<LowStockSectionProps> = ({
  items,
  products,
  onSelectProduct,
  onRestock,
  onDismiss,
}) => {
  const { t } = useLanguage();
  const { shop } = useShop();
  const [page, setPage] = useState(0);
  const byId = new Map(products.map((product) => [product.id, product]));
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, items.length);
  const visible = items.slice(start, end);
  const orderText = orderListText(
    items.map((item) => ({
      name: item.name,
      shortfall: item.shortfall,
      size: byId.get(item.productId)?.size,
    })),
    { shopName: shop?.name, heading: t('intelligence.orderHeading') }
  );

  if (items.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 text-amber-300 min-w-0">
          <PackageMinus className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">
            {t('intelligence.lowStockHeading')} ({items.length})
          </span>
        </h3>
        {orderText && (
          <a
            href={whatsappShareUrl(orderText)}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-[11px] font-semibold text-emerald-400 hover:text-emerald-300"
          >
            {t('intelligence.sendOrder')}
          </a>
        )}
      </div>
      <div className="space-y-2">
        {visible.map((item) => {
          const product = byId.get(item.productId);
          return (
            <div
              key={item.productId}
              className="p-3.5 rounded-2xl border bg-amber-950/20 border-amber-800/70 space-y-2"
            >
              <button
                type="button"
                className="w-full text-left min-w-0"
                onClick={() => product && onSelectProduct(product)}
              >
                <h4 className="text-sm font-bold text-zinc-100 truncate">{item.name}</h4>
                <p className="text-xs text-zinc-300 mt-0.5">
                  {t('intelligence.onHand', { count: item.sellable })}
                  {' · '}
                  {t('intelligence.minimum', { count: item.minimum })}
                </p>
                {item.expired > 0 && (
                  <p className="text-[11px] text-rose-300/90 mt-0.5">
                    {t('intelligence.expiredAside', { count: item.expired })}
                  </p>
                )}
                <p className="text-[11px] text-amber-200/90 mt-1">
                  {t('intelligence.restock', { count: item.minimum })}
                </p>
              </button>
              <div className="flex gap-2">
                {product && (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => onRestock(product)}
                  >
                    {t('intelligence.restockAction')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={item.dismissed}
                  onClick={() => onDismiss(item.productId)}
                >
                  {item.dismissed ? t('intelligence.dismissed') : t('intelligence.dismiss')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {items.length > PAGE_SIZE && (
        <nav className="flex items-center justify-between gap-3 pt-1" aria-label={t('intelligence.paginationLabel')}>
          <p className="text-xs text-zinc-400" aria-live="polite">
            {t('expiry.pageRange', { from: start + 1, to: end, total: items.length })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 0}
              leftIcon={<ChevronLeft className="w-4 h-4" />}
            >
              {t('expiry.previousPage')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage >= pageCount - 1}
              rightIcon={<ChevronRight className="w-4 h-4" />}
            >
              {t('expiry.nextPage')}
            </Button>
          </div>
        </nav>
      )}
    </section>
  );
};
