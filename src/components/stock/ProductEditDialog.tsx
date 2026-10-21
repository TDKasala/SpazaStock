import React, { useEffect, useState } from 'react';
import { Calendar, Save } from 'lucide-react';
import type { Product, ProductEditInput, ProductPackaging, StockBatch } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ErrorMessage } from '../ui/ErrorMessage';
import { batchCode } from '../../lib/expiry';
import { parseMinStock } from '../../lib/lowStock';
import { newId } from '../../lib/ids';
import { normalizeBarcode, setProductMinStock, updateProduct } from '../../services/productService';
import { getPackagings } from '../../services/barcodeLinkService';
import { removeProductImage, saveProductImage } from '../../services/productImageService';
import { ProductImagePicker, UNCHANGED_IMAGE, type ImageDraft } from './ProductImagePicker';
import { batchExpiryChanges, getProductBatches, resolveExpiredBatch } from '../../services/stockService';
import {
  ProductFormFields,
  parseProductForm,
  productFormFromProduct,
  type ProductFormErrors,
  type ProductFormValues,
} from './ProductFormFields';

export interface ProductEditDialogProps {
  isOpen: boolean;
  product: Product;
  onClose: () => void;
  onSaved: (product: Product) => void;
}

function sameDetails(product: Product, input: ProductEditInput): boolean {
  return (
    product.barcode === normalizeBarcode(input.barcode) &&
    product.name === input.name.trim() &&
    product.category === input.category &&
    (product.buyingPrice ?? null) === (input.buyingPrice ?? null) &&
    (product.sellingPrice ?? null) === (input.sellingPrice ?? null)
  );
}

export const ProductEditDialog: React.FC<ProductEditDialogProps> = ({ isOpen, product, onClose, onSaved }) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const [values, setValues] = useState<ProductFormValues>(() => productFormFromProduct(product));
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Details already saved in this dialog, so a retry after a failed date change doesn't resend them.
  const [saved, setSaved] = useState(product);
  const [batches, setBatches] = useState<StockBatch[]>([]);
  const [expiryDrafts, setExpiryDrafts] = useState<Record<string, string>>({});
  const [expiryErrors, setExpiryErrors] = useState<Record<string, string>>({});
  // One key per batch while the dialog is open, so a double tap records each correction once.
  const [expiryKeys, setExpiryKeys] = useState<Record<string, string>>({});
  const [image, setImage] = useState<ImageDraft>(UNCHANGED_IMAGE);
  const [minStock, setMinStock] = useState(product.minStockUnits == null ? '' : String(product.minStockUnits));
  const [minStockError, setMinStockError] = useState<string | null>(null);
  const [packagings, setPackagings] = useState<ProductPackaging[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    setValues(productFormFromProduct(product));
    setErrors({});
    setServerError(null);
    setSaved(product);
    setImage(UNCHANGED_IMAGE);
    setMinStock(product.minStockUnits == null ? '' : String(product.minStockUnits));
    setMinStockError(null);
    setExpiryDrafts({});
    setExpiryErrors({});
    setExpiryKeys({});
    let cancelled = false;
    void getProductBatches(product.id, shopId).then((items) => {
      if (!cancelled) setBatches(items);
    });
    void getPackagings(product.id, shopId).then((items) => {
      if (!cancelled) setPackagings(items);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, product, shopId]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isSubmitting) return;
    const { input, errors: formErrors } = parseProductForm(values, t);
    setErrors(formErrors);
    const { changes, invalid } = batchExpiryChanges(batches, expiryDrafts);
    setExpiryErrors(Object.fromEntries(invalid.map((id) => [id, t('product.expiryDateRequired')])));
    const parsedMin = parseMinStock(minStock);
    if (parsedMin === 'invalid') setMinStockError(t('intelligence.minStockInvalid'));
    else setMinStockError(null);
    if (!input || invalid.length > 0 || parsedMin === 'invalid') return;

    setIsSubmitting(true);
    setServerError(null);
    try {
      let current = saved;
      if (!sameDetails(current, input)) {
        const result = await updateProduct(product.id, input, shopId);
        if (!result.product) {
          if (result.errorCode === 'duplicate') {
            setErrors({ barcode: t('product.duplicateBarcodeError', { name: result.conflict?.name ?? '' }) });
          } else if (result.errorCode === 'forbidden') {
            setServerError(t('product.editForbidden'));
          } else {
            setServerError(result.error ?? t('errors.generic'));
          }
          return;
        }
        current = result.product;
        setSaved(current);
      }

      if ((current.minStockUnits ?? null) !== parsedMin) {
        const minResult = await setProductMinStock(product.id, parsedMin, shopId);
        if (!minResult.product) {
          setServerError(minResult.errorCode === 'forbidden' ? t('product.editForbidden') : minResult.error ?? t('errors.generic'));
          return;
        }
        current = minResult.product;
        setSaved(current);
      }

      if (image.kind !== 'unchanged') {
        const outcome =
          image.kind === 'new'
            ? await saveProductImage(product.id, shopId, image.image)
            : await removeProductImage(product.id, shopId);
        if (!outcome.product) {
          setServerError(outcome.errorCode === 'forbidden' ? t('product.editForbidden') : t('productImage.saveFailed'));
          return;
        }
        current = outcome.product;
        setSaved(current);
        setImage(UNCHANGED_IMAGE);
      }

      const keys = { ...expiryKeys };
      for (const change of changes) {
        keys[change.batchId] ??= newId();
        const outcome = await resolveExpiredBatch(
          {
            batchId: change.batchId,
            action: 'expiry_corrected',
            newExpiryDate: change.expiryDate,
            idempotencyKey: keys[change.batchId],
          },
          shopId
        );
        if (outcome.result || outcome.errorCode === 'duplicate') {
          const updated = outcome.result?.batch;
          if (updated) setBatches((list) => list.map((b) => (b.id === updated.id ? updated : b)));
          delete keys[change.batchId];
          continue;
        }
        setExpiryKeys(keys);
        setServerError(
          outcome.errorCode === 'forbidden'
            ? t('product.editForbidden')
            : outcome.errorCode === 'invalid'
            ? t('expiry.resolveInvalidDate')
            : outcome.error ?? t('errors.generic')
        );
        return;
      }
      onSaved(current);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('product.editTitle')}
      description={t('product.editSubtitle')}
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
            leftIcon={<Save className="w-4 h-4" />}
          >
            {t('product.saveChanges')}
          </Button>
        </div>
      }
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 py-2">
        {serverError && (
          <ErrorMessage variant="error" message={serverError} onDismiss={() => setServerError(null)} />
        )}
        <ProductImagePicker currentPath={saved.imagePath} draft={image} onChange={setImage} disabled={isSubmitting} />

        <ProductFormFields values={values} errors={errors} onChange={setValues} />

        <Input
          label={t('intelligence.minStock')}
          helperText={t('intelligence.minStockHint')}
          value={minStock}
          onChange={(e) => {
            setMinStock(e.target.value);
            setMinStockError(null);
          }}
          error={minStockError ?? undefined}
          inputMode="numeric"
          min="0"
          step="1"
        />
        {packagings.length > 0 && (
          <p className="text-[11px] text-zinc-400 -mt-2">
            {packagings
              .map((pack) => t('intelligence.packHint', { name: pack.name, count: pack.unitsPerPackage }))
              .join(' · ')}
          </p>
        )}

        {batches.length > 0 && (
          <fieldset className="space-y-3 pt-1">
            <legend className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-emerald-400" />
              {t('product.expiryDatesHeading')}
            </legend>
            <p className="text-[11px] text-zinc-400">{t('product.expiryDatesHint')}</p>
            {batches.map((batch, idx) => (
              <Input
                key={batch.id}
                type="date"
                label={t('product.expiryBatchLabel', {
                  number: batches.length - idx,
                  count: batch.quantity,
                  date: new Date(batch.receivedAt).toLocaleDateString(),
                  code: batchCode(batch.id),
                })}
                value={expiryDrafts[batch.id] ?? batch.expiryDate ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  setExpiryDrafts((drafts) => ({ ...drafts, [batch.id]: value }));
                  setExpiryErrors(({ [batch.id]: _cleared, ...rest }) => rest);
                }}
                error={expiryErrors[batch.id]}
              />
            ))}
          </fieldset>
        )}
      </form>
    </Dialog>
  );
};
