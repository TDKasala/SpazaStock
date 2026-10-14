import React, { useState } from 'react';
import { BellRing, BellOff } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { enablePushNotifications, getPushSupport, type PushSupport } from '../../lib/push';
import { Button } from '../ui/Button';

/** Lets the shopkeeper allow sound and vibration alerts on this phone, even when the app is closed. */
export const PushAlertsToggle: React.FC = () => {
  const { t } = useLanguage();
  const [support, setSupport] = useState<PushSupport>(() => getPushSupport());
  const [message, setMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const handleEnable = async () => {
    setIsBusy(true);
    setMessage(null);
    try {
      const result = await enablePushNotifications();
      setSupport(getPushSupport());
      if (result.ok) setMessage(result.serverPush ? t('expiry.pushEnabled') : t('expiry.pushNotConfigured'));
      else if (result.reason === 'denied') setMessage(t('expiry.pushDenied'));
      else if (result.reason === 'needs_install') setMessage(t('expiry.pushNeedsInstall'));
      else if (result.reason === 'unsupported') setMessage(t('expiry.pushUnsupported'));
      else setMessage(t('expiry.pushFailed'));
    } finally {
      setIsBusy(false);
    }
  };

  const status =
    support === 'denied'
      ? t('expiry.pushDenied')
      : support === 'unsupported'
      ? t('expiry.pushUnsupported')
      : support === 'needs_install'
      ? t('expiry.pushNeedsInstall')
      : support === 'granted'
      ? t('expiry.pushEnabled')
      : t('expiry.pushHint');

  return (
    <div className="p-3.5 rounded-2xl border border-zinc-800 bg-zinc-950 flex items-center justify-between gap-3">
      <div className="flex items-start gap-2.5 min-w-0">
        {support === 'granted' ? (
          <BellRing className="w-4.5 h-4.5 text-emerald-400 shrink-0 mt-0.5" />
        ) : (
          <BellOff className="w-4.5 h-4.5 text-zinc-500 shrink-0 mt-0.5" />
        )}
        <div className="min-w-0">
          <span className="text-xs font-semibold text-zinc-100 block">{t('expiry.pushTitle')}</span>
          <span className="text-[11px] text-zinc-400 block leading-relaxed">{message ?? status}</span>
        </div>
      </div>
      {support === 'default' && (
        <Button onClick={() => void handleEnable()} size="sm" variant="primary" isLoading={isBusy} className="shrink-0">
          {t('expiry.pushEnable')}
        </Button>
      )}
    </div>
  );
};
