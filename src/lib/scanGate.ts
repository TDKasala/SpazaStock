/**
 * Decides which camera reads count as a new scan. The camera decodes a code many times a second
 * while it is in frame, so the same code is ignored until it has been out of sight for
 * `windowMs`: every read (accepted or not) refreshes its last-seen time. Holding an item up sells
 * it once; taking it away and presenting it again sells another. A different code is accepted
 * immediately.
 */
export const SCAN_PRESENCE_WINDOW_MS = 1200;

export interface ScanGate {
  /** Returns true when this read should be treated as a new scan. */
  accept(code: string, now?: number): boolean;
  reset(): void;
}

export function createScanGate(windowMs: number = SCAN_PRESENCE_WINDOW_MS): ScanGate {
  let last: { code: string; seenAt: number } | null = null;
  return {
    accept(rawCode, now = Date.now()) {
      const code = rawCode.trim();
      if (!code) return false;
      const isRepeat = last !== null && last.code === code && now - last.seenAt < windowMs;
      last = { code, seenAt: now };
      return !isRepeat;
    },
    reset() {
      last = null;
    },
  };
}
