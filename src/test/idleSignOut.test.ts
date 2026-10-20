import { describe, expect, it } from 'vitest';
import {
  countsAsUserActivity,
  createIdleClock,
  IDLE_LIMIT_MS,
  readLastActivity,
  writeLastActivity,
} from '../lib/idleSignOut';

describe('idle sign-out', () => {
  it('stays signed in inside 30 minutes and signs out at the cutoff', () => {
    const clock = createIdleClock(0);
    expect(clock.isIdle(IDLE_LIMIT_MS - 1)).toBe(false);
    expect(clock.isIdle(IDLE_LIMIT_MS)).toBe(true);
  });

  it('starts a new 30 minutes when a sale is recorded', () => {
    const clock = createIdleClock(0);
    const saleAt = IDLE_LIMIT_MS;
    clock.mark(saleAt);
    expect(clock.isIdle(saleAt + IDLE_LIMIT_MS - 1)).toBe(false);
    expect(clock.isIdle(saleAt + IDLE_LIMIT_MS)).toBe(true);
  });

  it('treats a save on this device as activity and a server sync as not', () => {
    expect(countsAsUserActivity('local')).toBe(true);
    expect(countsAsUserActivity('remote')).toBe(false);
  });

  it('remembers the last activity for the account across a reload', () => {
    writeLastActivity('user-1', 1_700_000_000_000);
    expect(readLastActivity('user-1')).toBe(1_700_000_000_000);
    expect(readLastActivity('user-2')).toBeNull();
  });
});
