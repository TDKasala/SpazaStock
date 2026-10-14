import React, { useState } from 'react';
import { Barcode, PackagePlus, AlertCircle, CheckCircle2 } from 'lucide-react';
import { ProductCategory, ProductRegistrationInput, Product } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { createProduct } from '../../services/productService';

export interface ProductRegisterDialogProps {
  isOpen: boolean;
  initialBarcode: string;
  onClose: () => void;
  onProductRegistered: (product: Product) => void;
}

const CATEGORIES: ProductCategory[] = [
  'groceries',
  'beverages',
  'snacks',
  'bakery',
  'dairy',
  'personal_care',
  'household',
  'airtime',
  'other',
];

export const ProductRegisterDialog: React.FC<ProductRegisterDialogProps> = ({
  isOpen,
  initialBarcode,
  onClose,
  onProductRegistered,
}) => {
  const { t, dict } = useLanguage();
  const [barcode, setBarcode] = useState(initialBarcode);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ProductCategory>('groceries');
  const [buyingPrice, setBuyingPrice] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Sync barcode if prop updates
  React.useEffect(() => {
    setBarcode(initialBarcode);
    setErrors({});
    setServerError(null);
  }, [initialBarcode, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};

    const cleanBarcode = barcode.trim();
    const cleanName = name.trim();

    if (!cleanBarcode) {
      newErrors.barcode = t('product.barcodeRequired');
    }
    if (!cleanName) {
      newErrors.name = t('product.nameRequired');
    }

    let parsedBuying: number | null = null;
    if (buyingPrice.trim()) {
      const num = parseFloat(buyingPrice.trim());
      if (isNaN(num) || num < 0) {
        newErrors.buyingPrice = t('errors.invalidNumber');
      } else {
        parsedBuying = num;
      }
    }

    let parsedSelling: number | null = null;
    if (sellingPrice.trim()) {
      const num = parseFloat(sellingPrice.trim());
      if (isNaN(num) || num < 0) {
        newErrors.sellingPrice = t('errors.invalidNumber');
      } else {
        parsedSelling = num;
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setIsSubmitting(true);
    setServerError(null);

    try {
      const input: ProductRegistrationInput = {
        barcode: cleanBarcode,
        name: cleanName,
        category,
        buyingPrice: parsedBuying,
        sellingPrice: parsedSelling,
      };

      const result = await createProduct(input);

      if (result.error) {
        if (result.isDuplicate) {
          setServerError(t('product.duplicateError'));
        } else {
          setServerError(result.error);
        }
        setIsSubmitting(false);
        return;
      }

      if (result.product) {
        onProductRegistered(result.product);
      }
    } catch (err: any) {
      setServerError(err?.message || t('errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('product.registerProduct')}
      description={t('product.registerSubtitle')}
      footer={
        <div className="flex w-full gap-2">
          <Button onClick={onClose} variant="secondary" size="md" className="flex-1" disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            variant="primary"
            size="md"
            className="flex-1"
            isLoading={isSubmitting}
            leftIcon={<CheckCircle2 className="w-4 h-4" />}
          >
            {t('product.saveProduct')}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4 py-2">
        {serverError && (
          <ErrorMessage
            variant="error"
            message={serverError}
            onDismiss={() => setServerError(null)}
          />
        )}

        {/* Barcode input (prefilled) */}
        <Input
          label={t('product.barcode')}
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          error={errors.barcode}
          leftIcon={<Barcode className="w-4 h-4 text-emerald-400" />}
          required
        />

        {/* Product Name input */}
        <Input
          label={t('product.name')}
          placeholder={t('product.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          leftIcon={<PackagePlus className="w-4 h-4 text-emerald-400" />}
          autoFocus
          required
        />

        {/* Category Selector */}
        <div className="flex flex-col gap-1.5 text-left">
          <label className="text-xs font-medium text-zinc-300">
            {t('product.category')}
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ProductCategory)}
            className="w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl px-3.5 py-3 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 min-h-[46px]"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {dict.product.categories[cat] || cat}
              </option>
            ))}
          </select>
        </div>

        {/* Price Inputs (Optional) */}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label={t('product.buyingPriceOptional')}
            placeholder="0.00"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={buyingPrice}
            onChange={(e) => setBuyingPrice(e.target.value)}
            error={errors.buyingPrice}
            leftIcon={<span className="text-xs font-bold text-zinc-400">R</span>}
          />

          <Input
            label={t('product.sellingPriceOptional')}
            placeholder="0.00"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={sellingPrice}
            onChange={(e) => setSellingPrice(e.target.value)}
            error={errors.sellingPrice}
            leftIcon={<span className="text-xs font-bold text-emerald-400">R</span>}
          />
        </div>

        {/* Explicit instruction note */}
        <div className="p-3 bg-zinc-950/80 rounded-xl border border-zinc-800/80 text-[11px] text-zinc-400 leading-relaxed">
          <span className="font-semibold text-zinc-300 block mb-0.5">SpazaStock Architecture Notice:</span>
          {t('product.priceNotice')}
        </div>
      </form>
    </Dialog>
  );
};
