import React, { useEffect, useRef } from 'react';
import { Ban } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useShop } from '../../context/ShopContext';
import { useSyncStatus } from '../../hooks/useSyncStatus';

/** Shown while the platform has suspended the shop: data stays viewable and changes stay queued. */
export const SuspendedNotice: React.FC = () => {
  const { t } = useLanguage();
  const { shop, reload } = useShop();
  const { status } = useSyncStatus();
  const previousBlock = useRef(status.blocked);

  // The cached shop status only refreshes with the shop list, so refresh it whenever sync learns
  // the shop was suspended or reactivated.
  useEffect(() => {
    const was = previousBlock.current;
    previousBlock.current = status.blocked;
    if ((was === 'suspended') !== (status.blocked === 'suspended')) reload();
  }, [status.blocked, reload]);

  if (shop?.status !== 'suspended' && status.blocked !== 'suspended') return null;

  return (
    <div
      role="status"
      className="mb-4 p-3.5 bg-rose-950/40 border border-rose-800/80 rounded-2xl flex items-start gap-2.5 text-rose-200"
    >
      <Ban className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
      <span className="text-xs font-medium">{t('sync.suspended')}</span>
    </div>
  );
};
