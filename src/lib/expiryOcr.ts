/**
 * Pure helpers that turn OCR text from an expiry label into YYYY-MM-DD candidates.
 * No Tesseract or DOM here — unit tests run in Node/happy-dom without WASM.
 */

import { isValidDateFormat, toLocalISODate } from './dates';

export type OcrConfidence = 'high' | 'medium' | 'low';

export interface ExpiryDateCandidate {
  isoDate: string;
  confidence: OcrConfidence;
  /** True when the same digits could be read as both DMY and MDY. */
  ambiguous: boolean;
  /** The date substring as seen in the label text. */
  raw: string;
  /** How many characters from the nearest expiry marker (lower is better). */
  markerDistance: number;
}

const MONTHS: Record<string, number> = {
  JAN: 1,
  JANUARY: 1,
  FEB: 2,
  FEBRUARY: 2,
  MAR: 3,
  MARCH: 3,
  APR: 4,
  APRIL: 4,
  MAY: 5,
  JUN: 6,
  JUNE: 6,
  JUL: 7,
  JULY: 7,
  AUG: 8,
  AUGUST: 8,
  SEP: 9,
  SEPT: 9,
  SEPTEMBER: 9,
  OCT: 10,
  OCTOBER: 10,
  NOV: 11,
  NOVEMBER: 11,
  DEC: 12,
  DECEMBER: 12,
};

/** Markers that usually precede an expiry date on food packs. */
const MARKER_RE =
  /\b(?:EXP(?:IRY|\.?| DATE)?|USE\s*BY|BEST\s*BEFORE|BBE|BB)\b/gi;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(y: number, m: number, d: number): string | null {
  const value = `${y}-${pad(m)}-${pad(d)}`;
  return isValidDateFormat(value) ? value : null;
}

function lastDayOfMonth(y: number, m: number): string | null {
  if (m < 1 || m > 12 || y < 1990 || y > 2100) return null;
  const d = new Date(y, m, 0).getDate();
  return iso(y, m, d);
}

/**
 * OCR often confuses O/0 and I/1/l next to digits. Only rewrite characters that sit beside a digit
 * so brand words are left alone.
 */
export function normalizeOcrText(raw: string): string {
  let text = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  text = text.replace(/([0-9])O|O([0-9])/g, (_, a: string, b: string) => (a ? `${a}0` : `0${b}`));
  text = text.replace(/([0-9])[IL]|[IL]([0-9])/g, (_, a: string, b: string) => (a ? `${a}1` : `1${b}`));
  return text;
}

function expandYear(yy: number, nowYear: number): number {
  if (yy >= 100) return yy;
  const century = Math.floor(nowYear / 100) * 100;
  let full = century + yy;
  if (full > nowYear + 20) full -= 100;
  if (full < nowYear - 80) full += 100;
  return full;
}

function yearsFromToday(isoDate: string, today: Date): number {
  const [y] = isoDate.split('-').map(Number);
  return y - today.getFullYear();
}

function scoreCandidate(
  isoDate: string,
  opts: { hasMarker: boolean; markerDistance: number; unambiguousFormat: boolean; ambiguous: boolean; today: Date }
): { confidence: OcrConfidence; rank: number } {
  const yearsOff = Math.abs(yearsFromToday(isoDate, opts.today));
  let rank = 0;
  if (opts.hasMarker) rank += 40;
  rank += Math.max(0, 25 - Math.min(opts.markerDistance, 40));
  if (opts.unambiguousFormat) rank += 20;
  if (opts.ambiguous) rank -= 15;
  if (yearsOff <= 3) rank += 15;
  else if (yearsOff <= 5) rank += 5;
  else rank -= 20;

  let confidence: OcrConfidence = 'low';
  if (rank >= 60 && !opts.ambiguous) confidence = 'high';
  else if (rank >= 35) confidence = 'medium';
  return { confidence, rank };
}

function nearestMarkerDistance(text: string, matchIndex: number): { distance: number; hasMarker: boolean } {
  let best = Number.POSITIVE_INFINITY;
  for (const m of text.matchAll(MARKER_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    // Prefer dates that appear after the marker.
    if (matchIndex >= end) best = Math.min(best, matchIndex - end);
    else best = Math.min(best, end - matchIndex);
  }
  if (!Number.isFinite(best)) return { distance: 99, hasMarker: false };
  return { distance: best, hasMarker: true };
}

interface Hit {
  isoDate: string;
  raw: string;
  index: number;
  unambiguousFormat: boolean;
  ambiguousPair?: string;
}

function pushHit(hits: Hit[], hit: Hit): void {
  if (!hit.isoDate) return;
  hits.push(hit);
}

/**
 * Collects calendar dates from normalized OCR text. Ambiguous numeric triples produce two hits
 * that share `ambiguousPair` so the UI can ask the user to choose.
 */
export function extractExpiryCandidates(rawText: string, today: Date = new Date()): ExpiryDateCandidate[] {
  const text = normalizeOcrText(rawText);
  if (!text) return [];

  const hits: Hit[] = [];
  const nowYear = today.getFullYear();

  // ISO-like: 2026-10-31 / 2026/10/31
  for (const m of text.matchAll(/\b((?:19|20)\d{2})([\/\-.])(\d{1,2})\2(\d{1,2})\b/g)) {
    const y = Number(m[1]);
    const mo = Number(m[3]);
    const d = Number(m[4]);
    const date = iso(y, mo, d);
    if (date) pushHit(hits, { isoDate: date, raw: m[0], index: m.index ?? 0, unambiguousFormat: true });
  }

  // Month name: 31 OCT 2026 / OCT 31 2026 / 31 OCTOBER 2026
  for (const m of text.matchAll(
    /\b(\d{1,2})\s+([A-Z]{3,9})\.?\s+((?:19|20)\d{2}|\d{2})\b|\b([A-Z]{3,9})\.?\s+(\d{1,2})\s+((?:19|20)\d{2}|\d{2})\b/g
  )) {
    let day: number;
    let monthName: string;
    let yearRaw: number;
    if (m[1]) {
      day = Number(m[1]);
      monthName = m[2];
      yearRaw = Number(m[3]);
    } else {
      monthName = m[4];
      day = Number(m[5]);
      yearRaw = Number(m[6]);
    }
    const mo = MONTHS[monthName];
    if (!mo) continue;
    const y = expandYear(yearRaw, nowYear);
    const date = iso(y, mo, day);
    if (date) pushHit(hits, { isoDate: date, raw: m[0], index: m.index ?? 0, unambiguousFormat: true });
  }

  // Numeric D/M/Y or M/D/Y with separators
  for (const m of text.matchAll(/\b(\d{1,2})([\/\-.])(\d{1,2})\2((?:19|20)\d{2}|\d{2})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const y = expandYear(Number(m[4]), nowYear);
    const asDmy = iso(y, b, a);
    const asMdy = iso(y, a, b);
    const index = m.index ?? 0;
    if (asDmy && asMdy && asDmy !== asMdy) {
      pushHit(hits, {
        isoDate: asDmy,
        raw: m[0],
        index,
        unambiguousFormat: false,
        ambiguousPair: asMdy,
      });
      pushHit(hits, {
        isoDate: asMdy,
        raw: m[0],
        index,
        unambiguousFormat: false,
        ambiguousPair: asDmy,
      });
    } else if (asDmy && !asMdy) {
      pushHit(hits, { isoDate: asDmy, raw: m[0], index, unambiguousFormat: true });
    } else if (asMdy && !asDmy) {
      pushHit(hits, { isoDate: asMdy, raw: m[0], index, unambiguousFormat: true });
    } else if (asDmy && asMdy && asDmy === asMdy) {
      pushHit(hits, { isoDate: asDmy, raw: m[0], index, unambiguousFormat: true });
    }
  }

  // Month/year only → last day of that month (common on packs)
  for (const m of text.matchAll(/\b(\d{1,2})([\/\-.])((?:19|20)\d{2}|\d{2})\b/g)) {
    // Skip if this looks like it was already part of a full D/M/Y (digit before separator group)
    const before = text.slice(Math.max(0, (m.index ?? 0) - 3), m.index ?? 0);
    if (/\d[\/\-.]$/.test(before) || /\d$/.test(before.trimEnd())) continue;
    const mo = Number(m[1]);
    const y = expandYear(Number(m[3]), nowYear);
    const date = lastDayOfMonth(y, mo);
    if (date) {
      pushHit(hits, { isoDate: date, raw: m[0], index: m.index ?? 0, unambiguousFormat: true });
    }
  }

  const todayIso = toLocalISODate(today);
  const scored = hits
    .filter((h) => {
      const yearsOff = Math.abs(yearsFromToday(h.isoDate, today));
      return yearsOff <= 8;
    })
    .map((h) => {
      const { distance, hasMarker } = nearestMarkerDistance(text, h.index);
      const ambiguous = Boolean(h.ambiguousPair);
      const { confidence, rank } = scoreCandidate(h.isoDate, {
        hasMarker,
        markerDistance: distance,
        unambiguousFormat: h.unambiguousFormat,
        ambiguous,
        today,
      });
      // Prefer dates that are not long past relative to today when ranks tie.
      const pastPenalty = h.isoDate < todayIso ? 5 : 0;
      return {
        isoDate: h.isoDate,
        confidence,
        ambiguous,
        raw: h.raw,
        markerDistance: distance,
        rank: rank - pastPenalty,
      };
    });

  scored.sort((a, b) => b.rank - a.rank || a.isoDate.localeCompare(b.isoDate));

  // Dedupe by isoDate, keep best rank
  const seen = new Set<string>();
  const out: ExpiryDateCandidate[] = [];
  for (const c of scored) {
    if (seen.has(c.isoDate)) continue;
    seen.add(c.isoDate);
    out.push({
      isoDate: c.isoDate,
      confidence: c.confidence,
      ambiguous: c.ambiguous,
      raw: c.raw,
      markerDistance: c.markerDistance,
    });
  }
  return out;
}

export type ExpiryOcrDecision =
  | { kind: 'suggest'; isoDate: string; confidence: OcrConfidence }
  | { kind: 'pick'; candidates: ExpiryDateCandidate[] }
  | { kind: 'none' };

/**
 * Decides whether to auto-fill, ask the user to pick, or report no usable date.
 * Ambiguous pairs and multiple strong candidates never auto-fill.
 */
export function decideExpirySuggestion(candidates: ExpiryDateCandidate[]): ExpiryOcrDecision {
  if (candidates.length === 0) return { kind: 'none' };

  const top = candidates[0];
  const ambiguousGroup = candidates.filter((c) => c.ambiguous && c.raw === top.raw);
  if (top.ambiguous && ambiguousGroup.length >= 2) {
    return { kind: 'pick', candidates: ambiguousGroup.slice(0, 4) };
  }

  const strong = candidates.filter((c) => c.confidence === 'high' || c.confidence === 'medium');
  if (strong.length > 1 && strong[0].isoDate !== strong[1].isoDate) {
    // Several plausible dates — let the person choose among the best few.
    return { kind: 'pick', candidates: strong.slice(0, 4) };
  }

  if (top.confidence === 'high' || top.confidence === 'medium') {
    return { kind: 'suggest', isoDate: top.isoDate, confidence: top.confidence };
  }

  if (candidates.length > 1) return { kind: 'pick', candidates: candidates.slice(0, 4) };
  return { kind: 'none' };
}
