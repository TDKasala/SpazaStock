/**
 * Date helpers that work in the shop's local time zone.
 * `Date.toISOString()` is UTC, which puts sales made between midnight and 02:00 in South Africa
 * (UTC+2) on the previous day, so calendar dates must never be derived from it.
 */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Formats a date as YYYY-MM-DD in local time. */
export function toLocalISODate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local calendar date `days` from `from` (negative values go back in time). */
export function addDaysLocal(days: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return toLocalISODate(d);
}

/** Parses YYYY-MM-DD as local midnight, or returns null for anything else. */
export function parseLocalISODate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

export function isValidDateFormat(value: string): boolean {
  return typeof value === 'string' && parseLocalISODate(value) !== null;
}

/** Whole days from today (local) until the given YYYY-MM-DD date; negative when already past. */
export function getDaysUntilExpiry(expiryDate: string | null, now: Date = new Date()): number | null {
  if (!expiryDate) return null;
  const expiry = parseLocalISODate(expiryDate);
  if (!expiry) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((expiry.getTime() - today.getTime()) / 86_400_000);
}

/** True when an ISO timestamp falls on the same local calendar day as `day`. */
export function isSameLocalDay(isoTimestamp: string, day: Date = new Date()): boolean {
  return toLocalISODate(new Date(isoTimestamp)) === toLocalISODate(day);
}
