import { describe, expect, it } from 'vitest';
import { createIdleClock, IDLE_LIMIT_MS } from '../lib/idleSignOut';

describe('idle sign-out', () => {
  it('stays signed in inside 3 minutes and signs out at the cutoff', () => {
    const clock = createIdleClock(0);
    expect(clock.isIdle(IDLE_LIMIT_MS - 1)).toBe(false);
    expect(clock.isIdle(IDLE_LIMIT_MS)).toBe(true);
  });

  it('starts a new 3 minutes when a sale is recorded', () => {
    const clock = createIdleClock(0);
    const saleAt = IDLE_LIMIT_MS;
    clock.mark(saleAt);
    expect(clock.isIdle(saleAt + IDLE_LIMIT_MS - 1)).toBe(false);
    expect(clock.isIdle(saleAt + IDLE_LIMIT_MS)).toBe(true);
  });
});
