import { describe, it, expect } from 'vitest';
import { normaliseAi17, parseGs1, visualiseControlChars } from '../lib/barcode/gs1';

describe('GS1 AI 17 normalisation', () => {
  it('parses YYMMDD into YYYY-MM-DD with 2000–2079 mapping', () => {
    expect(normaliseAi17('261031')).toBe('2026-10-31');
    expect(normaliseAi17('000101')).toBe('2000-01-01');
    expect(normaliseAi17('240229')).toBe('2024-02-29'); // leap year
  });

  it('treats DD=00 as last day of that month', () => {
    expect(normaliseAi17('261000')).toBe('2026-10-31');
    expect(normaliseAi17('260200')).toBe('2026-02-28');
    expect(normaliseAi17('240200')).toBe('2024-02-29'); // leap year end of month
  });

  it('rejects invalid dates', () => {
    expect(normaliseAi17('261332')).toBeNull();
    expect(normaliseAi17('261231')).toBe('2026-12-31');
    expect(normaliseAi17('261300')).toBeNull();
  });
});

describe('GS1 parse', () => {
  const GS = String.fromCharCode(29);

  it('parses GTIN, expiry and lot from an element string', () => {
    const input = `]d2 0104601234567893${GS}10BATCH-42${GS}17261000`;
    const parsed = parseGs1(input);
    if (parsed.kind !== 'gs1') throw new Error('expected gs1');
    expect(parsed.gtin14).toBe('04601234567893');
    expect(parsed.lookupBarcodes).toEqual(['04601234567893', '4601234567893']);
    expect(parsed.expiry).toBe('2026-10-31'); // DD=00 -> last day of month
    expect(parsed.lot).toBe('BATCH-42');
  });

  it('recognises GS1-128 prefix ]C1 as well', () => {
    const input = `]C1 010123456789012817261031`;
    const parsed = parseGs1(input);
    if (parsed.kind !== 'gs1') throw new Error('expected gs1');
    expect(parsed.gtin14).toBe('01234567890128');
    expect(parsed.lookupBarcodes).toEqual(['01234567890128', '1234567890128']);
    expect(parsed.expiry).toBe('2026-10-31');
  });

  it('returns plain for non-GS1 inputs', () => {
    const parsed = parseGs1('6001234567890');
    expect(parsed.kind).toBe('plain');
  });

  it('makes control characters visible for debugging', () => {
    expect(visualiseControlChars(`ABC${GS}DEF`)).toBe('ABC<GS>DEF');
  });
});

