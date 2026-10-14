import React, { useState, useEffect } from 'react';
import {
  Package,
  Search,
  Plus,
  Barcode,
  Layers,
  CalendarClock,
  ArrowUpRight,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Product, ProductStockSummary } from '../../types';
import { getAllProductsStockSummary } from '../../services/stockService';

export interface StockViewProps {
  onOpenScanner: () => void;
  onOpenSetupGuide: () => void;
  onSelectProduct: (product: Product) => void;
  onQuickStockIn: (product: Product) => void;
  refreshTrigger?: number;
}

export const StockView: React.FC<StockViewProps> = ({
  onOpenScanner,
  onOpenSetupGuide,
  onSelectProduct,
  onQuickStockIn,
  refreshTrigger,
}) => {
  const { t, dict } = useLanguage();
  const [searchTerm, setSearchTerm] = useState('');
  const [summaries, setSummaries] = useState<ProductStockSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadStockData = async () => {
    setIsLoading(true);
    try {
      const items = await getAllProductsStockSummary();
      setSummaries(items);
    } catch (err) {
      console.warn('Failed to fetch stock summaries:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStockData();
  }, [refreshTrigger]);

  const filteredSummaries = summaries.filter(({ product }) => {
    const term = searchTerm.toLowerCase();
    return (
      product.name.toLowerCase().includes(term) ||
      product.barcode.toLowerCase().includes(term)
    );
  });

  return (
    <div className="space-y-5 pb-24">
      {/* Title & Action */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">{t('navigation.stock')}</h2>
          <p className="text-xs text-zinc-400">
            {summaries.length === 1
              ? '1 registered item'
              : `${summaries.length} registered items`}
          </p>
        </div>
        <Button
          onClick={onOpenScanner}
          variant="primary"
          size="sm"
          leftIcon={<Plus className="w-4 h-4" />}
        >
          {t('scanner.scanAction')}
        </Button>
      </div>

      {/* Search Bar */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search products by name or barcode..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          leftIcon={<Search className="w-4 h-4" />}
        />
      </div>

      {/* Product List with Available Stock Badges */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 bg-zinc-900/60 rounded-2xl animate-pulse border border-zinc-800/60"
            />
          ))}
        </div>
      ) : filteredSummaries.length > 0 ? (
        <div className="space-y-3">
          {filteredSummaries.map(({ product, totalQuantity, batches, earliestExpiry, isExpired, isExpiringSoon }) => {
            const categoryName = dict.product.categories[product.category] || product.category;

            return (
              <div
                key={product.id}
                className="p-4 bg-zinc-950 hover:bg-zinc-900/90 rounded-2xl border border-zinc-800/80 hover:border-zinc-700 transition-all shadow-sm flex flex-col gap-3"
              >
                <div
                  onClick={() => onSelectProduct(product)}
                  className="flex items-start justify-between gap-3 cursor-pointer select-none"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                        {categoryName}
                      </span>
                      <span className="text-xs text-zinc-400 font-mono flex items-center gap-1">
                        <Barcode className="w-3.5 h-3.5 text-zinc-500" />
                        {product.barcode}
                      </span>
                    </div>

                    <h4 className="text-sm font-bold text-zinc-100 truncate mt-1">
                      {product.name}
                    </h4>

                    {/* Expiry Pill if present */}
                    {earliestExpiry && (
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border ${
                            isExpired
                              ? 'bg-rose-950/60 text-rose-300 border-rose-800'
                              : isExpiringSoon
                              ? 'bg-amber-950/60 text-amber-300 border-amber-800'
                              : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                          }`}
                        >
                          <CalendarClock className="w-3 h-3" />
                          <span>Exp: {earliestExpiry}</span>
                          {isExpired && <span>(Expired)</span>}
                          {isExpiringSoon && !isExpired && <span>(Soon)</span>}
                        </span>
                        <span className="text-[10px] text-zinc-500">
                          {batches.length} {batches.length === 1 ? 'batch' : 'batches'}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Available Stock Counter */}
                  <div className="text-right shrink-0">
                    <span className="text-[10px] text-zinc-400 block uppercase font-medium">Available</span>
                    <span
                      className={`text-base font-extrabold ${
                        totalQuantity > 0 ? 'text-emerald-400' : 'text-zinc-500'
                      }`}
                    >
                      {totalQuantity} <span className="text-xs font-normal text-zinc-400">units</span>
                    </span>
                    {product.sellingPrice != null && (
                      <span className="text-[11px] text-zinc-400 block mt-0.5">
                        R {Number(product.sellingPrice).toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Card Actions Footer */}
                <div className="pt-2 border-t border-zinc-900 flex items-center justify-between gap-2">
                  <button
                    onClick={() => onSelectProduct(product)}
                    className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 font-medium"
                  >
                    <Layers className="w-3.5 h-3.5 text-zinc-500" />
                    <span>View {batches.length} batches</span>
                  </button>

                  <Button
                    onClick={() => onQuickStockIn(product)}
                    variant="secondary"
                    size="sm"
                    className="h-8 px-3 text-xs"
                    leftIcon={<Plus className="w-3.5 h-3.5 text-emerald-400" />}
                  >
                    + Stock-In
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Empty State */
        <div className="bg-zinc-900/40 border border-dashed border-zinc-800 rounded-2xl p-8 text-center flex flex-col items-center justify-center">
          <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 flex items-center justify-center text-zinc-400 mb-3 border border-zinc-700/50">
            <Package className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-semibold text-zinc-200">
            {searchTerm ? 'No Matching Products' : 'No Products Registered Yet'}
          </h3>
          <p className="text-xs text-zinc-400 max-w-xs mt-1.5 leading-relaxed">
            {searchTerm
              ? `No products found matching "${searchTerm}". Check the barcode or product name.`
              : 'Scan barcodes to register products and log incoming delivery batches.'}
          </p>

          <Button
            onClick={onOpenScanner}
            variant="primary"
            size="sm"
            className="mt-4"
            leftIcon={<Plus className="w-4 h-4" />}
          >
            {t('scanner.scanAction')}
          </Button>
        </div>
      )}
    </div>
  );
};
