import React, { useState } from 'react';
import { ShoppingCart, ScanBarcode, Plus, Search, Receipt } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

export interface SalesViewProps {
  onOpenScanner: () => void;
  onSearchBarcode: (barcode: string) => void;
}

export const SalesView: React.FC<SalesViewProps> = ({ onOpenScanner, onSearchBarcode }) => {
  const { t } = useLanguage();
  const [barcodeInput, setBarcodeInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (barcodeInput.trim()) {
      onSearchBarcode(barcodeInput.trim());
    }
  };

  return (
    <div className="space-y-5 pb-24">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">{t('navigation.sales')}</h2>
          <p className="text-xs text-zinc-400">Point of sale and register</p>
        </div>
        <Button
          onClick={onOpenScanner}
          variant="primary"
          size="sm"
          leftIcon={<ScanBarcode className="w-4 h-4" />}
        >
          {t('dashboard.actions.quickSale.title')}
        </Button>
      </div>

      {/* Quick Scan / Manual lookup */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 space-y-3">
        <label className="text-xs font-semibold text-zinc-300">
          {t('scanner.manualEntryTitle')}
        </label>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            placeholder={t('scanner.manualEntryPlaceholder')}
            value={barcodeInput}
            onChange={(e) => setBarcodeInput(e.target.value)}
            leftIcon={<ScanBarcode className="w-4 h-4" />}
          />
          <Button type="submit" variant="secondary" size="md">
            <Search className="w-4 h-4" />
          </Button>
        </form>
      </div>

      {/* Mobile-friendly scan button */}
      <button
        onClick={onOpenScanner}
        className="w-full py-4 px-4 bg-emerald-600/10 hover:bg-emerald-600/20 active:bg-emerald-600/30 border border-emerald-500/30 rounded-2xl flex items-center justify-center gap-3 text-emerald-400 font-semibold text-sm transition-colors cursor-pointer select-none"
      >
        <ScanBarcode className="w-5 h-5 text-emerald-400" />
        <span>Open Camera Scanner for Counter Sale</span>
      </button>

      <div className="bg-zinc-900/40 border border-dashed border-zinc-800 rounded-2xl p-8 text-center flex flex-col items-center justify-center">
        <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 flex items-center justify-center text-zinc-400 mb-3 border border-zinc-700/50">
          <Receipt className="w-6 h-6" />
        </div>
        <h3 className="text-sm font-semibold text-zinc-200">Point of Sale Ready</h3>
        <p className="text-xs text-zinc-400 max-w-xs mt-1.5 leading-relaxed">
          Scan any registered item to check price immediately and process customer checkout.
        </p>
      </div>
    </div>
  );
};
