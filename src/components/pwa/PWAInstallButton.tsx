import React, { useState } from 'react';
import { Download, Share, PlusSquare } from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { useLanguage } from '../../context/LanguageContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';

export const PWAInstallButton: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const { t } = useLanguage();

  if (isInstalled) {
    return null;
  }

  // Chromium / Android flow
  if (isInstallable) {
    return (
      <Button
        onClick={install}
        variant="primary"
        size={compact ? 'sm' : 'md'}
        leftIcon={<Download className="w-4 h-4" />}
      >
        {t('common.installApp')}
      </Button>
    );
  }

  // iOS Safari flow
  if (isIOS) {
    return (
      <>
        <Button
          onClick={() => setShowIOSGuide(true)}
          variant="outline"
          size={compact ? 'sm' : 'md'}
          leftIcon={<Download className="w-4 h-4" />}
        >
          {t('common.installApp')}
        </Button>

        <Dialog
          isOpen={showIOSGuide}
          onClose={() => setShowIOSGuide(false)}
          title={t('pwa.iosTitle')}
          description={t('pwa.iosDescription')}
          footer={
            <Button onClick={() => setShowIOSGuide(false)} variant="primary" fullWidth>
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
      </>
    );
  }

  return null;
};
