import { describe, it, expect } from 'vitest';
import {
  addDaysLocal,
  getDaysUntilExpiry,
  isSameLocalDay,
  isValidDateFormat,
  parseLocalISODate,
  toLocalISODate,
} from '../lib/dates';

// The test setup pins TZ to Africa/Johannesburg (UTC+2, no DST).
describe('local date helpers (UTC+2)', () => {
  it('runs in South African time', () => {
    expect(new Date('2026-10-14T00:30:00+02:00').getTimezoneOffset()).toBe(-120);
  });

  it('formats a just-after-midnight time as the local day, not the UTC day', () => {
    const justAfterMidnight = new Date('2026-10-14T00:30:00+02:00');
    expect(justAfterMidnight.toISOString().slice(0, 10)).toBe('2026-10-13');
    expect(toLocalISODate(justAfterMidnight)).toBe('2026-10-14');
  });

  it('computes expiry presets from the local date', () => {
    const justAfterMidnight = new Date('2026-10-14T00:30:00+02:00');
    expect(addDaysLocal(5, justAfterMidnight)).toBe('2026-10-19');
    expect(addDaysLocal(0, justAfterMidnight)).toBe('2026-10-14');
    expect(addDaysLocal(-1, justAfterMidnight)).toBe('2026-10-13');
  });

  it('rolls over months and leap years', () => {
    expect(addDaysLocal(1, new Date(2028, 1, 28, 12))).toBe('2028-02-29');
    expect(addDaysLocal(1, new Date(2026, 11, 31, 23, 59))).toBe('2027-01-01');
  });

  it('treats sales just after local midnight as today', () => {
    const now = new Date('2026-10-14T09:00:00+02:00');
    expect(isSameLocalDay('2026-10-13T22:30:00.000Z', now)).toBe(true); // 00:30 local
    expect(isSameLocalDay('2026-10-13T21:59:00.000Z', now)).toBe(false); // 23:59 yesterday
  });

  it('counts whole days to expiry from the local date', () => {
    const lateEvening = new Date('2026-10-14T23:30:00+02:00');
    expect(getDaysUntilExpiry('2026-10-14', lateEvening)).toBe(0);
    expect(getDaysUntilExpiry('2026-10-15', lateEvening)).toBe(1);
    expect(getDaysUntilExpiry('2026-10-13', lateEvening)).toBe(-1);
    expect(getDaysUntilExpiry(null, lateEvening)).toBeNull();
  });

  it('validates real calendar dates only', () => {
    expect(isValidDateFormat('2026-02-28')).toBe(true);
    expect(isValidDateFormat('2026-02-30')).toBe(false);
    expect(isValidDateFormat('2026-2-3')).toBe(false);
    expect(isValidDateFormat('not a date')).toBe(false);
    expect(parseLocalISODate('2026-10-14')?.getDate()).toBe(14);
  });
});
