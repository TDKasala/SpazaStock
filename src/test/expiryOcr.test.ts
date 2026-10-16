import { describe, it, expect } from 'vitest';
import {
  decideExpirySuggestion,
  extractExpiryCandidates,
  normalizeOcrText,
} from '../lib/expiryOcr';
import { ocrPixelSize } from '../lib/expiryOcrRunner';

const TODAY = new Date(2026, 9, 15); // 15 Oct 2026

describe('ocrPixelSize', () => {
  it('shrinks large photos and enlarges small date crops', () => {
    expect(ocrPixelSize(4000, 3000)).toEqual({ width: 2000, height: 1500 });
    expect(ocrPixelSize(700, 400)).toEqual({ width: 1400, height: 800 });
    expect(ocrPixelSize(1600, 1200)).toEqual({ width: 1600, height: 1200 });
  });
});

describe('normalizeOcrText', () => {
  it('uppercases, collapses spaces, and fixes O/I next to digits', () => {
    expect(normalizeOcrText('  exp  31/1O/2O26  ')).toBe('EXP 31/10/2026');
    expect(normalizeOcrText('use by l5/11/2026')).toBe('USE BY 15/11/2026');
  });
});

describe('extractExpiryCandidates', () => {
  it('reads ISO and slash dates after EXP markers with high confidence', () => {
    const hits = extractExpiryCandidates('LOT 44 EXP 2026-12-31 KEEP COOL', TODAY);
    expect(hits[0]?.isoDate).toBe('2026-12-31');
    expect(hits[0]?.confidence).toBe('high');
    expect(hits[0]?.ambiguous).toBe(false);
  });

  it('reads USE BY and BEST BEFORE with day-month-year', () => {
    expect(extractExpiryCandidates('USE BY 05/03/2027', TODAY)[0]?.isoDate).toBe('2027-03-05');
    expect(extractExpiryCandidates('BEST BEFORE 15.11.2026', TODAY)[0]?.isoDate).toBe('2026-11-15');
  });

  it('reads month names', () => {
    expect(extractExpiryCandidates('EXPIRY 31 OCT 2026', TODAY)[0]?.isoDate).toBe('2026-10-31');
    expect(extractExpiryCandidates('BB NOV 15 2026', TODAY)[0]?.isoDate).toBe('2026-11-15');
  });

  it('maps month/year packs to the last day of that month', () => {
    expect(extractExpiryCandidates('EXP 10/2027', TODAY)[0]?.isoDate).toBe('2027-10-31');
    expect(extractExpiryCandidates('BBE 02.2027', TODAY)[0]?.isoDate).toBe('2027-02-28');
  });

  it('emits both DMY and MDY when the digits are ambiguous', () => {
    const hits = extractExpiryCandidates('EXP 05/03/2027', TODAY);
    const dates = hits.filter((h) => h.ambiguous).map((h) => h.isoDate).sort();
    expect(dates).toEqual(['2027-03-05', '2027-05-03']);
  });

  it('does not treat an unambiguous day>12 as two dates', () => {
    const hits = extractExpiryCandidates('EXP 31/10/2026', TODAY);
    expect(hits.some((h) => h.isoDate === '2026-10-31')).toBe(true);
    expect(hits.filter((h) => h.raw.includes('31/10/2026') && h.ambiguous)).toHaveLength(0);
  });

  it('rejects invalid calendars and absurd years', () => {
    expect(extractExpiryCandidates('EXP 31/02/2026', TODAY)).toHaveLength(0);
    expect(extractExpiryCandidates('EXP 01/01/1995', TODAY)).toHaveLength(0);
  });

  it('ranks marker-adjacent dates above stray dates', () => {
    const hits = extractExpiryCandidates('PACKED 01/01/2026 EXP 30/06/2027', TODAY);
    expect(hits[0]?.isoDate).toBe('2027-06-30');
  });

  it('reads dates the way a label photo usually comes back from OCR', () => {
    expect(extractExpiryCandidates('EXP31/10/2026', TODAY)[0]?.isoDate).toBe('2026-10-31');
    expect(extractExpiryCandidates('EXP: 31 / 10 / 2026', TODAY)[0]?.isoDate).toBe('2026-10-31');
    expect(extractExpiryCandidates('BEST BEFORE 31OCT2026', TODAY)[0]?.isoDate).toBe('2026-10-31');
    expect(extractExpiryCandidates('USE BY 31 10 2026', TODAY)[0]?.isoDate).toBe('2026-10-31');
    expect(extractExpiryCandidates('EXP 31102026', TODAY)[0]?.isoDate).toBe('2026-10-31');
    expect(extractExpiryCandidates('BB 20261031', TODAY).some((h) => h.isoDate === '2026-10-31')).toBe(true);
  });
});

describe('decideExpirySuggestion', () => {
  it('auto-suggests a single high-confidence date', () => {
    const hits = extractExpiryCandidates('EXP 2026-12-31', TODAY);
    expect(decideExpirySuggestion(hits)).toEqual({
      kind: 'suggest',
      isoDate: '2026-12-31',
      confidence: 'high',
    });
  });

  it('requires a pick for ambiguous DMY/MDY pairs', () => {
    const hits = extractExpiryCandidates('EXP 05/03/2027', TODAY);
    const decision = decideExpirySuggestion(hits);
    expect(decision.kind).toBe('pick');
    if (decision.kind === 'pick') {
      expect(decision.candidates.map((c) => c.isoDate).sort()).toEqual(['2027-03-05', '2027-05-03']);
    }
  });

  it('returns none when there are no candidates', () => {
    expect(decideExpirySuggestion([])).toEqual({ kind: 'none' });
  });

  it('asks for confirmation instead of dropping a single weak date', () => {
    const hits = extractExpiryCandidates('CODE 01/01/2020', TODAY);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.confidence).toBe('low');
    expect(decideExpirySuggestion(hits).kind).toBe('pick');
  });
});
