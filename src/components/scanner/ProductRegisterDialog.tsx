import React, { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { CatalogMatch, Product, ProductCategory, ProductLookupSuggestion } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShop, useShopId } from '../../context/ShopContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { ErrorMessage } from '../ui/ErrorMessage';
import { createProduct, isArchived, normalizeBarcode, setProductArchived } from '../../services/productService';
import { saveProductImage } from '../../services/productImageService';
import { productFormFromSuggestion } from '../../services/productLookupService';
import { can } from '../../lib/permissions';
import type { CatalogSubmitPayload } from '../../lib/db';
import { ProductImagePicker, UNCHANGED_IMAGE, type ImageDraft } from '../stock/ProductImagePicker';
import {
  ProductFormFields,
  emptyProductForm,
  parseProductForm,
  type ProductFormErrors,
  type ProductFormValues,
} from '../stock/ProductFormFields';

function catalogDraft(
  input: { barcode: string; name: string; category: ProductCategory; brand: string | null; size: string | null },
  suggestion: ProductLookupSuggestion | null,
  catalog: CatalogMatch | null,
  scannedBarcode: string,
  ingredients: string
): Omit<CatalogSubmitPayload, 'productId'> {
  const sizeSame = (input.size ?? '').trim() === (suggestion?.size.value ?? '').trim();
  const image = suggestion?.imageUrl.value;
  const scanned = normalizeBarcode(scannedBarcode);
  const saved = normalizeBarcode(input.barcode);
  const units = catalog?.unitsPerPackage ?? null;
  return {
    barcode: saved,
    name: input.name,
    category: input.category,
    brand: input.brand,
    packageSize: input.size,
    packageQuantity: sizeSame ? (suggestion?.packageQuantity ?? catalog?.packageQuantity ?? null) : null,
    packageUnit: sizeSame ? (suggestion?.packageUnit ?? catalog?.packageUnit ?? null) : null,
    imageUrl: image && image.startsWith('https://') ? image : null,
    ingredients: ingredients.trim() || null,
    packLink:
      catalog?.kind === 'pack' && units != null && units >= 2 && scanned && saved !== scanned
        ? { barcode: scanned, unitsPerPackage: units }
        : null,
  };
}

export type LookupOrigin = 'catalog' | 'open_food_facts' | 'manual' | 'failed';

export interface ProductRegisterDialogProps {
  isOpen: boolean;
  initialBarcode: string;
  /** External or catalog suggestion to prefill; never auto-saved. */
  suggestion?: ProductLookupSuggestion | null;
  /** Where the prefill came from. Manual and failed still open an empty form. */
  origin?: LookupOrigin;
  catalog?: CatalogMatch | null;
  /** Stock-in can attach this barcode to a product the shop already has. */
  onLinkExisting?: () => void;
  onClose: () => void;
  onProductRegistered: (product: Product) => void;
}

export const ProductRegisterDialog: React.FC<ProductRegisterDialogProps> = ({
  isOpen,
  initialBarcode,
  suggestion = null,
  origin = 'manual',
  catalog = null,
  onLinkExisting,
  onClose,
  onProductRegistered,
}) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const { settings } = useShop();
  const canEdit = can(settings.role, 'products.edit');
  const [values, setValues] = useState<ProductFormValues>(() => emptyProductForm(initialBarcode));
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  /** An archived product already uses the barcode: offer to restore it instead. */
  const [archivedMatch, setArchivedMatch] = useState<Product | null>(null);
  const [image, setImage] = useState<ImageDraft>(UNCHANGED_IMAGE);
  const [ingredients, setIngredients] = useState('');
  /** Saved, but its picture could not be stored: the next tap continues instead of registering again. */
  const [registered, setRegistered] = useState<Product | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    const formBarcode = catalog?.kind === 'pack' && catalog.unitBarcode ? catalog.unitBarcode : initialBarcode;
    setValues(suggestion ? productFormFromSuggestion(formBarcode, suggestion) : emptyProductForm(initialBarcode));
    setIngredients(suggestion?.food?.ingredients.value ?? '');
    setErrors({});
    setServerError(null);
    setArchivedMatch(null);
    setImage(UNCHANGED_IMAGE);
    setRegistered(null);
  }, [catalog, initialBarcode, isOpen, suggestion]);

  if (!isOpen) return null;

  const suggestedImageUrl = suggestion?.imageUrl.value ?? null;
  const sourceKey =
    origin === 'catalog'
      ? 'product.lookupSourceCatalog'
      : origin === 'open_food_facts'
        ? 'product.lookupSourceOff'
        : origin === 'failed'
          ? 'product.lookupSourceFailed'
          : 'product.lookupSourceManual';
  const missing = suggestion
    ? [
        !suggestion.name.value ? t('product.name') : '',
        suggestion.brand.source === 'missing' ? t('product.brandOptional') : '',
        suggestion.size.source === 'missing' ? t('product.sizeOptional') : '',
        suggestion.imageUrl.source === 'missing' ? t('product.lookupSuggestedImageAlt') : '',
      ].filter(Boolean)
    : [];

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isSubmitting) return;
    if (registered) {
      onProductRegistered(registered);
      return;
    }
    const { input, errors: formErrors } = parseProductForm(values, t);
    setErrors(formErrors);
    if (!input) return;

    setIsSubmitting(true);
    setServerError(null);
    setArchivedMatch(null);
    try {
      const result = await createProduct(
        input,
        shopId,
        catalogDraft(
          {
            barcode: input.barcode,
            name: input.name,
            category: input.category,
            brand: input.brand ?? null,
            size: input.size ?? null,
          },
          suggestion,
          catalog,
          initialBarcode,
          ingredients
        )
      );
      if (result.isDuplicate && result.product && isArchived(result.product)) {
        setArchivedMatch(result.product);
        return;
      }
      if (result.error) {
        setServerError(result.isDuplicate ? t('product.duplicateError') : result.error);
        return;
      }
      if (!result.product) return;
      let product = result.product;
      if (image.kind === 'new') {
        const saved = await saveProductImage(product.id, shopId, image.image).catch(() => null);
        if (!saved?.product) {
          setRegistered(product);
          setServerError(t('productImage.saveFailed'));
          return;
        }
        product = saved.product;
      }
      onProductRegistered(product);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRestore = async () => {
    if (!archivedMatch) return;
    setIsSubmitting(true);
    try {
      const result = await setProductArchived(archivedMatch.id, false, shopId);
      if (result.product) onProductRegistered(result.product);
      else setServerError(result.errorCode === 'forbidden' ? t('product.editForbidden') : result.error ?? null);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={origin === 'catalog' ? t('product.registerKnownTitle') : t('product.registerProduct')}
      description={origin === 'catalog' ? t('product.registerKnownSubtitle') : t('product.registerSubtitle')}
      footer={
        <div className="flex w-full gap-2">
          <Button onClick={onClose} variant="secondary" size="md" className="flex-1" disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void handleSubmit()}
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
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 py-2">
        {serverError && (
          <ErrorMessage variant="error" message={serverError} onDismiss={() => setServerError(null)} />
        )}
        {archivedMatch && (
          <ErrorMessage
            variant="warning"
            message={`${t('product.archivedNotice', { name: archivedMatch.name })}${
              canEdit ? '' : ` ${t('product.archivedAskManager')}`
            }`}
            action={canEdit ? { label: t('product.restore'), onClick: () => void handleRestore() } : undefined}
          />
        )}

        <p data-testid="lookup-source" className="text-[11px] text-emerald-400/90 leading-relaxed px-0.5">
          {t(sourceKey)}
        </p>
        {missing.length > 0 && (
          <p className="text-[11px] text-amber-300/90 leading-relaxed px-0.5">
            {t('product.lookupMissing', { fields: missing.join(', ') })}
          </p>
        )}
        {catalog?.kind === 'pack' && catalog.unitsPerPackage != null && catalog.unitsPerPackage >= 2 && (
          <p className="text-[11px] text-zinc-300 leading-relaxed px-0.5">
            {t('product.packBarcodeNote', { count: catalog.unitsPerPackage })}
          </p>
        )}

        {suggestedImageUrl && image.kind === 'unchanged' && (
          <div className="flex items-center gap-3 p-2 rounded-xl bg-zinc-950 border border-zinc-800">
            <img
              src={suggestedImageUrl}
              alt={t('product.lookupSuggestedImageAlt')}
              className="w-14 h-14 rounded-lg object-cover bg-zinc-900 shrink-0"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
            <p className="text-[11px] text-zinc-400 leading-relaxed">{t('product.lookupSuggestedImageHint')}</p>
          </div>
        )}

        <ProductImagePicker draft={image} onChange={setImage} disabled={isSubmitting || Boolean(registered)} />

        <ProductFormFields values={values} errors={errors} onChange={setValues} autoFocusName />

        <label className="block text-left">
          <span className="text-xs font-medium text-zinc-300">{t('product.ingredientsOptional')}</span>
          <textarea
            value={ingredients}
            onChange={(e) => setIngredients(e.target.value)}
            placeholder={t('product.ingredientsPlaceholder')}
            maxLength={4000}
            rows={2}
            className="mt-1.5 w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-xl px-3.5 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
          />
        </label>

        {onLinkExisting && (
          <Button type="button" variant="ghost" size="sm" className="w-full" onClick={onLinkExisting} disabled={isSubmitting}>
            {t('product.linkExistingProduct')}
          </Button>
        )}

        <div className="p-3 bg-zinc-950/80 rounded-xl border border-zinc-800/80 text-[11px] text-zinc-400 leading-relaxed">
          {t('product.priceNotice')}
        </div>
      </form>
    </Dialog>
  );
};
