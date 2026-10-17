import React, { useState } from 'react';
import { Calendar, CheckCircle2 } from 'lucide-react';
import type { Product, ProductLookupSuggestion } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShop, useShopId } from '../../context/ShopContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { createProduct, isArchived, setProductArchived } from '../../services/productService';
import { isValidDateFormat, stockIn } from '../../services/stockService';
import { saveProductImage } from '../../services/productImageService';
import { productFormFromSuggestion } from '../../services/productLookupService';
import { newId } from '../../lib/ids';
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
  /** Saved, but its picture or first delivery still needs another tap. Do not register again. */
  const [registered, setRegistered] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [hasExpiry, setHasExpiry] = useState(true);
  const [expiryDate, setExpiryDate] = useState('');
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [deliveryKey, setDeliveryKey] = useState(() => newId());

  React.useEffect(() => {
    if (!isOpen) return;
    setValues(suggestion ? productFormFromSuggestion(initialBarcode, suggestion) : emptyProductForm(initialBarcode));
    setErrors({});
    setServerError(null);
    setArchivedMatch(null);
    setImage(UNCHANGED_IMAGE);
    setRegistered(null);
    setQuantity('1');
    setHasExpiry(true);
    setExpiryDate('');
    setQuantityError(null);
    setDateError(null);
    setDeliveryKey(newId());
  }, [initialBarcode, isOpen, suggestion]);

  if (!isOpen) return null;

  const suggestedImageUrl = suggestion?.imageUrl.value ?? null;
  const fromExternal = Boolean(suggestion && suggestion.name.source === 'external');

  /** Opening stock for this registration. Blank expiry is allowed only when the toggle is off. */
  const readDelivery = (): { quantity: number; expiryDate: string | null } | null => {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setQuantityError(t('stockIn.invalidQuantity'));
      return null;
    }
    setQuantityError(null);
    if (!hasExpiry) {
      setDateError(null);
      return { quantity: qty, expiryDate: null };
    }
    const trimmed = expiryDate.trim();
    if (!trimmed || !isValidDateFormat(trimmed)) {
      setDateError(t('stockIn.invalidDate'));
      return null;
    }
    setDateError(null);
    return { quantity: qty, expiryDate: trimmed };
  };

  const recordOpeningStock = async (product: Product): Promise<boolean> => {
    const delivery = readDelivery();
    if (!delivery) return false;
    const res = await stockIn(
      {
        productId: product.id,
        quantity: delivery.quantity,
        expiryDate: delivery.expiryDate,
        idempotencyKey: deliveryKey,
      },
      shopId
    );
    if (res.error && !res.error.includes('already processed')) {
      setRegistered(product);
      setServerError(res.error);
      return false;
    }
    return true;
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isSubmitting) return;
    if (registered) {
      setIsSubmitting(true);
      setServerError(null);
      try {
        if (await recordOpeningStock(registered)) onProductRegistered(registered);
      } catch (err) {
        setServerError(err instanceof Error ? err.message : t('errors.generic'));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
    const { input, errors: formErrors } = parseProductForm(values, t);
    setErrors(formErrors);
    const delivery = readDelivery();
    if (!input || !delivery) return;

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
      setRegistered(product);
      if (await recordOpeningStock(product)) onProductRegistered(product);
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

        <Input
          label={t('stockIn.quantityLabel')}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={quantity}
          onChange={(e) => {
            setQuantity(e.target.value);
            if (quantityError) setQuantityError(null);
          }}
          error={quantityError ?? undefined}
          required
          disabled={isSubmitting}
        />

        <div className="p-3.5 bg-zinc-950/80 rounded-xl border border-zinc-800/80 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hasExpiry}
                onChange={(e) => {
                  setHasExpiry(e.target.checked);
                  if (dateError) setDateError(null);
                }}
                disabled={isSubmitting}
                className="w-4 h-4 rounded text-emerald-600 bg-zinc-800 border-zinc-700 focus:ring-emerald-500 focus:ring-offset-zinc-900"
              />
              <span className="text-xs font-semibold text-zinc-200">{t('stockIn.hasExpiryToggle')}</span>
            </label>
            <span className="text-[10px] text-zinc-400">
              {hasExpiry ? t('stockIn.perishable') : t('stockIn.nonPerishable')}
            </span>
          </div>
          {hasExpiry && (
            <Input
              type="date"
              value={expiryDate}
              onChange={(e) => {
                setExpiryDate(e.target.value);
                if (dateError) setDateError(null);
              }}
              error={dateError ?? undefined}
              leftIcon={<Calendar className="w-4 h-4 text-amber-500" />}
              required
              disabled={isSubmitting}
            />
          )}
        </div>
      </form>
    </Dialog>
  );
};
