import React, { useEffect, useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { useShopId } from '../../context/ShopContext';
import { batchCode } from '../../lib/expiry';
import { newId } from '../../lib/ids';
import type { ExpiryResolutionAction } from '../../types';
import { resolveExpiredBatch, type ExpiryAlertItem } from '../../services/stockService';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

export interface ResolveExpiryDialogProps {
  item: ExpiryAlertItem | null;
  onClose: () => void;
}

const ACTIONS: Array<{ action: ExpiryResolutionAction; labelKey: string }> = [
  { action: 'discarded', labelKey: 'expiry.actionDiscard' },
  { action: 'returned_to_supplier', labelKey: 'expiry.actionReturn' },
  { action: 'expiry_corrected', labelKey: 'expiry.actionCorrect' },
];

/** Removes an expired batch from stock or corrects its date; the server keeps a permanent record. */
export const ResolveExpiryDialog: React.FC<ResolveExpiryDialogProps> = ({ item, onClose }) => {
  const { t } = useLanguage();
  const shopId = useShopId();
  const [action, setAction] = useState<ExpiryResolutionAction>('discarded');
  const [newExpiryDate, setNewExpiryDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // One key per opened dialog, so a double tap or retry records the resolution once.
  const [idempotencyKey, setIdempotencyKey] = useState(newId);

  useEffect(() => {
    if (!item) return;
    setAction(item.kind === 'expired' ? 'discarded' : 'expiry_corrected');
    setNewExpiryDate(item.batch.expiryDate ?? '');
    setNote('');
    setError(null);
    setIdempotencyKey(newId());
  }, [item]);

  if (!item) return null;

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const outcome = await resolveExpiredBatch(
        { batchId: item.batch.id, action, newExpiryDate: action === 'expiry_corrected' ? newExpiryDate : null, note, idempotencyKey },
        shopId
      );
      if (outcome.result || outcome.errorCode === 'duplicate') {
        onClose();
        return;
      }
      setError(
        outcome.errorCode === 'forbidden'
          ? t('expiry.resolveForbidden')
          : outcome.errorCode === 'empty'
          ? t('expiry.resolveEmpty')
          : outcome.errorCode === 'invalid'
          ? t('expiry.resolveInvalidDate')
          : outcome.error ?? t('errors.generic')
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={t('expiry.resolveTitle')}
      description={t('expiry.resolveDescription', {
        name: item.product.name,
        count: item.batch.quantity,
        code: batchCode(item.batch.id),
      })}
      footer={
        <div className="flex w-full gap-2">
          <Button onClick={() => void handleSave()} isLoading={isSaving} className="flex-1">
            {t('expiry.confirmResolve')}
          </Button>
          <Button onClick={onClose} variant="secondary">
            {t('common.cancel')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="space-y-2" role="radiogroup">
          {ACTIONS.map((option) => (
            <label
              key={option.action}
              className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer text-sm ${
                action === option.action ? 'border-emerald-500 bg-emerald-950/30 text-zinc-100' : 'border-zinc-800 text-zinc-300'
              }`}
            >
              <input
                type="radio"
                name="expiry-action"
                value={option.action}
                checked={action === option.action}
                onChange={() => setAction(option.action)}
                className="accent-emerald-500"
              />
              {t(option.labelKey)}
            </label>
          ))}
        </div>

        {action === 'expiry_corrected' && (
          <Input
            type="date"
            label={t('expiry.newExpiryLabel')}
            value={newExpiryDate}
            onChange={(e) => setNewExpiryDate(e.target.value)}
          />
        )}
        <Input label={t('expiry.noteLabel')} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        {error && <p className="text-xs text-rose-400">{error}</p>}
      </div>
    </Dialog>
  );
};
