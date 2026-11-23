import React, { useState } from 'react';
import { Download, Smartphone } from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { useLanguage } from '../../context/LanguageContext';
import { Button } from '../ui/Button';
import { IOSInstallGuideDialog } from './IOSInstallGuideDialog';
import { SHOP_SHELL_WIDTH } from '../layout/shell';

/**
 * Persistent install call-to-action above the bottom nav. No dismiss control — it stays until
 * the app runs in standalone mode or the user completes install.
 */
export interface PWAInstallBannerProps {
  /** When false, pins to the screen bottom (e.g. landing page without bottom nav). */
  aboveBottomNav?: boolean;
}

export const PWAInstallBanner: React.FC<PWAInstallBannerProps> = ({ aboveBottomNav = true }) => {
  const { needsInstallPrompt, isInstallable, isIOS, install } = usePWAInstall();
  const { t } = useLanguage();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (!needsInstallPrompt) return null;

  const onPrimary = () => {
    if (isInstallable) void install();
    else if (isIOS) setShowIOSGuide(true);
  };

  return (
    <>
      <div
        role="region"
        aria-label={t('pwa.promoTitle')}
        className="fixed left-0 right-0 z-[45] px-3 pointer-events-none"
        style={{
          bottom: aboveBottomNav
            ? 'calc(4rem + env(safe-area-inset-bottom, 0px))'
            : 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        <div
          className={`pointer-events-auto ${SHOP_SHELL_WIDTH} mx-auto p-3.5 rounded-2xl border border-emerald-500/50 bg-gradient-to-br from-emerald-950/95 via-zinc-950/98 to-zinc-950 shadow-[0_-8px_32px_rgba(0,0,0,0.45),0_0_24px_rgba(16,185,129,0.15)] animate-in slide-in-from-bottom-4 fade-in duration-300`}
        >
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 shrink-0 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
              <Smartphone className="w-5 h-5 text-emerald-400" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-bold text-zinc-50 leading-snug">{t('pwa.promoTitle')}</p>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                {isIOS ? t('pwa.promoBodyIos') : t('pwa.promoBody')}
              </p>
            </div>
          </div>
          <Button
            onClick={onPrimary}
            variant="primary"
            fullWidth
            className="mt-3 min-h-[44px] text-sm font-bold shadow-lg shadow-emerald-950/50"
            leftIcon={<Download className="w-4 h-4" />}
          >
            {t('common.installApp')}
          </Button>
        </div>
      </div>
      <IOSInstallGuideDialog isOpen={showIOSGuide} onClose={() => setShowIOSGuide(false)} />
    </>
  );
};

/** Extra bottom padding so main content clears the banner and bottom nav. */
export function pwaInstallLayoutPadding(needsPrompt: boolean): string {
  if (!needsPrompt) return 'pb-[calc(4rem+env(safe-area-inset-bottom,0px)+0.75rem)]';
  return 'pb-[calc(4rem+env(safe-area-inset-bottom,0px)+7.75rem)]';
}
