import React, { useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { Dialog } from './Dialog';
import { Button } from './Button';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}) => {
  const { t } = useLanguage();
  const [isBusy, setIsBusy] = useState(false);

  const handleConfirm = async () => {
    setIsBusy(true);
    try {
      await onConfirm();
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isBusy}>
            {t('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => void handleConfirm()} isLoading={isBusy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-zinc-300 leading-relaxed">{body}</p>
    </Dialog>
  );
};
