import { describe, it, expect, vi } from 'vitest';
import { BurstDetector } from '../lib/scanner/hid';

describe('BurstDetector', () => {
  it('commits a fast burst ending in Enter', () => {
    const d = new BurstDetector({ maxGapMs: 50, minLength: 4, feedback: false });
    const base = Date.now();
    expect(d.push('6', base)).toBeNull();
    expect(d.push('0', base + 10)).toBeNull();
    expect(d.push('0', base + 20)).toBeNull();
    expect(d.push('1', base + 30)).toBeNull();
    expect(d.push('Enter', base + 40)).toBe('6001');
  });

  it('does not commit slow human typing', () => {
    const d = new BurstDetector({ maxGapMs: 50, minLength: 4, feedback: false });
    const base = Date.now();
    d.push('A', base);
    d.push('B', base + 120);
    expect(d.push('Enter', base + 240)).toBeNull();
  });

  it('ignores non-printable keys except Enter and keeps GS', () => {
    const d = new BurstDetector({ feedback: false, minLength: 1 });
    const GS = String.fromCharCode(29);
    const base = Date.now();
    d.push('Shift', base);
    d.push(GS, base + 1);
    d.push('A', base + 2);
    expect(d.push('Enter', base + 3)).toBe(`${GS}A`);
  });
});

