/** A signed-in person is signed out after this long with no taps, typing, scrolling, or saved changes. */
export const IDLE_LIMIT_MS = 3 * 60 * 1000;

/** How often the clock is checked. A hidden tab can delay timers, so becoming visible checks too. */
export const IDLE_CHECK_MS = 10_000;

const IDLE_NOTICE_KEY = 'spazastock_idle_sign_out';

export function isIdle(lastActivity: number, now: number, limitMs = IDLE_LIMIT_MS): boolean {
  return now - lastActivity >= limitMs;
}

/** Remembers the last activity so a sale or tap starts a fresh 3 minutes. */
export function createIdleClock(startedAt: number, limitMs = IDLE_LIMIT_MS) {
  let lastActivity = startedAt;
  return {
    mark(at: number) {
      lastActivity = at;
    },
    isIdle(at: number) {
      return isIdle(lastActivity, at, limitMs);
    },
  };
}

export function markIdleSignOut(): void {
  try {
    sessionStorage.setItem(IDLE_NOTICE_KEY, '1');
  } catch {
    // Private browsing without storage: the notice only lives in memory, which we do not have.
  }
}

/** Reads the idle sign-out notice once, then clears it so a refresh does not show it again. */
export function takeIdleSignOutNotice(): boolean {
  try {
    if (sessionStorage.getItem(IDLE_NOTICE_KEY) !== '1') return false;
    sessionStorage.removeItem(IDLE_NOTICE_KEY);
    return true;
  } catch {
    return false;
  }
}
