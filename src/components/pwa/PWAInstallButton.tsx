import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { IOSInstallGuideDialog } from './IOSInstallGuideDialog';

export const PWAInstallButton: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, needsInstallPrompt, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const { t } = useLanguage();

  if (isInstalled || needsInstallPrompt) {
    return null;
  }

  if (isInstallable) {
    return (
      <Button
        onClick={() => void install()}
        variant="primary"
        size={compact ? 'sm' : 'md'}
        leftIcon={<Download className="w-4 h-4" />}
      >
        {t('common.installApp')}
      </Button>
    );
  }

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
        <IOSInstallGuideDialog isOpen={showIOSGuide} onClose={() => setShowIOSGuide(false)} />
      </>
    );
  }

  return null;
};
