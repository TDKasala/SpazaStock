import React from 'react';
import { PlusSquare, Share } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';

export interface IOSInstallGuideDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const IOSInstallGuideDialog: React.FC<IOSInstallGuideDialogProps> = ({ isOpen, onClose }) => {
  const { t } = useLanguage();
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('pwa.iosTitle')}
      description={t('pwa.iosDescription')}
      footer={
        <Button onClick={onClose} variant="primary" fullWidth>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-4 py-2">
        <div className="flex items-start gap-3 bg-zinc-800/50 p-3.5 rounded-xl border border-zinc-700/50">
          <Share className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="text-xs text-zinc-300">{t('pwa.iosStep1')}</div>
        </div>
        <div className="flex items-start gap-3 bg-zinc-800/50 p-3.5 rounded-xl border border-zinc-700/50">
          <PlusSquare className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="text-xs text-zinc-300">{t('pwa.iosStep2')}</div>
        </div>
      </div>
    </Dialog>
  );
};
