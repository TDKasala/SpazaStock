import { playScanBeep, vibrateScan } from '../barcode/feedback';

export interface BurstDetectorOptions {
  /** Max allowed gap between keystrokes in a burst (ms). */
  maxGapMs?: number;
  /** Minimum length to consider before Enter counts as a scan. */
  minLength?: number;
  /** Beep/vibrate when a scan is committed. */
  feedback?: boolean;
}

/** Classifies a rapid sequence of key inputs (ending with Enter) as a scanner burst vs human typing. */
export class BurstDetector {
  private readonly maxGapMs: number;
  private readonly minLength: number;
  private readonly feedback: boolean;
  private buffer: string = '';
  private lastAt: number = 0;

  constructor(options: BurstDetectorOptions = {}) {
    this.maxGapMs = options.maxGapMs ?? 50;
    this.minLength = options.minLength ?? 6;
    this.feedback = options.feedback ?? false;
  }

  /** Resets the current burst buffer. */
  reset(): void {
    this.buffer = '';
    this.lastAt = 0;
  }

  /**
   * Add one key and return a committed scan string when a burst ends with Enter.
   * Non-printable keys other than Enter are ignored.
   */
  push(key: string, at: number = Date.now()): string | null {
    // Enter ends the attempt: decide based on timing and length.
    if (key === 'Enter') {
      const value = this.buffer;
      const ok = value.length >= this.minLength;
      this.reset();
      if (ok && this.feedback) {
        playScanBeep();
        vibrateScan(40);
      }
      return ok ? value : null;
    }
    // Filter: accept visible ASCII and GS (29). Ignore modifiers, arrows, etc.
    if (key.length !== 1) return null;
    const code = key.charCodeAt(0);
    const isVisibleAscii = code >= 0x20 && code <= 0x7e;
    const isGS = code === 29;
    if (!isVisibleAscii && !isGS) return null;

    const now = at;
    if (this.lastAt && now - this.lastAt > this.maxGapMs) {
      // Gap too long: this is likely human typing; start a new burst.
      this.buffer = '';
    }
    this.buffer += key;
    this.lastAt = now;
    return null;
  }
}

/**
 * Page-level HID scanner listener. Treats a fast burst ending in Enter as a scan even when
 * the scan field is not focused. Never interferes with normal typing in inputs/textareas.
 */
export function attachGlobalHidListener(
  onScan: (code: string) => void,
  options: BurstDetectorOptions & { /** Active: only listen while true. */ active?: boolean } = {}
): () => void {
  const detector = new BurstDetector(options);
  const handler = (e: KeyboardEvent) => {
    if (options.active === false) return;
    const target = e.target as HTMLElement | null;
    // If the user is typing in an input/textarea/contenteditable, do not intercept.
    const tag = (target?.tagName || '').toLowerCase();
    const isEditable =
      tag === 'input' ||
      tag === 'textarea' ||
      (target && (target as HTMLElement).isContentEditable) ||
      (target && (target.getAttribute('role') || '').toLowerCase() === 'textbox');
    if (isEditable) return;

    const committed = detector.push(e.key);
    if (committed !== null) {
      e.preventDefault();
      onScan(committed);
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}

