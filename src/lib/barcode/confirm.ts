/**
 * Accepts a camera read only after consecutive decode passes agree on it. A single blurry frame
 * can decode to a wrong code that still passes its check digit; two matching reads in a row make
 * that practically impossible. Frames with no read are ignored, but a different code starts the
 * count again. There is no time limit between agreeing reads so a slow WASM decoder on Safari or
 * a weak phone can still confirm after two successful passes.
 */
export const CONFIRM_READS = 2;

export interface ReadConfirmer {
  /** Returns true when this read completes a confirmation. */
  push(code: string, now?: number): boolean;
  reset(): void;
}

export function createReadConfirmer(required: number = CONFIRM_READS): ReadConfirmer {
  let candidate: { code: string; count: number } | null = null;
  return {
    push(code) {
      if (candidate && candidate.code === code) candidate.count += 1;
      else candidate = { code, count: 1 };
      if (candidate.count < required) return false;
      candidate = null;
      return true;
    },
    reset() {
      candidate = null;
    },
  };
}
