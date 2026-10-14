import React from 'react';
import { ChevronRight } from 'lucide-react';
import { AdminLink } from './AdminLink';

interface MetricCardProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  /** Drill-down to the records behind the number. */
  href?: string;
  tone?: 'default' | 'warning' | 'danger';
}

const TONES = {
  default: 'text-zinc-100',
  warning: 'text-amber-300',
  danger: 'text-rose-300',
};

export const MetricCard: React.FC<MetricCardProps> = ({ label, value, hint, href, tone = 'default' }) => {
  const body = (
    <>
      <span className="block text-xs font-medium text-zinc-400">{label}</span>
      <span className={`mt-1 block text-2xl font-semibold tabular-nums ${TONES[tone]}`}>{value}</span>
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </>
  );
  const base = 'block bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4';
  if (!href) return <div className={base}>{body}</div>;
  return (
    <AdminLink
      href={href}
      className={`${base} relative hover:border-emerald-700/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`}
    >
      {body}
      <ChevronRight className="absolute top-4 right-3 w-4 h-4 text-zinc-500" aria-hidden="true" />
    </AdminLink>
  );
};
