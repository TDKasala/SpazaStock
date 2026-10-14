import React, { useState } from 'react';
import { Archive } from 'lucide-react';
import type { Product } from '../../types';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { ErrorMessage } from '../ui/ErrorMessage';
import { setProductArchived } from '../../services/productService';

export interface ArchiveProductDialogProps {
  isOpen: boolean;
  product: Product;
  /** All units still on hand, including expired ones. */
  unitsInStock: number;
  onClose: () => void;
  onArchived: (product: Product) => void;
}

export const ArchiveProductDialog: React.FC<ArchiveProductDialogProps> = ({
  isOpen,
  product,
  unitsInStock,
  onClose,
  onArchived,
}) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleArchive = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await setProductArchived(product.id, true, shopId);
      if (result.product) onArchived(result.product);
      else setError(result.errorCode === 'forbidden' ? t('product.editForbidden') : result.error ?? t('errors.generic'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('product.archiveTitle', { name: product.name })}
      footer={
        <div className="flex w-full gap-2">
          <Button onClick={onClose} variant="secondary" size="md" className="flex-1" disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void handleArchive()}
            variant="danger"
            size="md"
            className="flex-1"
            isLoading={isSubmitting}
            leftIcon={<Archive className="w-4 h-4" />}
          >
            {t('product.archiveAction')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 py-1">
        {error && <ErrorMessage variant="error" message={error} onDismiss={() => setError(null)} />}
        <p className="text-sm text-zinc-300 leading-relaxed">{t('product.archiveConfirm')}</p>
        {unitsInStock > 0 && (
          <ErrorMessage variant="warning" message={t('product.archiveStockWarning', { count: unitsInStock })} />
        )}
      </div>
    </Dialog>
  );
};
