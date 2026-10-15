import React from 'react';
import { Barcode, PackagePlus } from 'lucide-react';
import type { Product, ProductCategory, ProductRegistrationInput } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { Input } from '../ui/Input';
import { MAX_BRAND_LENGTH, MAX_SIZE_LENGTH } from '../../services/productService';

export const PRODUCT_CATEGORIES: ProductCategory[] = [
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

/** Form state: prices stay as typed text until the form is submitted. */
export interface ProductFormValues {
  barcode: string;
  name: string;
  category: ProductCategory;
  buyingPrice: string;
  sellingPrice: string;
  brand: string;
  size: string;
}

export type ProductFormErrors = Partial<
  Record<'barcode' | 'name' | 'buyingPrice' | 'sellingPrice' | 'brand' | 'size', string>
>;

export function emptyProductForm(barcode = ''): ProductFormValues {
  return { barcode, name: '', category: 'groceries', buyingPrice: '', sellingPrice: '', brand: '', size: '' };
}

export function productFormFromProduct(product: Product): ProductFormValues {
  const price = (value: number | null | undefined) => (value == null ? '' : String(Number(value)));
  return {
    barcode: product.barcode,
    name: product.name,
    category: product.category,
    buyingPrice: price(product.buyingPrice),
    sellingPrice: price(product.sellingPrice),
    brand: product.brand ?? '',
    size: product.size ?? '',
  };
}

function parsePrice(text: string): number | null | 'invalid' {
  if (!text.trim()) return null;
  const value = parseFloat(text.trim());
  return isNaN(value) || value < 0 ? 'invalid' : value;
}

/** Validates the form; returns the cleaned input, or the errors to show next to each field. */
export function parseProductForm(
  values: ProductFormValues,
  t: (key: string) => string
): { input?: ProductRegistrationInput; errors: ProductFormErrors } {
  const errors: ProductFormErrors = {};
  const barcode = values.barcode.trim();
  const name = values.name.trim();
  if (!barcode) errors.barcode = t('product.barcodeRequired');
  if (!name) errors.name = t('product.nameRequired');
  const buyingPrice = parsePrice(values.buyingPrice);
  const sellingPrice = parsePrice(values.sellingPrice);
  if (buyingPrice === 'invalid') errors.buyingPrice = t('errors.invalidNumber');
  if (sellingPrice === 'invalid') errors.sellingPrice = t('errors.invalidNumber');
  const brand = values.brand.trim();
  const size = values.size.trim();
  if (brand.length > MAX_BRAND_LENGTH) errors.brand = t('product.brandTooLong');
  if (size.length > MAX_SIZE_LENGTH) errors.size = t('product.sizeTooLong');

  if (Object.keys(errors).length > 0 || buyingPrice === 'invalid' || sellingPrice === 'invalid') {
    return { errors };
  }
  return {
    input: {
      barcode,
      name,
      category: values.category,
      buyingPrice,
      sellingPrice,
      brand: brand || null,
      size: size || null,
    },
    errors,
  };
}

export interface ProductFormFieldsProps {
  values: ProductFormValues;
  errors: ProductFormErrors;
  onChange: (values: ProductFormValues) => void;
  autoFocusName?: boolean;
}

export const ProductFormFields: React.FC<ProductFormFieldsProps> = ({ values, errors, onChange, autoFocusName }) => {
  const { t, dict } = useLanguage();
  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) =>
    onChange({ ...values, [key]: value });

  return (
    <>
      <Input
        label={t('product.barcode')}
        value={values.barcode}
        onChange={(e) => set('barcode', e.target.value)}
        error={errors.barcode}
        leftIcon={<Barcode className="w-4 h-4 text-emerald-400" />}
        required
      />

      <Input
        label={t('product.name')}
        placeholder={t('product.namePlaceholder')}
        value={values.name}
        onChange={(e) => set('name', e.target.value)}
        error={errors.name}
        leftIcon={<PackagePlus className="w-4 h-4 text-emerald-400" />}
        autoFocus={autoFocusName}
        required
      />

      <div className="grid grid-cols-2 gap-3">
        <Input
          label={t('product.brandOptional')}
          placeholder={t('product.brandPlaceholder')}
          value={values.brand}
          onChange={(e) => set('brand', e.target.value)}
          error={errors.brand}
          maxLength={MAX_BRAND_LENGTH}
        />
        <Input
          label={t('product.sizeOptional')}
          placeholder={t('product.sizePlaceholder')}
          value={values.size}
          onChange={(e) => set('size', e.target.value)}
          error={errors.size}
          maxLength={MAX_SIZE_LENGTH}
        />
      </div>

      <div className="flex flex-col gap-1.5 text-left">
        <label className="text-xs font-medium text-zinc-300">{t('product.category')}</label>
        <select
          value={values.category}
          onChange={(e) => set('category', e.target.value as ProductCategory)}
          className="w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl px-3.5 py-3 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 min-h-[46px]"
        >
          {PRODUCT_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {dict.product.categories[cat] || cat}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Input
          label={t('product.buyingPriceOptional')}
          placeholder="0.00"
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          value={values.buyingPrice}
          onChange={(e) => set('buyingPrice', e.target.value)}
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
          value={values.sellingPrice}
          onChange={(e) => set('sellingPrice', e.target.value)}
          error={errors.sellingPrice}
          leftIcon={<span className="text-xs font-bold text-emerald-400">R</span>}
        />
      </div>
    </>
  );
};
