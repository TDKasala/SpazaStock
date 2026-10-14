import React, { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import type { Product } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { ErrorMessage } from '../ui/ErrorMessage';
import { updateProduct } from '../../services/productService';
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

export const ProductEditDialog: React.FC<ProductEditDialogProps> = ({ isOpen, product, onClose, onSaved }) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const [values, setValues] = useState<ProductFormValues>(() => productFormFromProduct(product));
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setValues(productFormFromProduct(product));
    setErrors({});
    setServerError(null);
  }, [isOpen, product]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isSubmitting) return;
    const { input, errors: formErrors } = parseProductForm(values, t);
    setErrors(formErrors);
    if (!input) return;

    setIsSubmitting(true);
    setServerError(null);
    try {
      const result = await updateProduct(product.id, input, shopId);
      if (result.product) {
        onSaved(result.product);
        return;
      }
      if (result.errorCode === 'duplicate') {
        setErrors({ barcode: t('product.duplicateBarcodeError', { name: result.conflict?.name ?? '' }) });
      } else if (result.errorCode === 'forbidden') {
        setServerError(t('product.editForbidden'));
      } else {
        setServerError(result.error ?? t('errors.generic'));
      }
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
        <ProductFormFields values={values} errors={errors} onChange={setValues} />
      </form>
    </Dialog>
  );
};
