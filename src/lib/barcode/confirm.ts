/**
 * Accepts a camera read only after consecutive frames agree on it. A single blurry frame can
 * decode to a wrong code that still passes its check digit; two matching reads close together
 * make that practically impossible while adding only one frame of delay (~33 ms at 30 fps).
 * Frames with no read are ignored, but a different code starts the count again.
 */
export const CONFIRM_WINDOW_MS = 500;
export const CONFIRM_READS = 2;

export interface ReadConfirmer {
  /** Returns true when this read completes a confirmation. */
  push(code: string, now?: number): boolean;
  reset(): void;
}

export function createReadConfirmer(
  windowMs: number = CONFIRM_WINDOW_MS,
  required: number = CONFIRM_READS
): ReadConfirmer {
  let candidate: { code: string; count: number; lastAt: number } | null = null;
  return {
    push(code, now = Date.now()) {
      if (candidate && candidate.code === code && now - candidate.lastAt <= windowMs) {
        candidate.count += 1;
        candidate.lastAt = now;
      } else {
        candidate = { code, count: 1, lastAt: now };
      }
      if (candidate.count < required) return false;
      candidate = null;
      return true;
    },
    reset() {
      candidate = null;
    },
  };
}
