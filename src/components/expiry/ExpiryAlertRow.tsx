import React from 'react';
import { Ban } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { batchCode, todayInZone } from '../../lib/expiry';
import type { ExpiryAlertItem } from '../../services/stockService';

export interface ExpiryAlertRowProps {
  item: ExpiryAlertItem;
  timezone: string;
  onSelect?: () => void;
  action?: React.ReactNode;
}

const TONES = {
  expired: { card: 'bg-rose-950/30 border-rose-800/80', pill: 'bg-rose-900/80 text-rose-200' },
  urgent: { card: 'bg-amber-950/30 border-amber-800/80', pill: 'bg-amber-900/80 text-amber-200' },
  warning: { card: 'bg-zinc-950 border-zinc-800', pill: 'bg-zinc-800 text-amber-400 border border-amber-500/20' },
} as const;

/** One batch needing attention: product, affected units, expiry date and which batch it is. */
export const ExpiryAlertRow: React.FC<ExpiryAlertRowProps> = ({ item, timezone, onSelect, action }) => {
  const { t } = useLanguage();
  const { batch, product, daysUntilExpiry, status, kind, thresholdDays } = item;
  const tone = TONES[status];

  const daysLabel =
    daysUntilExpiry < 0
      ? t('expiry.expiredDaysAgo', { count: Math.abs(daysUntilExpiry) })
      : daysUntilExpiry === 0
      ? t('expiry.today')
      : t('expiry.daysLeftCount', { count: daysUntilExpiry });

  return (
    <div className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${tone.card}`}>
      <div onClick={onSelect} className={`min-w-0 flex-1 ${onSelect ? 'cursor-pointer' : ''}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${tone.pill}`}>{daysLabel}</span>
          <span className="text-[10px] text-zinc-400">
            {kind === 'expired' ? t('expiry.stageOverdue') : t('expiry.stageReminder', { count: thresholdDays ?? 0 })}
          </span>
        </div>
        <h4 className="text-sm font-bold text-zinc-100 truncate mt-1">{product.name}</h4>
        <span className="text-xs text-zinc-300 block mt-0.5">
          {t('expiry.unitsAffected', { count: batch.quantity })} · {t('expiry.expiresOn', { date: batch.expiryDate ?? '' })}
        </span>
        <span className="text-[10px] text-zinc-400 block mt-0.5 font-mono">
          {t('expiry.batchLabel', {
            code: batchCode(batch.id),
            date: todayInZone(timezone, new Date(batch.receivedAt)),
          })}
        </span>
        {kind === 'expired' && (
          <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase text-rose-300">
            <Ban className="w-3 h-3" />
            {t('expiry.notSellable')}
          </span>
        )}
      </div>
      {action && <div className="shrink-0 flex flex-col gap-1.5">{action}</div>}
    </div>
  );
};
