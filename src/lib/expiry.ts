/**
 * Expiry rules shared by the UI and the local services. They mirror the database exactly
 * (private.shop_today and private.generate_expiry_alerts), so the phone and the server agree on
 * what is expired and which reminder is due:
 *
 *   * Dates are calendar dates in the shop's time zone, never UTC.
 *   * A batch is expired once its expiry date is before today; it is still sellable on the day.
 *   * A reminder fires at the smallest threshold T >= days left; past expiry, one 'expired' alert.
 */
import type { ExpiryAlertKind } from '../types';

export const DEFAULT_TIMEZONE = 'Africa/Johannesburg';
export const DEFAULT_REMINDER_DAYS: readonly number[] = [21, 14, 7];
export const MAX_REMINDER_DAYS = 5;
export const MAX_REMINDER_DAY_VALUE = 180;

export function isValidTimezone(timezone: string | null | undefined): timezone is string {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The device's IANA time zone, or the shop default when the browser doesn't report one. */
export function deviceTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimezone(zone) ? zone : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Calendar date (YYYY-MM-DD) in `timezone` at the instant `now`. */
export function todayInZone(timezone: string, now: Date = new Date()): string {
  const zone = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function utcDay(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Whole calendar days from `today` until `expiryDate` (both YYYY-MM-DD); negative once past. */
export function daysUntil(expiryDate: string, today: string): number {
  return Math.round(utcDay(expiryDate) - utcDay(today));
}

export function isBatchExpired(batch: { expiryDate: string | null }, today: string): boolean {
  return batch.expiryDate !== null && batch.expiryDate < today;
}

export type ReminderStage =
  | { kind: Extract<ExpiryAlertKind, 'expired'>; threshold: null }
  | { kind: Extract<ExpiryAlertKind, 'reminder'>; threshold: number };

/** The alert that is due for a batch today, or null when none is. */
export function reminderStage(
  expiryDate: string | null,
  today: string,
  reminderDays: readonly number[]
): ReminderStage | null {
  if (!expiryDate) return null;
  const days = daysUntil(expiryDate, today);
  if (days < 0) return { kind: 'expired', threshold: null };
  const due = reminderDays.filter((t) => t >= days);
  if (due.length === 0) return null;
  return { kind: 'reminder', threshold: Math.min(...due) };
}

/** Short batch label, identical to the server's upper(left(batch_id::text, 6)). */
export function batchCode(batchId: string): string {
  return batchId.slice(0, 6).toUpperCase();
}

export type ExpiryAlertFilter = 'all' | 'expired' | 'urgent' | 'warning';

interface FilterableAlert {
  status: 'expired' | 'urgent' | 'warning';
  product: { name: string; brand?: string | null; barcode: string; size?: string | null };
  batch: { id: string };
}

/** Keeps alerts whose status matches and whose name, brand, barcode, size or batch code contains the query. */
export function filterExpiryAlerts<T extends FilterableAlert>(
  alerts: T[],
  options: { query: string; status: ExpiryAlertFilter }
): T[] {
  const query = options.query.trim().toLowerCase();
  return alerts.filter((alert) => {
    if (options.status !== 'all' && alert.status !== options.status) return false;
    if (!query) return true;
    const haystack = [alert.product.name, alert.product.brand ?? '', alert.product.barcode, alert.product.size ?? '', batchCode(alert.batch.id)]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

/** Same key the server deduplicates on: one alert per batch, expiry date, kind and threshold. */
export function alertDedupKey(batchId: string, expiryDate: string, stage: ReminderStage): string {
  return `${batchId}:${expiryDate}:${stage.kind}:${stage.threshold ?? ''}`;
}

/**
 * Validates and normalises reminder days like update_shop_alert_settings: 1 to 5 distinct whole
 * numbers from 1 to 180, largest first. Returns null when invalid.
 */
export function normalizeReminderDays(days: readonly number[]): number[] | null {
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > MAX_REMINDER_DAY_VALUE)) return null;
  const unique = [...new Set(days)].sort((a, b) => b - a);
  if (unique.length < 1 || unique.length > MAX_REMINDER_DAYS) return null;
  return unique;
}
