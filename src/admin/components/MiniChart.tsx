import React from 'react';
import { useAdminI18n } from '../i18n';
import { formatDate, formatNumber } from '../format';
import type { SeriesPoint } from '../types';

interface MiniChartProps {
  title: string;
  series: SeriesPoint[];
  type?: 'bar' | 'line';
}

const WIDTH = 600;
const HEIGHT = 160;
const PAD = 4;

/** A dependency-free SVG chart; the same numbers are always available as a table. */
export const MiniChart: React.FC<MiniChartProps> = ({ title, series, type = 'bar' }) => {
  const { at, locale } = useAdminI18n();
  const max = Math.max(1, ...series.map((p) => p.value));
  const total = series.reduce((sum, p) => sum + p.value, 0);
  const step = series.length > 0 ? (WIDTH - PAD * 2) / series.length : 0;
  const y = (value: number) => HEIGHT - PAD - (value / max) * (HEIGHT - PAD * 2);

  const summary = at('chart.summary', {
    title,
    total: formatNumber(total, locale),
    max: formatNumber(max === 1 && total === 0 ? 0 : max, locale),
    points: series.length,
  });

  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-40 bg-zinc-950/50 rounded-xl border border-zinc-800"
        role="img"
        aria-label={summary}
        preserveAspectRatio="none"
      >
        {type === 'bar'
          ? series.map((p, i) => (
              <rect
                key={p.bucket}
                x={PAD + i * step + step * 0.15}
                y={y(p.value)}
                width={Math.max(1, step * 0.7)}
                height={HEIGHT - PAD - y(p.value)}
                className="fill-emerald-500/80"
              >
                <title>{`${formatDate(p.bucket, locale)}: ${formatNumber(p.value, locale)}`}</title>
              </rect>
            ))
          : series.length > 0 && (
              <polyline
                fill="none"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                className="stroke-emerald-400"
                points={series.map((p, i) => `${PAD + i * step + step / 2},${y(p.value)}`).join(' ')}
              />
            )}
      </svg>
      <figcaption className="text-xs text-zinc-500">{summary}</figcaption>
      <details className="text-xs text-zinc-400">
        <summary className="cursor-pointer select-none hover:text-zinc-200">{at('chart.showTable')}</summary>
        <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-zinc-800">
          <table className="w-full">
            <caption className="sr-only">{title}</caption>
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">{at('chart.period')}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{at('chart.value')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {series.map((p) => (
                <tr key={p.bucket}>
                  <th scope="row" className="px-2 py-1 text-left font-normal">{formatDate(p.bucket, locale)}</th>
                  <td className="px-2 py-1 text-right tabular-nums">{formatNumber(p.value, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
};
