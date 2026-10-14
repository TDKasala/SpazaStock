let audioContext: AudioContext | null = null;

/** A short till-style beep so the shopkeeper knows the scan landed without looking at the screen. */
export function playScanBeep(): void {
  try {
    const AudioCtor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    audioContext ??= new AudioCtor();
    const ctx = audioContext;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = ctx.currentTime;
    oscillator.type = 'square';
    oscillator.frequency.value = 1800;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.1);
  } catch {
    // Audio is a nicety; scanning must never fail because of it.
  }
}

export function vibrateScan(pattern: number | number[] = 60): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Some browsers throw when vibration is disallowed.
  }
}
