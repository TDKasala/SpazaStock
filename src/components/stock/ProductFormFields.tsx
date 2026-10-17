import React, { useState } from 'react';
import { Barcode, PackagePlus } from 'lucide-react';
import type { Product, ProductCategory, ProductRegistrationInput } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { Input } from '../ui/Input';
import { MAX_BRAND_LENGTH, MAX_SIZE_LENGTH } from '../../services/productService';

/** Pack sizes stocked in most spaza shops. The saved value is the label itself. */
export const COMMON_PRODUCT_SIZES = {
  volume: ['200ml', '250ml', '300ml', '330ml', '340ml', '350ml', '375ml', '440ml', '500ml', '750ml', '1L', '1.25L', '1.5L', '2L', '5L', '20L'],
  weight: ['50g', '100g', '125g', '150g', '200g', '250g', '410g', '500g', '750g', '1kg', '2kg', '2.5kg', '5kg', '10kg', '12.5kg'],
} as const;

const COMMON_SIZE_OPTIONS = [...COMMON_PRODUCT_SIZES.volume, ...COMMON_PRODUCT_SIZES.weight];

function matchingSize(size: string): string {
  const folded = size.trim().toLowerCase();
  return COMMON_SIZE_OPTIONS.find((option) => option.toLowerCase() === folded) ?? '';
}

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

const CUSTOM_SIZE = '__custom';

const fieldClass = (error?: string) =>
  `w-full bg-zinc-900 border rounded-xl px-3.5 py-3 text-sm text-zinc-100 focus:outline-none min-h-[46px] ${
    error
      ? 'border-rose-500/80 focus:border-rose-500 focus:ring-1 focus:ring-rose-500'
      : 'border-zinc-800 hover:border-zinc-700 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500'
  }`;

const SizeField: React.FC<{
  value: string;
  error?: string;
  onChange: (size: string) => void;
  labels: { field: string; placeholder: string; volume: string; weight: string; custom: string };
}> = ({ value, error, onChange, labels }) => {
  const preset = matchingSize(value);
  const [custom, setCustom] = useState(() => value.trim() !== '' && !matchingSize(value));
  const customRef = React.useRef<HTMLInputElement>(null);
  const focusCustom = React.useRef(false);
  const showCustom = custom || (value.trim() !== '' && !preset);

  React.useEffect(() => {
    if (matchingSize(value)) setCustom(false);
  }, [value]);

  React.useEffect(() => {
    if (!focusCustom.current || !showCustom) return;
    focusCustom.current = false;
    customRef.current?.focus();
  }, [showCustom]);

  return (
    <div className="w-full flex flex-col gap-1.5 text-left">
      <label htmlFor="product-size" className="text-xs font-medium text-zinc-300">
        {labels.field}
      </label>
      <select
        id="product-size"
        value={showCustom ? CUSTOM_SIZE : preset}
        onChange={(e) => {
          const next = e.target.value;
          if (next === CUSTOM_SIZE) {
            focusCustom.current = true;
            setCustom(true);
            if (preset) onChange('');
            return;
          }
          setCustom(false);
          onChange(next);
        }}
        className={fieldClass(error)}
      >
        <option value="">{labels.placeholder}</option>
        <optgroup label={labels.volume}>
          {COMMON_PRODUCT_SIZES.volume.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </optgroup>
        <optgroup label={labels.weight}>
          {COMMON_PRODUCT_SIZES.weight.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </optgroup>
        <option value={CUSTOM_SIZE}>{labels.custom}</option>
      </select>
      {showCustom && (
        <Input
          ref={customRef}
          aria-label={labels.custom}
          placeholder={labels.placeholder}
          value={preset ? '' : value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={MAX_SIZE_LENGTH}
        />
      )}
      {error && <span className="text-xs text-rose-400">{error}</span>}
    </div>
  );
};

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
        <SizeField
          value={values.size}
          error={errors.size}
          onChange={(size) => set('size', size)}
          labels={{
            field: t('product.sizeOptional'),
            placeholder: t('product.sizePlaceholder'),
            volume: t('product.sizeVolume'),
            weight: t('product.sizeWeight'),
            custom: t('product.sizeCustom'),
          }}
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
