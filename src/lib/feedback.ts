/**
 * Best-effort sound and vibration for the counter. Browsers may block either (no user gesture
 * yet, silent mode, unsupported device), so failures are ignored.
 */
let audioContext: AudioContext | null = null;

function vibrate(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Blocked by the browser.
  }
}

function tone(frequency: number, durationMs: number): void {
  try {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioContext ??= new Ctor();
    const ctx = audioContext;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + durationMs / 1000);
  } catch {
    // No audio available.
  }
}

export function signalSuccess(): void {
  vibrate([40, 30, 80]);
  tone(1320, 90);
}

export function signalError(): void {
  vibrate([150, 100, 150]);
  tone(220, 250);
}

export function signalNeutral(): void {
  vibrate([30]);
  tone(660, 60);
}
