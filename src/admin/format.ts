import type { AdminLocale } from './i18n';

/** Platform figures are reported in South African time, matching the database's date buckets. */
export const PLATFORM_TIMEZONE = 'Africa/Johannesburg';

function intlLocale(locale: AdminLocale): string {
  return locale === 'zu' ? 'zu-ZA' : 'en-ZA';
}

export function formatNumber(value: number | null | undefined, locale: AdminLocale): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2 }).format(value);
}

export function formatPercent(part: number, whole: number, locale: AdminLocale): string {
  if (!whole) return '—';
  return new Intl.NumberFormat(intlLocale(locale), { style: 'percent', maximumFractionDigits: 1 }).format(part / whole);
}

export function formatMoney(amount: number | null | undefined, currency: string, locale: AdminLocale): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${formatNumber(amount, locale)}`;
  }
}

export function formatCents(cents: number | null | undefined, currency: string, locale: AdminLocale): string {
  return cents === null || cents === undefined ? '—' : formatMoney(cents / 100, currency, locale);
}

export function formatDateTime(value: string | null | undefined, locale: AdminLocale): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: PLATFORM_TIMEZONE,
  }).format(date);
}

export function formatDate(value: string | null | undefined, locale: AdminLocale): string {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T12:00:00+02:00` : value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeZone: PLATFORM_TIMEZONE }).format(date);
}

/** YYYY-MM-DD for a moment, as a calendar day in South Africa. */
export function toPlatformDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PLATFORM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Start of a South African calendar day (the country has no daylight saving: always UTC+2). */
export function platformDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+02:00`);
}
