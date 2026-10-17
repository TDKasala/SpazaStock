import React, { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { Product, ProductLookupSuggestion } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShop, useShopId } from '../../context/ShopContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { ErrorMessage } from '../ui/ErrorMessage';
import { createProduct, isArchived, setProductArchived } from '../../services/productService';
import { saveProductImage } from '../../services/productImageService';
import { productFormFromSuggestion } from '../../services/productLookupService';
import { can } from '../../lib/permissions';
import { ProductImagePicker, UNCHANGED_IMAGE, type ImageDraft } from '../stock/ProductImagePicker';
import {
  ProductFormFields,
  emptyProductForm,
  parseProductForm,
  type ProductFormErrors,
  type ProductFormValues,
} from '../stock/ProductFormFields';

export interface ProductRegisterDialogProps {
  isOpen: boolean;
  initialBarcode: string;
  /** External catalog suggestion to prefill; never auto-saved. */
  suggestion?: ProductLookupSuggestion | null;
  onClose: () => void;
  onProductRegistered: (product: Product) => void;
}

export const ProductRegisterDialog: React.FC<ProductRegisterDialogProps> = ({
  isOpen,
  initialBarcode,
  suggestion = null,
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
  /** Saved, but its picture could not be stored: the next tap continues instead of registering again. */
  const [registered, setRegistered] = useState<Product | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    setValues(suggestion ? productFormFromSuggestion(initialBarcode, suggestion) : emptyProductForm(initialBarcode));
    setErrors({});
    setServerError(null);
    setArchivedMatch(null);
    setImage(UNCHANGED_IMAGE);
    setRegistered(null);
  }, [initialBarcode, isOpen, suggestion]);

  if (!isOpen) return null;

  const suggestedImageUrl = suggestion?.imageUrl.value ?? null;
  const fromExternal = Boolean(suggestion && suggestion.name.source === 'external');

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
      const result = await createProduct(input, shopId);
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
      title={t('product.registerProduct')}
      description={t('product.registerSubtitle')}
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

        {fromExternal && (
          <p className="text-[11px] text-emerald-400/90 leading-relaxed px-0.5">{t('product.lookupSuggestion')}</p>
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

        <div className="p-3 bg-zinc-950/80 rounded-xl border border-zinc-800/80 text-[11px] text-zinc-400 leading-relaxed">
          {t('product.priceNotice')}
        </div>
      </form>
    </Dialog>
  );
};
