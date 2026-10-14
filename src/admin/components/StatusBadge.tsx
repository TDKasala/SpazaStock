import React from 'react';
import { useAdminI18n } from '../i18n';

const GOOD = new Set(['active', 'success', 'sent', 'succeeded', 'configured', 'on']);
const BAD = new Set(['suspended', 'denied', 'failed', 'revoked', 'canceled', 'past_due', 'deactivated', 'missing', 'expired']);
const WAITING = new Set(['trialing', 'pending', 'sending', 'invited', 'running', 'starting']);

export function statusTone(value: string): 'good' | 'bad' | 'waiting' | 'neutral' {
  if (GOOD.has(value)) return 'good';
  if (BAD.has(value)) return 'bad';
  if (WAITING.has(value)) return 'waiting';
  return 'neutral';
}

const TONE_CLASSES = {
  good: 'bg-emerald-950/60 text-emerald-300 border-emerald-800/70',
  bad: 'bg-rose-950/60 text-rose-300 border-rose-800/70',
  waiting: 'bg-amber-950/60 text-amber-300 border-amber-800/70',
  neutral: 'bg-zinc-800/80 text-zinc-300 border-zinc-700',
};

export const StatusBadge: React.FC<{ value: string | null | undefined }> = ({ value }) => {
  const { label } = useAdminI18n();
  if (!value) return <span className="text-zinc-500">{label('status', value)}</span>;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold whitespace-nowrap ${TONE_CLASSES[statusTone(value)]}`}
    >
      {label('status', value)}
    </span>
  );
};
