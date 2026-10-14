import type { GrowthBucket } from './types';
import { platformDayStart, toPlatformDay } from './format';

export type RangePreset = '7d' | '30d' | '90d' | '365d' | 'custom';

export interface DateRangeValue {
  preset: RangePreset;
  /** YYYY-MM-DD, South African calendar days, both inclusive. Used by the custom preset. */
  fromDay?: string;
  toDay?: string;
}

export const RANGE_PRESETS: readonly RangePreset[] = ['7d', '30d', '90d', '365d', 'custom'];

const DAY_MS = 24 * 60 * 60 * 1000;
/** The database refuses longer ranges. */
export const MAX_RANGE_DAYS = 366;

const PRESET_DAYS: Record<Exclude<RangePreset, 'custom'>, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

/** The half-open window [from, to) the database is asked about, or null when the custom days are invalid. */
export function resolveRange(value: DateRangeValue, now: Date = new Date()): { from: Date; to: Date } | null {
  if (value.preset !== 'custom') {
    return { from: new Date(now.getTime() - PRESET_DAYS[value.preset] * DAY_MS), to: now };
  }
  if (!value.fromDay || !value.toDay) return null;
  const from = platformDayStart(value.fromDay);
  const to = new Date(platformDayStart(value.toDay).getTime() + DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (from >= to || to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) return null;
  return { from, to };
}

export function defaultBucket(from: Date, to: Date): GrowthBucket {
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

export function customDefaults(now: Date = new Date()): { fromDay: string; toDay: string } {
  return { fromDay: toPlatformDay(new Date(now.getTime() - 29 * DAY_MS)), toDay: toPlatformDay(now) };
}
